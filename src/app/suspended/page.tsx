import { SignOutButton } from "@clerk/nextjs";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";

export default function SuspendedPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface-1 px-4 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-bg text-danger">
        <ShieldAlert size={28} />
      </span>
      <div className="max-w-md">
        <h1 className="text-2xl font-semibold text-text-primary">
          Your organization's access has been paused
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          A Super Admin has suspended your organization's account. Contact your org admin, or reach
          out to support@lumio.io if you think this is a mistake.
        </p>
      </div>
      <SignOutButton redirectUrl="/">
        <button
          type="button"
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2"
        >
          Sign out
        </button>
      </SignOutButton>
      <Link href="/" className="text-sm text-text-muted hover:text-text-primary">
        Back to lumio.io
      </Link>
    </div>
  );
}
