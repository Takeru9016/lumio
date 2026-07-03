const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface TenantBrand {
  id: string;
  brandColor?: string | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Lighten: move each channel 20% toward white.
function lighten(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * 0.2, g + (255 - g) * 0.2, b + (255 - b) * 0.2);
}

// Darken: scale each channel down 15% toward black.
function darken(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * 0.85, g * 0.85, b * 0.85);
}

/**
 * Builds the per-tenant brand override injected as a <style> tag in the org layout.
 * Returns "" when no brand colour is set, or when the stored value is not a strict
 * 6-digit hex — this guard is mandatory: brandColor flows into dangerouslySetInnerHTML,
 * so an unvalidated value is a stored-CSS-injection vector.
 */
export function getTenantCss(tenant: TenantBrand): string {
  const color = tenant.brandColor;
  if (!color || !HEX_COLOR.test(color)) return "";

  return `[data-tenant="${tenant.id}"] {
  --color-brand: ${color};
  --color-brand-light: ${lighten(color)};
  --color-brand-dark: ${darken(color)};
}`;
}
