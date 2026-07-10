"use client";

import { useAuth, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function SignUpPage() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ticket = searchParams.get("__clerk_ticket");

  const [ticketState, setTicketState] = useState<"idle" | "accepting" | "accepted" | "error">(
    ticket ? "accepting" : "idle"
  );
  const [invitePassword, setInvitePassword] = useState("");
  const ticketAttempted = useRef(false);

  // Invited instructors/students land here via the emailed invite link, which Clerk
  // decorates with a `__clerk_ticket`. Accepting it (not the manual form below) is how
  // they join — role + org come from the Invitation row via the webhook, not this page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: finalizeIfComplete is recreated every render — the ticketAttempted ref guard, not this dependency list, is what keeps this effect a one-shot.
  useEffect(() => {
    if (!ticket || ticketAttempted.current) return;
    ticketAttempted.current = true;
    void signUp.ticket({ ticket }).then(async ({ error }) => {
      if (error) {
        setTicketState("error");
        return;
      }
      // If this Clerk instance doesn't require a password, the ticket alone can
      // complete the sign-up — finalize immediately or the completed sign-up never
      // becomes an active session (the top-level `status === "complete"` check below
      // would otherwise just render null forever).
      await finalizeIfComplete();
      setTicketState("accepted");
    });
  }, [ticket, signUp]);

  const handleSignUp = async (formData: FormData) => {
    const { error } = await signUp.password({
      emailAddress: formData.get("email") as string,
      password: formData.get("password") as string,
      firstName: formData.get("firstName") as string,
      lastName: formData.get("lastName") as string,
      unsafeMetadata: {
        role: "ORG_ADMIN",
        orgName: formData.get("orgName") as string,
      },
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
    await finalizeIfComplete();
  };

  const handleCompleteInvite = async (formData: FormData) => {
    await signUp.password({
      password: formData.get("password") as string,
      firstName: formData.get("firstName") as string,
      lastName: formData.get("lastName") as string,
    });
    await finalizeIfComplete();
  };

  async function finalizeIfComplete() {
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
  }

  const isLoading = fetchStatus === "fetching";

  if (signUp.status === "complete" || isSignedIn) {
    return null;
  }

  // --- Invitation (ticket) flow ---
  if (ticket) {
    if (ticketState === "accepting") {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
          <p className="text-sm text-text-muted">Accepting your invitation…</p>
        </div>
      );
    }

    if (ticketState === "error") {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
          <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8 text-center">
            <h1 className="text-xl font-semibold text-text-primary mb-2">
              This invitation link isn't valid
            </h1>
            <p className="text-sm text-text-muted mb-6">
              It may have expired or already been used. Ask your organization admin to send a new
              invite.
            </p>
            <Link href="/sign-in" className="text-brand hover:text-brand-dark font-medium text-sm">
              Go to sign in
            </Link>
          </div>
        </div>
      );
    }

    const needsPassword = !signUp.hasPassword;
    const needsEmailVerification =
      signUp.status === "missing_requirements" && signUp.unverifiedFields.includes("email_address");

    if (needsPassword) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
          <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
            <div className="mb-8">
              <span className="text-2xl font-bold text-brand tracking-tight">Lumio</span>
              <h1 className="mt-4 text-2xl font-semibold text-text-primary">
                Finish setting up your account
              </h1>
              <p className="mt-1 text-sm text-text-muted">{signUp.emailAddress}</p>
            </div>

            <form action={handleCompleteInvite} className="space-y-4">
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
                </div>
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
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
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
                disabled={isLoading || invitePassword.length === 0}
                className="w-full py-2.5 px-4 rounded-md bg-brand hover:bg-brand-dark text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isLoading ? "Setting up…" : "Continue"}
              </button>
            </form>

            <div id="clerk-captcha" />
          </div>
        </div>
      );
    }

    if (needsEmailVerification) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
          <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
            <h1 className="text-2xl font-semibold text-text-primary mb-2">Check your email</h1>
            <p className="text-sm text-text-muted mb-6">
              We sent a 6-digit code to {signUp.emailAddress}. Enter it below to finish setting up
              your account.
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
          </div>
        </div>
      );
    }

    // Ticket accepted and nothing else outstanding — finalize should already be in
    // flight from the step above; this is just a brief transitional state.
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
        <p className="text-sm text-text-muted">Finishing up…</p>
      </div>
    );
  }

  // --- Self-serve flow — org admins only. Instructors/students join via an emailed
  // invitation link (the ticket flow above); that's how an org admin adds them. ---
  const needsVerification =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

  if (needsVerification) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm bg-surface-1 rounded-xl shadow-(--shadow-lg) p-8">
          <button
            type="button"
            onClick={() => signUp.reset()}
            className="mb-4 text-xs text-text-muted hover:text-text-secondary transition"
          >
            ← Back to sign up
          </button>

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
          <p className="mt-1 text-sm text-text-muted">
            For organizations setting up Lumio for their team. Instructors and students join via an
            invite from their org admin.
          </p>
        </div>

        <form action={handleSignUp} className="space-y-4">
          <div>
            <label
              htmlFor="orgName"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              Organization name
            </label>
            <input
              id="orgName"
              name="orgName"
              type="text"
              required
              maxLength={100}
              className="w-full px-3.5 py-2.5 rounded-md border border-border bg-surface-1 text-text-primary text-sm placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition"
              placeholder="Acme Inc."
            />
          </div>

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
