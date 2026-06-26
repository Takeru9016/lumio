# /check

Run the following checks in order. Report any failures before committing.

1. **TypeScript**: Run `npx tsc --noEmit`
   - Must show 0 errors. Fix all before proceeding.

2. **Build check**: Run `pnpm build`
   - Must complete without errors.
   - If build fails, fix errors before committing.

3. **Import audit**:
   - Search for `from "framer-motion"` → must be 0 results
   - Search for `from "stripe"` or `import Stripe` → must be 0 results
   - Search for `"use client"` on server-only files → flag any unexpected ones

4. **Config audit**:
   - `tailwind.config.ts` must NOT exist
   - `middleware.ts` must NOT exist (only `src/proxy.ts`)

5. **Security audit**:
   - No `console.log` in API routes or lib files
   - No hardcoded API keys or secrets
   - Every `/api/ai/*` route has rate limiting and quota check at the top
   - Every `/api/webhooks/*` route verifies signature before processing

6. **AI surface audit**:
   - Every component that shows AI-generated content has AiBadge rendered
   - No AI feature renders silently without the ✦ indicator

Report: "✅ All checks passed" or list every failure with file + line number.
Only proceed to /commit if all checks pass.
