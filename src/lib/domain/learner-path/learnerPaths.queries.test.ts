import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";
import { getLearningPathForLearner } from "@/lib/domain/learner-path/learnerPaths";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function measure(count: number) {
  const w = await learnerWorld();
  const shared = await w.make();
  const courses = await w.makeMany(count);
  for (const c of courses) await w.requires(c.id, shared.id);
  // Every kind of course, so every branch of the derivation is exercised.
  await w.complete(courses[0]?.id ?? "");
  const path = await w.publishedPath(courses);
  const spies = {
    user: vi.spyOn(db.user, "findFirst"),
    path: vi.spyOn(db.learningPath, "findFirst"),
    members: vi.spyOn(db.learningPathCourse, "findMany"),
    sections: vi.spyOn(db.section, "findMany"),
    enrollments: vi.spyOn(db.enrollment, "findMany"),
    edges: vi.spyOn(db.coursePrerequisite, "findMany"),
    courses: vi.spyOn(db.course, "findMany"),
    courseOne: vi.spyOn(db.course, "findFirst"),
    enrollmentOne: vi.spyOn(db.enrollment, "findFirst"),
    enrollmentUnique: vi.spyOn(db.enrollment, "findUnique"),
  };
  const result = await getLearningPathForLearner(w.learner.ctx, path.id);
  const calls = Object.fromEntries(Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length]));
  vi.restoreAllMocks();
  return { calls, courses: result.courses.length };
}

describe("getLearningPathForLearner — bounded queries", () => {
  it("reads the same fixed set of queries for a 1-course, a 5-course and a 20-course path", async () => {
    const one = await measure(1);
    const five = await measure(5);
    const twenty = await measure(20);

    expect([one.courses, five.courses, twenty.courses]).toEqual([1, 5, 20]);
    expect(five.calls).toEqual(one.calls);
    expect(twenty.calls).toEqual(one.calls);
    expect(twenty.calls).toEqual({
      user: 1,
      path: 1,
      members: 1,
      sections: 2,
      enrollments: 2,
      edges: 1,
      courses: 0,
      courseOne: 0,
      enrollmentOne: 0,
      enrollmentUnique: 0,
    });
  });
});
