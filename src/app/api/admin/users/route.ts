import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import type { Role } from "@/generated/prisma/enums";
import { searchUsers } from "@/lib/admin-users";
import { db } from "@/lib/db";

const VALID_ROLES = new Set<Role>(["STUDENT", "INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"]);

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actor = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });
  if (!actor || actor.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const rawRole = url.searchParams.get("role");
  const role = rawRole && VALID_ROLES.has(rawRole as Role) ? (rawRole as Role) : undefined;

  const users = await searchUsers({ q, role });
  return NextResponse.json({ users });
}
