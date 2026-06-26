# STACK.md — Lumio Verified Package Versions

> All versions verified as of June 2026. Run the install commands in order.
> Do not use `npm` or `yarn`. pnpm only.

---

## Node.js Requirement

```bash
# Verify before starting — must be ≥ 20.9
node -v

# Recommended: Node.js 22 LTS
nvm use 22
```

---

## Project Init

```bash
pnpm create next-app@latest lumio \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --no-import-alias    # we set @/ manually in tsconfig

cd lumio
```

> After scaffold: delete `tailwind.config.ts` if created. Config goes in `globals.css`.

---

## Core Dependencies (install together)

```bash
pnpm add \
  @clerk/nextjs \
  @prisma/client \
  motion \
  razorpay \
  @mux/mux-node \
  @mux/mux-player-react \
  @mux/mux-uploader-react \
  ai \
  @ai-sdk/openai \
  resend \
  @uploadthing/react \
  uploadthing \
  @upstash/redis \
  @upstash/ratelimit \
  lucide-react \
  simple-icons \
  zod \
  react-hook-form \
  @hookform/resolvers \
  @tiptap/react \
  @tiptap/starter-kit \
  @tiptap/extension-placeholder \
  @dnd-kit/core \
  @dnd-kit/sortable \
  @dnd-kit/utilities \
  recharts \
  lenis \
  @sentry/nextjs \
  clsx \
  tailwind-merge \
  date-fns \
  nanoid
```

## Dev Dependencies

```bash
pnpm add -D \
  prisma \
  @types/node \
  @types/react \
  @types/react-dom \
  typescript
```

---

## shadcn/ui Setup (after core deps)

```bash
pnpm dlx shadcn@latest init
# Choose: TypeScript, Default style, Slate base color, src/app/globals.css, @/ alias
# Do NOT let shadcn overwrite globals.css — merge manually

# Install components as needed per phase:
pnpm dlx shadcn@latest add button card dialog input label
pnpm dlx shadcn@latest add select textarea badge avatar
pnpm dlx shadcn@latest add dropdown-menu sheet tabs progress
pnpm dlx shadcn@latest add toast sonner skeleton separator
```

---

## Verified Package Versions (June 2026)

| Package                 | Version    | Notes                                                    |
| ----------------------- | ---------- | -------------------------------------------------------- |
| `next`                  | `^16.2.7`  | Node ≥ 20.9 required. Turbopack default.                 |
| `react` / `react-dom`   | `^19.2.0`  | Bundled with Next 16.                                    |
| `typescript`            | `^5.1+`    | Minimum for Next 16.                                     |
| `tailwindcss`           | `^4.3.1`   | **No `tailwind.config.ts`.** Config in `globals.css`.    |
| `@tailwindcss/postcss`  | `^4.x`     | PostCSS plugin for v4.                                   |
| `@clerk/nextjs`         | `^7.5.7`   | `auth()` async. Middleware at `src/proxy.ts`.            |
| `prisma` (dev)          | `^7.x`     | Requires `prisma.config.ts` at root.                     |
| `@prisma/client`        | `^7.x`     | Rust-free. 90% smaller bundles.                          |
| `motion`                | `^12.41.0` | Import from `"motion/react"`. NOT `framer-motion`.       |
| `razorpay`              | `^2.9.x`   | Server only. Client uses CDN `checkout.js`.              |
| `@mux/mux-node`         | `^14.1.1`  | New client init: `new Mux({ tokenId, tokenSecret })`.    |
| `@mux/mux-player-react` | `^3.x`     | React player component.                                  |
| `ai`                    | `^6.x`     | `UIMessage` and `ModelMessage` are separate types in v6. |
| `@ai-sdk/openai`        | `^1.x`     | Provider for OpenAI via Vercel AI SDK.                   |
| `resend`                | `^4.x`     | Stable. API unchanged.                                   |
| `uploadthing`           | `^7.x`     | Route handler pattern changed in v7. See API.md.         |
| `@upstash/redis`        | `^1.x`     | Stable.                                                  |
| `@upstash/ratelimit`    | `^2.x`     | Stable.                                                  |
| `zod`                   | `^3.x`     | Import from `"zod"` (v3 stable).                         |

---

## Critical Config Files

### postcss.config.mjs

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

### next.config.ts

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.mux.com" },
      { protocol: "https", hostname: "stream.mux.com" },
      { protocol: "https", hostname: "uploadthing.com" },
      { protocol: "https", hostname: "utfs.io" },
    ],
  },
};

export default nextConfig;
```

### prisma.config.ts (root level)

```typescript
import { defineConfig } from "prisma/config";
import "dotenv/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
```

### tsconfig.json (key parts)

```json
{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

### src/lib/db.ts

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

### src/lib/razorpay.ts

```typescript
import Razorpay from "razorpay";

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});
```

### src/lib/ai/openai.ts

```typescript
import { createOpenAI } from "@ai-sdk/openai";

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Models in use:
// openai("gpt-4o")        — quiz generation, learning path (complex reasoning)
// openai("gpt-4o-mini")   — tutor chat, lesson summary (cost-efficient streaming)
// openai("text-embedding-3-small") — embeddings for pgvector
```

### src/lib/ratelimit.ts

```typescript
import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis";

export const tutorRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "lumio:ai:tutor",
});

export const quizRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "lumio:ai:quiz",
});

export const pathRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(2, "1 m"),
  prefix: "lumio:ai:path",
});
```

---

## Motion Import Reference

```typescript
// ✅ In Client Components:
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
} from "motion/react";

// ✅ In Server Component files (when needed):
import * as motion from "motion/react-client";

// ❌ NEVER:
import { motion } from "framer-motion";
```

---

## Razorpay Checkout Pattern (client-side)

```typescript
// src/hooks/useRazorpay.ts
export function useRazorpay() {
  const loadCheckout = () => {
    return new Promise<void>((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve();
      document.body.appendChild(script);
    });
  };
  // returns loadCheckout + openCheckout helper
}
```

## AI Route Pattern (must follow for all /api/ai/\* routes)

```typescript
// Every AI route follows this exact order:
// 1. Auth check
// 2. Rate limit check (Upstash)
// 3. Plan quota check (DB)
// 4. Call LLM
// 5. Increment usage counter
// 6. Return response

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { success } = await tutorRatelimit.limit(userId);
  if (!success) return new Response("Rate limit exceeded", { status: 429 });

  const user = await db.user.findUnique({ where: { clerkId: userId } });
  if (!user) return new Response("User not found", { status: 404 });

  const limit = PLAN_LIMITS[user.plan].aiCallsPerMonth;
  if (user.aiCallsUsed >= limit) {
    return Response.json(
      { error: "AI quota exceeded", upgradeRequired: true },
      { status: 403 },
    );
  }

  // ... LLM call here ...

  await db.user.update({
    where: { clerkId: userId },
    data: { aiCallsUsed: { increment: 1 } },
  });
}
```
