import { NextResponse } from "next/server";

import { db } from "@/lib";

export async function GET() {
  const count = await db.user.count();
  return NextResponse.json({ count });
}
