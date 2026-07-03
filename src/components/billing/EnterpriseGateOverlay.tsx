import { Lock } from "lucide-react";
import Link from "next/link";

interface EnterpriseGateOverlayProps {
  feature: string;
}

/** Non-dismissible overlay for Enterprise-only settings surfaces (SSO, custom domain). */
export function EnterpriseGateOverlay({ feature }: EnterpriseGateOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg bg-surface-1/95 backdrop-blur-sm text-center p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ai-bg text-ai">
        <Lock size={18} />
      </div>
      <div>
        <p className="text-sm font-semibold text-text-primary">Enterprise plan required</p>
        <p className="mt-1 text-xs text-text-muted max-w-xs">
          {feature} is available on the Enterprise plan.
        </p>
      </div>
      <Link
        href="/org/settings/billing"
        className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
      >
        Upgrade to Enterprise
      </Link>
    </div>
  );
}
