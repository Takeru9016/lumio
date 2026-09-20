"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { Role } from "@/types";
import { getActiveHref, ROLE_NAV_ITEMS } from "./navItems";

// Tailwind's `md` breakpoint: the width at which the sidebar replaces this menu.
export const DESKTOP_MEDIA_QUERY = "(min-width: 48rem)";

interface MobileNavProps {
  role: Role;
  defaultOpen?: boolean;
}

/**
 * The sidebar is hidden below `md`, so this is the same item list for narrow
 * screens (Design System: "Mobile: Sheet component"). It reads the very list the
 * sidebar reads, so a screen size can never change what a person can reach.
 */
export function MobileNav({ role, defaultOpen = false }: MobileNavProps) {
  const pathname = usePathname();
  const items = ROLE_NAV_ITEMS[role];
  const activeHref = getActiveHref(items, pathname);
  const [open, setOpen] = useState(defaultOpen);

  // The sheet is hidden from `md` up with CSS alone, which leaves the dialog
  // "open" as far as Radix is concerned: the page behind it stays aria-hidden,
  // inert and scroll-locked with nothing visible to dismiss. Widening the window
  // (a tablet rotation) must therefore close it.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    query.addEventListener("change", closeOnDesktop);
    return () => query.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:hidden"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
      </SheetTrigger>

      <SheetContent>
        <div className="flex h-13 shrink-0 items-center border-b border-border px-4">
          <SheetTitle>Menu</SheetTitle>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const isActive = item.href === activeHref;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <SheetClose asChild>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                        isActive
                          ? "border-l-2 border-brand bg-brand-light font-medium text-brand"
                          : "text-text-secondary hover:bg-surface-2"
                      }`}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </SheetClose>
                </li>
              );
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
