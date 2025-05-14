import { createSubscription, verifyPayment } from './razorpay';

export default async (req, res) => {
  if (req.method === 'POST') {
    // Handle subscription creation
    const result = await createSubscription(req.body);
    return res.status(200).json(result);
  }
  
  return res.status(405).end(); // Method not allowed
};