import { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Holds the path's row lock in an open transaction, running `whileLocked` inside it,
 * until `release` is called: what a competing writer that has not committed yet
 * looks like to the operation under test. `done` settles once it commits.
 */
export function holdLock(pathId: string, whileLocked: (tx: Tx) => Promise<void> = async () => {}) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LearningPath" WHERE id = ${pathId} FOR UPDATE`;
    locked();
    await gate;
    await whileLocked(tx);
  });
  return { isLocked, release, done };
}

/** True when `promise` settles within `ms`; false when it is still waiting. */
export const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
