import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Neon's serverless driver speaks a Neon-specific WebSocket protocol and
// cannot reach a plain Postgres server (e.g. the local pgvector instance
// used by `pnpm test` — see .env.test.local). Production/preview always use
// a real Neon DATABASE_URL, so this branch only ever takes the adapter-pg
// path in local dev/test.
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  const adapter = connectionString?.includes(".neon.tech")
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
