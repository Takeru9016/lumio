"use client";

import { toast } from "gooey-toast";
import { Bell, LayoutDashboard } from "lucide-react";
import { useState } from "react";

import { AiBadge } from "@/components/shared/AiBadge";
import { UploadButton } from "@/lib/uploadthing";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface BrandingFormProps {
  tenantName: string;
  initialBrandColor: string | null;
  initialLogoUrl: string | null;
}

// Mirror of the light/dark math in getTenantCss, for the live preview only.
function shade(hex: string, factor: number, toward: number): string {
  const clean = hex.slice(1);
  const channels = [0, 2, 4].map((i) => {
    const c = Number.parseInt(clean.slice(i, i + 2), 16);
    const v = Math.round(c + (toward - c) * factor);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

export function BrandingForm({ tenantName, initialBrandColor, initialLogoUrl }: BrandingFormProps) {
  const [brandColor, setBrandColor] = useState(initialBrandColor ?? "#4f6ef7");
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [saving, setSaving] = useState(false);

  const isValidHex = HEX_COLOR.test(brandColor);
  const previewBrand = isValidHex ? brandColor : "#4f6ef7";
  const previewLight = shade(previewBrand, 0.2, 255);
  const previewDark = shade(previewBrand, 0.15, 0);

  async function handleSave() {
    if (!isValidHex) {
      toast.error({
        title: "Invalid colour",
        description: "Enter a 6-digit hex value like #4f6ef7.",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/org/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandColor, logoUrl }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to save branding.");
      }
      toast.success({
        title: "Branding saved",
        description: "Changes apply across your organisation on next page load.",
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

  const labelClass = "block text-sm font-medium text-(--color-text-primary) mb-1.5";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Controls */}
      <div className="space-y-6">
        {/* Logo */}
        <div className="rounded-lg border border-border bg-surface-1 p-5">
          <label className={labelClass}>Organisation logo</label>
          <p className="mb-3 text-xs text-text-muted">
            Replaces the Lumio wordmark. PNG or SVG, max 2MB.
          </p>
          {logoUrl ? (
            <div className="flex items-center gap-4">
              <div className="flex h-14 items-center rounded-md border border-border bg-surface-2 px-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt={`${tenantName} logo`} className="h-7 w-auto" />
              </div>
              <button
                type="button"
                onClick={() => setLogoUrl(null)}
                className="text-sm font-medium text-text-muted hover:text-danger"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-border p-6 text-center">
              <UploadButton
                endpoint="logoUploader"
                onClientUploadComplete={(res) => {
                  if (res[0]) setLogoUrl(res[0].ufsUrl);
                }}
                onUploadError={(e) => {
                  toast.error({ title: "Upload failed", description: e.message });
                }}
                appearance={{
                  button:
                    "bg-[var(--color-brand)] text-white rounded-md px-4 py-2 text-sm font-medium",
                  allowedContent: "text-[var(--color-text-muted)] text-xs mt-1",
                }}
              />
            </div>
          )}
        </div>

        {/* Primary colour */}
        <div className="rounded-lg border border-border bg-surface-1 p-5">
          <label className={labelClass}>Primary colour</label>
          <p className="mb-3 text-xs text-text-muted">
            Applied to buttons, active navigation, and progress bars.
          </p>
          <div className="flex items-center gap-3">
            <input
              type="color"
              aria-label="Pick primary colour"
              value={isValidHex ? brandColor : "#4f6ef7"}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded-md border border-border bg-white p-1"
            />
            <input
              type="text"
              aria-label="Primary colour hex"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder="#4f6ef7"
              spellCheck={false}
              className={`w-40 rounded-md border bg-white px-3 py-2 font-mono text-sm text-(--color-text-primary) focus:outline-none focus:ring-2 ${
                isValidHex
                  ? "border-border focus:ring-(--color-brand)"
                  : "border-danger focus:ring-(--color-danger)"
              }`}
            />
          </div>
          {!isValidHex && (
            <p className="mt-2 text-xs text-danger">Enter a 6-digit hex value, e.g. #4f6ef7.</p>
          )}
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isValidHex}
          className="rounded-md bg-(--color-brand) px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-(--color-brand-dark) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save branding"}
        </button>
      </div>

      {/* Live preview */}
      <div
        className="h-fit rounded-lg border border-border bg-surface-1 p-5"
        style={
          {
            "--color-brand": previewBrand,
            "--color-brand-light": previewLight,
            "--color-brand-dark": previewDark,
          } as React.CSSProperties
        }
      >
        <p className="mb-4 text-xs font-medium text-text-muted">Live preview</p>

        <div className="overflow-hidden rounded-lg border border-border">
          {/* Mini top bar */}
          <div className="flex h-11 items-center justify-between border-b border-border bg-white px-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo preview" className="h-6 w-auto" />
            ) : (
              <span
                className="text-lg font-bold text-(--color-brand)"
                style={{ fontFamily: "var(--font-heading)" }}
              >
                {tenantName || "Lumio"}
              </span>
            )}
            <Bell size={16} className="text-text-muted" />
          </div>

          <div className="flex">
            {/* Mini sidebar */}
            <div className="w-32 shrink-0 space-y-1 border-r border-border bg-white p-2">
              <div className="flex items-center gap-2 rounded-md border-l-2 border-(--color-brand) bg-(--color-brand-light) px-2 py-1.5 text-(--color-brand)">
                <LayoutDashboard size={14} />
                <span className="text-xs font-medium">Dashboard</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-text-muted">
                <span className="text-xs">Courses</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-text-muted">
                <span className="text-xs">Reports</span>
              </div>
            </div>

            {/* Mini content */}
            <div className="flex-1 space-y-3 bg-surface-2 p-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-(--color-brand-light) px-2 py-0.5 text-[11px] font-semibold text-(--color-brand-dark)">
                  Active
                </span>
                <AiBadge label="AI" size="sm" />
              </div>
              <div className="h-1.5 w-full rounded-full bg-surface-3">
                <div className="h-full w-2/3 rounded-full bg-(--color-brand)" />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-(--color-brand) px-3 py-1.5 text-xs font-medium text-white"
                >
                  Primary
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-primary"
                >
                  Secondary
                </button>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs text-text-muted">
          The AI purple (✦) never changes — it is reserved platform-wide.
        </p>
      </div>
    </div>
  );
}
