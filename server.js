require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Plan ID (from Razorpay Dashboard)
const PRO_PLAN_ID = process.env.RAZORPAY_PLAN_ID;

// ======================
// 1. AUTHENTICATION MIDDLEWARE
// ======================
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ======================
// 2. CREATE SUBSCRIPTION
// ======================
app.post('/create-subscription', authenticate, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Check if user already has an active subscription
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists && userDoc.data().subscriptionStatus === 'active') {
      return res.status(400).json({ error: 'Active subscription exists' });
    }

    // Create Razorpay subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: PRO_PLAN_ID,
      customer_notify: 1,
      total_count: 12, // 1 year (12 months)
      notes: { userId }
    });

    res.json({
      subscriptionId: subscription.id,
      plan: "pro",
      amount: 40000 // ₹400 in paise
    });

  } catch (error) {
    console.error('Subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======================
// 3. VERIFY PAYMENT (SUCCESS)
// ======================
app.post('/verify-payment', authenticate, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
    const userId = req.user.uid;

    // Verify Razorpay signature
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Update Firestore (creates user doc if not exists)
    await db.collection('users').doc(userId).set({
      subscriptionStatus: "active",
      subscriptionId: razorpay_subscription_id,
      subscriptionStart: admin.firestore.FieldValue.serverTimestamp(),
      subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year later
      lastPayment: admin.firestore.FieldValue.serverTimestamp(),
      email: req.user.email || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }); // Preserves existing fields

    res.json({ success: true, message: 'Subscription activated!' });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======================
// 4. WEBHOOKS (RENEWALS/FAILURES)
// ======================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const body = req.body.toString();
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const event = JSON.parse(body);
  const subscriptionId = event.payload.subscription.entity.id;

  try {
    // Find user by subscription ID
    const snapshot = await db.collection('users')
      .where('subscriptionId', '==', subscriptionId)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = snapshot.docs[0].id;
    const userRef = db.collection('users').doc(userId);

    switch (event.event) {
      case 'subscription.charged': // Successful renewal
        await userRef.update({
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          subscriptionStatus: "active"
        });
        break;

      case 'subscription.halted': // Payment failed
        await userRef.update({ subscriptionStatus: "payment_failed" });
        break;

      case 'subscription.cancelled': // User cancelled
        await userRef.update({ subscriptionStatus: "cancelled" });
        break;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======================
// 5. CHECK SUBSCRIPTION STATUS (FOR FRONTEND)
// ======================
app.get('/check-subscription', authenticate, async (req, res) => {
  try {
    const userId = req.user.uid;
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.json({ isActive: false });
    }

    const userData = userDoc.data();
    const isActive = userData.subscriptionStatus === "active" && 
                     new Date(userData.subscriptionEnd.toDate()) > new Date();

    res.json({ isActive });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));