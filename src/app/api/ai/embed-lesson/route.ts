import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { embedLessonById } from "@/lib/ai/embeddings";

const bodySchema = z.object({
  lessonId: z.string().min(1),
});

/**
 * Internal endpoint to (re)embed a lesson's content into pgvector.
 * Authorized either by an internal secret header (server-to-server) or by a
 * signed-in SUPER_ADMIN user.
 *
 * Intentionally NOT behind the /api/ai/* per-user Upstash rate limit + plan
 * quota (CLAUDE.md rules 9/10): this is an internal admin/system job with no
 * per-user plan context — access is gated by secret/super-admin instead.
 */
export async function POST(req: NextRequest) {
  const authorized = await isAuthorized(req);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const embedded = await embedLessonById(parsed.data.lessonId);
  if (!embedded) {
    return NextResponse.json(
      { error: "Lesson not found or has no embeddable content" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, lessonId: parsed.data.lessonId });
}

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.INTERNAL_API_SECRET;
  const header = req.headers.get("x-internal-secret");
  if (secret && header && header === secret) return true;

  const { userId } = await auth();
  if (!userId) return false;

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });
  return user?.role === "SUPER_ADMIN";
}
