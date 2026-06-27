import Razorpay from "razorpay";

// Server-only. Never import this file in client components.
// Razorpay plans must be created manually in the Razorpay dashboard
// and their IDs stored as env vars: RAZORPAY_PLAN_STARTER, RAZORPAY_PLAN_PRO, RAZORPAY_PLAN_ENTERPRISE
export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});
