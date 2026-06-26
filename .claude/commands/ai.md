# /ai

Lumio-specific AI feature audit. Run this before committing any Phase 4+ task.

1. **Rate limiting check**:
   List all files in src/app/api/ai/.
   Verify each imports from "@/lib/ratelimit" and calls the limiter as the FIRST operation after auth.
   Flag any route where rate limit is not the first check.

2. **Quota check**:
   Verify each AI route calls checkAndIncrementQuota() (or withAiGuards()).
   Verify it returns a 403 with { error, upgradeRequired: true } when over limit.
   Flag any route that calls the LLM without checking quota.

3. **AI surface indicator audit**:
   Search for components that render AI-generated content.
   Verify each one:
   - Imports and renders <AiBadge /> from "@/components/shared/AiBadge"
   - Uses var(--color-ai) or var(--color-ai-bg) for styling
   - Shows the ✦ glyph in the UI
     Flag any AI surface without the badge.

4. **Webhook signature verification**:
   Check /api/webhooks/razorpay — verify HMAC check runs before any DB write.
   Check /api/webhooks/mux — verify signature check runs first.
   Flag any webhook that processes the body before verifying.

5. **Model usage audit**:
   List all LLM calls in the codebase with the model used.
   Flag if expensive model (gpt-4o) is used where gpt-4o-mini would be appropriate.
   Reminder: gpt-4o-mini for streaming/summary, gpt-4o for structured output/quiz/path.

Report: "✅ AI audit passed" or list every issue with exact file + line.
