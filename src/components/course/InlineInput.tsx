"use client";

import { Check, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

interface InlineInputProps {
  placeholder: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  defaultValue?: string;
  confirmLabel?: string;
}

export function InlineInput({
  placeholder,
  onConfirm,
  onCancel,
  autoFocus = true,
  defaultValue = "",
  confirmLabel = "Add",
}: InlineInputProps) {
  const [value, setValue] = useState(defaultValue);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function handleConfirm() {
    if (!value.trim()) {
      setShake(true);
      return;
    }
    onConfirm(value.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirm();
    if (e.key === "Escape") onCancel();
  }

  return (
    <div className="space-y-1.5 p-1">
      <motion.input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        animate={shake ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.3 }}
        onAnimationComplete={() => setShake(false)}
        className="w-full rounded-md border border-border bg-white px-3 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleConfirm}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-brand text-white rounded-md hover:bg-brand-dark transition-colors"
        >
          <Check size={10} />
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-3 rounded-md transition-colors"
        >
          <X size={10} />
          Cancel
        </button>
      </div>
    </div>
  );
}
