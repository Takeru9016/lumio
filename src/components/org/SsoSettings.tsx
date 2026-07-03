"use client";

import { toast } from "gooey-toast";
import { CheckCircle2, ExternalLink, MinusCircle } from "lucide-react";
import { useState } from "react";

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

interface SsoSettingsProps {
  initialSamlEnabled: boolean;
  initialSamlMetadataUrl: string | null;
}

export function SsoSettings({ initialSamlEnabled, initialSamlMetadataUrl }: SsoSettingsProps) {
  const [samlEnabled, setSamlEnabled] = useState(initialSamlEnabled);
  const [metadataUrl, setMetadataUrl] = useState(initialSamlMetadataUrl ?? "");
  const [saving, setSaving] = useState(false);

  const trimmedUrl = metadataUrl.trim();
  const urlValid = trimmedUrl === "" ? true : isValidUrl(trimmedUrl);
  const urlRequiredMissing = samlEnabled && trimmedUrl === "";
  const canSave = !saving && urlValid && !urlRequiredMissing;
  const connectionActive = initialSamlEnabled && Boolean(initialSamlMetadataUrl);

  async function handleSave() {
    if (samlEnabled && trimmedUrl === "") {
      toast.error({
        title: "Metadata URL required",
        description: "Enter your IdP metadata URL to enable SSO.",
      });
      return;
    }
    if (trimmedUrl !== "" && !isValidUrl(trimmedUrl)) {
      toast.error({
        title: "Invalid URL",
        description: "Enter a valid IdP metadata URL.",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/org/sso", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samlEnabled,
          samlMetadataUrl: trimmedUrl === "" ? null : trimmedUrl,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to save SSO settings.");
      }
      toast.success({
        title: "SSO settings saved",
        description: samlEnabled
          ? "Members can now sign in through your identity provider."
          : "SSO is disabled for your organisation.",
      });
    } catch (err) {
      toast.error({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Connection status */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-5">
        <div>
          <p className="text-sm font-semibold text-text-primary">Connection status</p>
          <p className="text-xs text-text-muted">
            Reflects the last saved configuration for this organisation.
          </p>
        </div>
        {connectionActive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-3 py-1 text-xs font-semibold text-success">
            <CheckCircle2 size={14} />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1 text-xs font-semibold text-text-muted">
            <MinusCircle size={14} />
            Not configured
          </span>
        )}
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-5">
        <div>
          <p className="text-sm font-semibold text-text-primary">Enable SAML SSO</p>
          <p className="text-xs text-text-muted">
            Require members to authenticate through your identity provider.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={samlEnabled}
          aria-label="Enable SAML SSO"
          onClick={() => setSamlEnabled((v) => !v)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-(--color-brand) ${
            samlEnabled ? "bg-(--color-brand)" : "bg-surface-3"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              samlEnabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Metadata URL */}
      <div className="rounded-lg border border-border bg-surface-1 p-5">
        <label htmlFor="saml-metadata-url" className="block text-sm font-medium text-text-primary">
          IdP metadata URL
        </label>
        <p className="mb-3 text-xs text-text-muted">
          The SAML metadata endpoint from your identity provider (Okta, Azure AD, Google Workspace,
          etc.). Required when SSO is enabled.
        </p>
        <input
          id="saml-metadata-url"
          type="url"
          inputMode="url"
          value={metadataUrl}
          onChange={(e) => setMetadataUrl(e.target.value)}
          placeholder="https://idp.example.com/app/metadata"
          spellCheck={false}
          className={`w-full rounded-md border bg-white px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 ${
            urlValid && !urlRequiredMissing
              ? "border-border focus:ring-(--color-brand)"
              : "border-danger focus:ring-(--color-danger)"
          }`}
        />
        {!urlValid && (
          <p className="mt-2 text-xs text-danger">
            Enter a valid URL, e.g. https://idp.example.com/metadata.
          </p>
        )}
        {urlValid && urlRequiredMissing && (
          <p className="mt-2 text-xs text-danger">A metadata URL is required to enable SSO.</p>
        )}
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave}
        className="rounded-md bg-(--color-brand) px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-(--color-brand-dark) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save SSO settings"}
      </button>

      {/* How it works */}
      <div className="rounded-lg border border-border bg-surface-2 p-5">
        <p className="text-sm font-semibold text-text-primary">How SSO works in Lumio</p>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">
          Clerk owns the SAML connection through Enterprise SSO on your organisation. Lumio stores
          the enable toggle and metadata URL, then defers authentication to Clerk — members signing
          in are routed to your identity provider. Create and verify the SAML connection in your
          Clerk dashboard before enabling it here.
        </p>
        <a
          href="https://clerk.com/docs/authentication/enterprise-connections/overview"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-(--color-brand) hover:text-(--color-brand-dark)"
        >
          Set up SSO in Clerk
          <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}
