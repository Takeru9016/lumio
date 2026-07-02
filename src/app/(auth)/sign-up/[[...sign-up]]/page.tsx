"use client";

import { useAuth, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SignUpPage() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const handleSignUp = async (formData: FormData) => {
    const { error } = await signUp.password({
      emailAddress: formData.get("email") as string,
      password: formData.get("password") as string,
      firstName: formData.get("firstName") as string,
      lastName: formData.get("lastName") as string,
    });

    // An account already exists for this identifier — hand off to the sign-in flow
    // instead of dead-ending on an error.
    if (signUp.isTransferable) {
      router.push("/sign-in");
      return;
    }

    if (!error) {
      await signUp.verifications.sendEmailCode();
    }
  };

  const handleVerify = async (formData: FormData) => {
    await signUp.verifications.verifyEmailCode({
      code: formData.get("code") as string,
    });

    if (signUp.status === "complete") {
      await signUp.finalize({
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

  if (signUp.status === "complete" || isSignedIn) {
    return null;
  }

  const needsVerification =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

  if (needsVerification) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
          <h1 className="text-2xl font-semibold text-text-primary mb-2">Check your email</h1>
          <p className="text-sm text-text-muted mb-6">
            We sent a 6-digit code to your email. Enter it below to verify your account.
          </p>

          <form action={handleVerify} className="space-y-4">
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
                <p className="mt-1.5 text-xs text-danger">{errors.fields.code.message}</p>
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
              {isLoading ? "Verifying…" : "Verify email"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => signUp.verifications.sendEmailCode()}
            className="mt-4 text-xs text-text-muted hover:text-text-secondary transition"
          >
            Resend code
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
      <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
        <div className="mb-8">
          <span className="text-2xl font-bold text-brand tracking-tight">Lumio</span>
          <h1 className="mt-4 text-2xl font-semibold text-text-primary">Create your account</h1>
          <p className="mt-1 text-sm text-text-muted">Start learning with intelligence.</p>
        </div>

        <form action={handleSignUp} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="firstName"
                className="block text-sm font-medium text-text-secondary mb-1.5"
              >
                First name
              </label>
              <input
                id="firstName"
                name="firstName"
                type="text"
                autoComplete="given-name"
                required
                className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
                placeholder="Jane"
              />
              {errors?.fields?.firstName && (
                <p className="mt-1.5 text-xs text-danger">{errors.fields.firstName.message}</p>
              )}
            </div>
            <div>
              <label
                htmlFor="lastName"
                className="block text-sm font-medium text-text-secondary mb-1.5"
              >
                Last name
              </label>
              <input
                id="lastName"
                name="lastName"
                type="text"
                autoComplete="family-name"
                required
                className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
                placeholder="Doe"
              />
              {errors?.fields?.lastName && (
                <p className="mt-1.5 text-xs text-danger">{errors.fields.lastName.message}</p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-text-secondary mb-1.5">
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
            {errors?.fields?.emailAddress && (
              <p className="mt-1.5 text-xs text-danger">{errors.fields.emailAddress.message}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
              placeholder="Min. 8 characters"
            />
            {errors?.fields?.password && (
              <p className="mt-1.5 text-xs text-danger">{errors.fields.password.message}</p>
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
            {isLoading ? "Creating account…" : "Create account"}
          </button>
        </form>

        {/* Required for Clerk's bot protection */}
        <div id="clerk-captcha" />

        <p className="mt-6 text-center text-sm text-text-muted">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-brand hover:text-brand-dark font-medium transition">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
