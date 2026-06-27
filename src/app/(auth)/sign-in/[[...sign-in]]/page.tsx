"use client";

import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

export default function SignInPage() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const [needsMFA, setNeedsMFA] = useState(false);
  const router = useRouter();

  const handleSignIn = async (formData: FormData) => {
    const identifier = formData.get("email") as string;
    const password = formData.get("password") as string;

    await signIn.password({ identifier, password });

    if (signIn.status === "needs_second_factor") {
      await signIn.mfa.sendEmailCode();
      setNeedsMFA(true);
      return;
    }

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) return;
          const url = decorateUrl("/dashboard");
          if (url.startsWith("http")) {
            window.location.href = url;
          } else {
            router.push(url);
          }
        },
      });
    }
  };

  const handleMFA = async (formData: FormData) => {
    const code = formData.get("code") as string;
    await signIn.mfa.verifyEmailCode({ code });

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) return;
          const url = decorateUrl("/dashboard");
          if (url.startsWith("http")) {
            window.location.href = url;
          } else {
            router.push(url);
          }
        },
      });
    }
  };

  const isLoading = fetchStatus === "fetching";

  if (needsMFA) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-surface-2)] px-4">
        <div className="w-full max-w-sm bg-[var(--color-surface-1)] rounded-[var(--radius-xl)] shadow-[var(--shadow-lg)] p-8">
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] mb-2">
            Verify your identity
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            Enter the code sent to your email address.
          </p>

          <form action={handleMFA} className="space-y-4">
            <div>
              <label
                htmlFor="code"
                className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5"
              >
                Verification code
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                className="w-full px-3.5 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] focus:border-transparent transition"
                placeholder="123456"
              />
              {errors?.fields?.code && (
                <p className="mt-1.5 text-xs text-[var(--color-danger)]">
                  {errors.fields.code.message}
                </p>
              )}
            </div>

            {errors?.global && errors.global.length > 0 && (
              <p className="text-xs text-[var(--color-danger)]">
                {errors.global[0].message}
              </p>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-[var(--radius-md)] bg-[var(--color-brand)] hover:bg-[var(--color-brand-dark)] text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? "Verifying…" : "Verify"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => setNeedsMFA(false)}
            className="mt-4 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-surface-2)] px-4">
      <div className="w-full max-w-sm bg-[var(--color-surface-1)] rounded-[var(--radius-xl)] shadow-[var(--shadow-lg)] p-8">
        <div className="mb-8">
          <span className="text-2xl font-bold text-[var(--color-brand)] tracking-tight">
            Lumio
          </span>
          <h1 className="mt-4 text-2xl font-semibold text-[var(--color-text-primary)]">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Sign in to continue learning.
          </p>
        </div>

        <form action={handleSignIn} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full px-3.5 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] focus:border-transparent transition"
              placeholder="you@example.com"
            />
            {errors?.fields?.identifier && (
              <p className="mt-1.5 text-xs text-[var(--color-danger)]">
                {errors.fields.identifier.message}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="password"
                className="text-sm font-medium text-[var(--color-text-secondary)]"
              >
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs text-[var(--color-brand)] hover:text-[var(--color-brand-dark)] transition"
              >
                Forgot password?
              </Link>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full px-3.5 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] focus:border-transparent transition"
              placeholder="••••••••"
            />
            {errors?.fields?.password && (
              <p className="mt-1.5 text-xs text-[var(--color-danger)]">
                {errors.fields.password.message}
              </p>
            )}
          </div>

          {errors?.global && errors.global.length > 0 && (
            <p className="text-xs text-[var(--color-danger)]">
              {errors.global[0].message}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-[var(--radius-md)] bg-[var(--color-brand)] hover:bg-[var(--color-brand-dark)] text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-text-muted)]">
          Don&apos;t have an account?{" "}
          <Link
            href="/sign-up"
            className="text-[var(--color-brand)] hover:text-[var(--color-brand-dark)] font-medium transition"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
