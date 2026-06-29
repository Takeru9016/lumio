"use client";

import { toast } from "gooey-toast";
import { motion, AnimatePresence } from "motion/react";

interface XpToastProps {
  amount: number;
  visible: boolean;
}

export function XpToast({ amount, visible }: XpToastProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="font-semibold tabular-nums"
          style={{ color: "#16a34a" }}
        >
          +{amount} XP
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function showXpToast(amount: number) {
  toast.show({
    title: `+${amount} XP`,
    icon: "✦",
    duration: 2000,
    fill: "#16a34a",
  });
}
