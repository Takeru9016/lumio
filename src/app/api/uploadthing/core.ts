import { auth } from "@clerk/nextjs/server";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { z } from "zod";

import { db } from "@/lib/db";
import { mux } from "@/lib/mux";

const f = createUploadthing();

async function getInstructor() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("User not found");
  if (user.role !== "INSTRUCTOR" && user.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  return userId;
}

async function getOrgAdmin() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("User not found");
  if (user.role !== "ORG_ADMIN" && user.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  return userId;
}

async function getStudent() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!user) throw new Error("User not found");
  return userId;
}

/**
 * Phase 16 — Knowledge file upload. Deliberately NOT getInstructor()/
 * getOrgAdmin() above: both of those allow a SUPER_ADMIN fallback, which
 * directly contradicts Phase 14's locked correction that SUPER_ADMIN has no
 * shortcut into Knowledge management. INSTRUCTOR and ORG_ADMIN only.
 */
async function getKnowledgeStaff() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("User not found");
  if (user.role !== "INSTRUCTOR" && user.role !== "ORG_ADMIN") throw new Error("Forbidden");
  return userId;
}

export const ourFileRouter = {
  videoUploader: f({ video: { maxFileSize: "2GB", maxFileCount: 1 } })
    .input(z.object({ lessonId: z.string() }))
    .middleware(async ({ input }) => {
      const userId = await getInstructor();
      return { userId, lessonId: input.lessonId };
    })
    .onUploadComplete(async ({ file, metadata }) => {
      const asset = await mux.video.assets.create({
        inputs: [{ url: file.ufsUrl }],
        playback_policy: ["public"],
        test: false,
      });

      await db.lesson.update({
        where: { id: metadata.lessonId },
        data: {
          muxAssetId: asset.id,
          videoStatus: "PROCESSING",
        },
      });

      return { muxAssetId: asset.id };
    }),

  thumbnailUploader: f({ image: { maxFileSize: "4MB", maxFileCount: 1 } })
    .middleware(async () => {
      const userId = await getInstructor();
      return { userId };
    })
    .onUploadComplete(async ({ file }) => {
      return { url: file.ufsUrl };
    }),

  logoUploader: f({ image: { maxFileSize: "2MB", maxFileCount: 1 } })
    .middleware(async () => {
      const userId = await getOrgAdmin();
      return { userId };
    })
    .onUploadComplete(async ({ file }) => {
      return { url: file.ufsUrl };
    }),

  assignmentUploader: f({ blob: { maxFileSize: "32MB", maxFileCount: 1 } })
    .middleware(async () => {
      const userId = await getStudent();
      return { userId };
    })
    .onUploadComplete(async ({ file }) => {
      return { url: file.ufsUrl };
    }),

  /**
   * Phase 16 — Knowledge PDF/DOCX upload. `blob` (not a dedicated `pdf`
   * route type) matches the existing assignmentUploader precedent: actual
   * PDF/DOCX format is never trusted from this upload step (a client can
   * name/type anything) — it is verified authoritatively, from the
   * downloaded bytes' magic numbers, by fileExtraction.ts's detectFormat()
   * once POST /api/knowledge/documents/upload re-downloads the file. This
   * middleware only returns {url, name, size}; it deliberately makes no
   * database write — the actual KnowledgeDocument creation happens from the
   * client's explicit follow-up call, not from this server callback.
   */
  knowledgeDocumentUploader: f({ blob: { maxFileSize: "16MB", maxFileCount: 1 } })
    .middleware(async () => {
      const userId = await getKnowledgeStaff();
      return { userId };
    })
    .onUploadComplete(async ({ file }) => {
      return { url: file.ufsUrl, name: file.name, size: file.size };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
