import { GraduationCap } from "lucide-react";
import Link from "next/link";

const PRODUCT_LINKS = [
  { href: "/#solutions", label: "Solutions" },
  { href: "/#capabilities", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

const ACCOUNT_LINKS = [
  { href: "/sign-in", label: "Sign in" },
  { href: "/sign-up", label: "Get started" },
];

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-7xl px-4 py-12 md:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-light text-brand">
                <GraduationCap size={16} strokeWidth={2} />
              </span>
              <span className="text-base font-semibold text-text-primary">Lumio</span>
            </div>
            <p className="mt-3 text-sm text-text-muted">Learn with intelligence.</p>
          </div>

          <div className="flex gap-12">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Product</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                {PRODUCT_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-text-muted transition-colors hover:text-text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-text-primary">Account</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                {ACCOUNT_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-text-muted transition-colors hover:text-text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <p className="mt-10 text-xs text-text-disabled">
          &copy; {new Date().getFullYear()} Lumio. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
