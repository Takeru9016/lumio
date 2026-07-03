"use client";

import { useState } from "react";
import type { RazorpayOptions } from "@/types";

export function useRazorpay() {
  const [isLoading, setIsLoading] = useState(false);

  const loadRazorpay = (): Promise<void> => {
    return new Promise((resolve) => {
      if (window.Razorpay) {
        resolve();
        return;
      }

      setIsLoading(true);
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => {
        setIsLoading(false);
        resolve();
      };
      document.body.appendChild(script);
    });
  };

  // Loads checkout.js (if needed) then opens the Razorpay modal.
  const openCheckout = async (options: RazorpayOptions): Promise<void> => {
    await loadRazorpay();
    if (!window.Razorpay) {
      throw new Error("Razorpay checkout failed to load");
    }
    const rzp = new window.Razorpay(options);
    rzp.open();
  };

  return { loadRazorpay, openCheckout, isLoading };
}
