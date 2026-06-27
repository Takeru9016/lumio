"use client";

import { useState } from "react";

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

  return { loadRazorpay, isLoading };
}
