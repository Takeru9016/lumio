import { auth } from "@clerk/nextjs/server";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { z } from "zod";

import { db, mux } from "@/lib";

const f = createUploadthing();

async function getInstructor() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("User not found");
  if (user.role !== "INSTRUCTOR" && user.role !== "SUPER_ADMIN")
    throw new Error("Forbidden");
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

  assignmentUploader: f({ blob: { maxFileSize: "32MB", maxFileCount: 1 } })
    .middleware(async () => {
      const userId = await getStudent();
      return { userId };
    })
    .onUploadComplete(async ({ file }) => {
      return { url: file.ufsUrl };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
