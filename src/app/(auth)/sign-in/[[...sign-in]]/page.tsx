"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";

export default function SignInPage() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const [needsMFA, setNeedsMFA] = useState(false);
  const router = useRouter();

  const handleSignIn = async (formData: FormData) => {
    await signIn.password({
      identifier: formData.get("email") as string,
      password: formData.get("password") as string,
    });

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
    await signIn.mfa.verifyEmailCode({ code: formData.get("code") as string });

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
      <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
          <h1 className="text-2xl font-semibold text-text-primary mb-2">
            Verify your identity
          </h1>
          <p className="text-sm text-text-muted mb-6">
            Enter the code sent to your email address.
          </p>

          <form action={handleMFA} className="space-y-4">
            <div>
              <label
                htmlFor="code"
                className="block text-sm font-medium text-text-secondary mb-1.5"
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
                className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
                placeholder="123456"
              />
              {errors?.fields?.code && (
                <p className="mt-1.5 text-xs text-danger">
                  {errors.fields.code.message}
                </p>
              )}
            </div>

            {errors?.global && errors.global.length > 0 && (
              <p className="text-xs text-danger">{errors.global[0].message}</p>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-md bg-brand hover:bg-brand-dark text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? "Verifying…" : "Verify"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => setNeedsMFA(false)}
            className="mt-4 text-xs text-text-muted hover:text-text-secondary transition"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
      <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
        <div className="mb-8">
          <span className="text-2xl font-bold text-brand tracking-tight">
            Lumio
          </span>
          <h1 className="mt-4 text-2xl font-semibold text-text-primary">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Sign in to continue learning.
          </p>
        </div>

        <form action={handleSignIn} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
              placeholder="you@example.com"
            />
            {errors?.fields?.identifier && (
              <p className="mt-1.5 text-xs text-danger">
                {errors.fields.identifier.message}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="password"
                className="text-sm font-medium text-text-secondary"
              >
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs text-brand hover:text-brand-dark transition"
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
              className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
              placeholder="••••••••"
            />
            {errors?.fields?.password && (
              <p className="mt-1.5 text-xs text-danger">
                {errors.fields.password.message}
              </p>
            )}
          </div>

          {errors?.global && errors.global.length > 0 && (
            <p className="text-xs text-danger">{errors.global[0].message}</p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-md bg-brand hover:bg-brand-dark text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-text-muted">
          Don&apos;t have an account?{" "}
          <Link
            href="/sign-up"
            className="text-brand hover:text-brand-dark font-medium transition"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
