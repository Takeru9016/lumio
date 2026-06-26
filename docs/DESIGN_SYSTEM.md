# DESIGN_SYSTEM.md — Lumio Structured Light

> Drop the globals.css block into src/app/globals.css as the starting point.
> All design decisions are locked. Do not introduce new colour tokens.

---

## Philosophy

**Structured Light** — white-first, information-dense, high signal-to-noise.

- White and near-white surfaces dominate. No full-page dark backgrounds.
- AI features: exclusively purple (`#7C3AED`) with ✦ glyph. Never silent.
- Gamification (streak, XP): present but subtle. Not Duolingo-loud.
- Skeletons match the exact shape of real content. No centre-spinners.

---

## globals.css (full Tailwind v4 @theme block)

```css
@import "tailwindcss";

@theme {
  /* === Brand === */
  --color-brand: #4f6ef7;
  --color-brand-light: #eef1fe;
  --color-brand-dark: #3451d1;

  /* === AI — reserved for AI surfaces only === */
  --color-ai: #7c3aed;
  --color-ai-bg: #f5f3ff;
  --color-ai-border: #ddd6fe;

  /* === Surfaces === */
  --color-surface-1: #ffffff;
  --color-surface-2: #fafafa;
  --color-surface-3: #f5f5f6;

  /* === Text === */
  --color-text-primary: #0f0f10;
  --color-text-secondary: #3d3d3f;
  --color-text-muted: #737380;
  --color-text-disabled: #a8a8b0;

  /* === Borders === */
  --color-border: #e5e5e7;
  --color-border-strong: #d0d0d3;

  /* === Semantic === */
  --color-success: #16a34a;
  --color-success-bg: #f0fdf4;
  --color-warning: #d97706;
  --color-warning-bg: #fffbeb;
  --color-danger: #dc2626;
  --color-danger-bg: #fef2f2;
  --color-info: #0284c7;
  --color-info-bg: #f0f9ff;

  /* === Typography === */
  --font-heading: var(--font-space-grotesk), system-ui, sans-serif;
  --font-body: var(--font-geist), system-ui, sans-serif;
  --font-mono: var(--font-ibm-plex-mono), "Courier New", monospace;

  /* === Spacing & Radius === */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* === Shadows === */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md:
    0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05);
  --shadow-lg:
    0 10px 15px -3px rgb(0 0 0 / 0.07), 0 4px 6px -4px rgb(0 0 0 / 0.05);
}

/* === Base === */
* {
  box-sizing: border-box;
}

body {
  font-family: var(--font-body);
  color: var(--color-text-primary);
  background: var(--color-surface-1);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  font-family: var(--font-heading);
  letter-spacing: -0.02em;
  line-height: 1.2;
}

code,
pre,
.font-mono {
  font-family: var(--font-mono);
}

/* === White-label tenant override (injected per tenant) === */
/* :root[data-tenant="acme"] {
  --color-brand: #1E8A4C;
  --color-brand-light: #E8F5EE;
  --color-brand-dark: #14603A;
} */
```

---

## Font Setup (src/app/layout.tsx)

```typescript
import { Space_Grotesk, Geist, IBM_Plex_Mono } from "next/font/google";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["400", "500"],
});

// Apply to <html>:
// className={`${spaceGrotesk.variable} ${geist.variable} ${ibmPlexMono.variable}`}
```

---

## Component Patterns

### AiBadge (src/components/shared/AiBadge.tsx)

```tsx
// Use on EVERY AI surface. Never render AI content without this badge.
export function AiBadge({ label = "AI" }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-(--color-ai-bg) 
                     px-2 py-0.5 text-[11px] font-semibold text-(--color-ai)"
    >
      ✦ {label}
    </span>
  );
}
```

### Button variants

```tsx
// Primary
<button className="bg-(--color-brand) text-white rounded-md
                   px-4 py-2 text-sm font-medium hover:bg-(--color-brand-dark)
                   transition-colors">
  Enroll Now
</button>

// Secondary
<button className="bg-white text-(--color-text-primary) border border-(--color-border)
                   rounded-md px-4 py-2 text-sm font-medium
                   hover:bg-(--color-surface-2) transition-colors">
  Preview
</button>

// AI action (purple)
<button className="bg-(--color-ai) text-white rounded-md
                   px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity">
  ✦ Generate Quiz
</button>

// Danger
<button className="bg-(--color-danger) text-white rounded-md
                   px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity">
  Cancel Plan
</button>

// Ghost
<button className="text-(--color-text-muted) rounded-md
                   px-4 py-2 text-sm font-medium hover:bg-(--color-surface-2) transition-colors">
  Skip
</button>
```

### Card

```tsx
<div
  className="bg-white border border-(--color-border) 
                rounded-lg p-4 shadow-(--shadow-sm)"
>
  {children}
</div>
```

### AI feature card

```tsx
<div
  className="bg-(--color-ai-bg) border border-(--color-ai-border) 
                rounded-lg p-4 flex items-center gap-3"
>
  <span className="text-xl">✦</span>
  <div>
    <p className="text-sm font-semibold text-(--color-ai)">
      AI Learning Path updated
    </p>
    <p className="text-xs text-(--color-text-muted)">
      3 new lessons recommended
    </p>
  </div>
</div>
```

### Progress bar

```tsx
<div className="h-1.5 rounded-full bg-(--color-surface-3)">
  <div
    className="h-full rounded-full bg-(--color-brand) transition-all"
    style={{ width: `${progress}%` }}
  />
</div>
```

### Badge variants

```tsx
// Use for status indicators
const badgeStyles = {
  published: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
  draft: "bg-[var(--color-surface-3)] text-[var(--color-text-muted)]",
  pending: "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
  overdue: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
  completed: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
  ai: "bg-[var(--color-ai-bg)] text-[var(--color-ai)]",
};

<span
  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeStyles[status]}`}
>
  {status === "ai" && "✦ "}
  {label}
</span>;
```

### Form input

```tsx
<div>
  <label className="block text-sm font-medium text-(--color-text-primary) mb-1.5">
    Email address
  </label>
  <input
    className="w-full rounded-md border border-(--color-border) 
               bg-white px-3 py-2 text-sm text-(--color-text-primary) 
               placeholder:text-(--color-text-disabled)
               focus:outline-none focus:ring-2 focus:ring-(--color-brand) 
               focus:border-transparent transition-all"
    type="email"
    placeholder="you@company.com"
  />
  {/* Error state: add border-[var(--color-danger)] focus:ring-[var(--color-danger)] */}
</div>
```

### Skeleton (shape-matched — no generic spinner)

```tsx
// Always match the shape of the real component
export function CourseCardSkeleton() {
  return (
    <div className="bg-white border border-(--color-border) rounded-lg overflow-hidden animate-pulse">
      <div className="h-40 bg-(--color-surface-3)" />
      <div className="p-4 space-y-2">
        <div className="h-4 bg-(--color-surface-3) rounded w-3/4" />
        <div className="h-3 bg-(--color-surface-3) rounded w-1/2" />
        <div className="h-1.5 bg-(--color-surface-3) rounded-full w-full mt-3" />
      </div>
    </div>
  );
}
```

### Empty state (always has CTA)

```tsx
<div className="flex flex-col items-center justify-center py-16 text-center">
  <div className="text-4xl mb-3">📚</div>
  <h3 className="text-base font-semibold text-(--color-text-primary) mb-1">
    No courses yet
  </h3>
  <p className="text-sm text-(--color-text-muted) mb-4">
    Start creating your first course to share your knowledge.
  </p>
  <button className="bg-(--color-brand) text-white rounded-md px-4 py-2 text-sm font-medium">
    Create your first course →
  </button>
</div>
```

---

## Layout Shell

### Sidebar dimensions

```
Expanded:  240px width
Collapsed: 64px width (icon only, transition on toggle)
Mobile:    Sheet component (full-height overlay)
```

### Active sidebar item

```tsx
<div
  className="flex items-center gap-3 px-3 py-2 rounded-md 
                bg-(--color-brand-light) text-(--color-brand) font-medium
                border-l-2 border-(--color-brand)"
>
  <Icon size={16} />
  <span className="text-sm">Dashboard</span>
</div>
```

### Top nav height: 52px

### Content max-width: 1280px, padding: 24px

### Page header pattern: title (Space Grotesk 600, 22px) + subtitle (Geist, 14px, muted) + right-side CTA

---

## Motion Usage Patterns

```tsx
// Page enter animation (apply to main content wrapper)
import { motion } from "motion/react";

<motion.div
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.2, ease: "easeOut" }}
>
  {children}
</motion.div>

// Card hover (subtle lift)
<motion.div
  whileHover={{ y: -2, boxShadow: "var(--shadow-md)" }}
  transition={{ duration: 0.15 }}
>
  <CourseCard />
</motion.div>

// AI badge entrance (draws attention without being annoying)
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ delay: 0.1, duration: 0.2 }}
>
  <AiBadge />
</motion.div>

// Stagger children (e.g. lesson list, course grid)
<motion.div
  variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}
  initial="hidden"
  animate="visible"
>
  {items.map(item => (
    <motion.div
      key={item.id}
      variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}
    >
      <LessonItem {...item} />
    </motion.div>
  ))}
</motion.div>
```

---

## White-Label CSS Injection

```typescript
// In src/app/(org)/layout.tsx
// Inject per-tenant brand variables server-side
const tenant = await db.tenant.findUnique({ where: { id: tenantId } });

// In the returned JSX:
<html data-tenant={tenant.id} lang="en">
  <head>
    {tenant.brandColor && (
      <style>{`
        :root[data-tenant="${tenant.id}"] {
          --color-brand: ${tenant.brandColor};
          --color-brand-light: ${hexToLight(tenant.brandColor)};
          --color-brand-dark: ${hexToDark(tenant.brandColor)};
        }
      `}</style>
    )}
  </head>
  ...
</html>
```

---

## Responsive Breakpoints

```
Mobile:  < 768px   — sidebar replaced by bottom sheet
Tablet:  768–1024px — sidebar collapsed (icon only) by default
Desktop: > 1024px  — sidebar expanded by default
```

All layouts are mobile-first. Never hide critical functionality on mobile — move it, don't remove it.
