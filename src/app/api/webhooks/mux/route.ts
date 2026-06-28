import { headers } from "next/headers";

import { db, mux } from "@/lib";

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();

  let event: Awaited<ReturnType<typeof mux.webhooks.unwrap>>;
  try {
    event = await mux.webhooks.unwrap(
      body,
      headersList,
      process.env.MUX_WEBHOOK_SECRET!,
    );
  } catch {
    return new Response("Invalid Mux signature", { status: 401 });
  }

  const assetId = (event.data as { id?: string })?.id;
  if (!assetId) return new Response("Missing asset ID", { status: 400 });

  if (event.type === "video.asset.ready") {
    const playbackId = (event.data as { playback_ids?: { id: string }[] })
      ?.playback_ids?.[0]?.id;

    await db.lesson.updateMany({
      where: { muxAssetId: assetId },
      data: {
        muxPlaybackId: playbackId,
        videoStatus: "READY",
      },
    });
  }

  if (event.type === "video.asset.errored") {
    await db.lesson.updateMany({
      where: { muxAssetId: assetId },
      data: { videoStatus: "ERROR" },
    });
  }

  return new Response(null, { status: 200 });
}
