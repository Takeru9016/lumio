import type { LucideIcon } from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

export type { Plan, Role } from "@/generated/prisma/enums";

// --- Razorpay client types ---

export type RazorpayOptions = {
  key: string;
  subscription_id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  image?: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: RazorpayResponse) => void;
  modal?: {
    ondismiss?: () => void;
  };
};

export type RazorpayResponse = {
  razorpay_payment_id: string;
  razorpay_subscription_id?: string;
  razorpay_order_id?: string;
  razorpay_signature: string;
};

export type RazorpayInstance = {
  open: () => void;
  close: () => void;
};

declare global {
  interface Window {
    // Optional — populated only after checkout.js CDN script loads
    Razorpay?: new (
      options: RazorpayOptions
    ) => RazorpayInstance;
  }
}
