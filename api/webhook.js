// api/webhook.js
import { verifyWebhookSignature } from 'razorpay';
import { admin } from './firebase-admin';

export default async (req, res) => {
  try {
    // 1. Verify webhook signature
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body.toString();
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    const isValid = verifyWebhookSignature(body, signature, secret);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // 2. Parse webhook event
    const event = JSON.parse(body);
    const subscriptionId = event.payload.subscription?.entity?.id;
    const eventType = event.event;

    // 3. Handle different webhook events
    const db = admin.firestore();
    const userRef = db.collection('users').where('subscriptionId', '==', subscriptionId).limit(1);

    switch (eventType) {
      case 'subscription.charged': // Successful renewal
        await userRef.update({
          lastPayment: admin.firestore.FieldValue.serverTimestamp(),
          subscriptionStatus: 'active'
        });
        break;

      case 'subscription.halted': // Payment failed
        await userRef.update({ 
          subscriptionStatus: 'payment_failed',
          failureReason: event.payload.payment?.entity?.error_description || 'Unknown'
        });
        break;

      case 'subscription.cancelled': // User cancelled
        await userRef.update({ 
          subscriptionStatus: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp()
        });
        break;

      default:
        console.log('Unhandled event type:', eventType);
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
};