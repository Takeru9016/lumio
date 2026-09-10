import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Knowledge authorization/retrieval tests hit a real local Postgres
    // (see .env.test.local) — no mocking of the query layer, per Phase 2H.
    // Sequential runs avoid unique-slug collisions between test files
    // sharing one database.
    fileParallelism: false,
  },
});
