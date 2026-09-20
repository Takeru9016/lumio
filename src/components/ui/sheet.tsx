"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={`text-base font-semibold text-text-primary ${className ?? ""}`}
      {...props}
    />
  );
}

/**
 * A full-height panel from the left edge. It is deliberately not portalled:
 * the per-tenant brand variables are scoped to a wrapper element, and a portal
 * to <body> would render the sheet outside them and lose the organisation's
 * brand colour. Radix still traps focus, restores it on close and handles Escape.
 */
function SheetContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface-1 shadow-lg outline-none md:hidden ${className ?? ""}`}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
          <X size={18} aria-hidden="true" />
          <span className="sr-only">Close navigation menu</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </>
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle };
