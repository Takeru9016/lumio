import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRouteFetch } from "@/lib/__test__/pathRouteFetch";
import * as admin from "@/lib/admin-path-client";
import { describeProblems } from "@/lib/admin-path-view";
import { db } from "@/lib/db";
import { learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";
import * as learner from "@/lib/learner-path-client";
import {
  courseHref,
  presentPathCard,
  presentPathCourses,
  presentProgress,
} from "@/lib/learner-path-view";
import { listPathCourseChoices } from "@/lib/org-path-course-choices";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

function ok<T>(result: admin.AdminResult<T>): T {
  if (result.kind !== "ok") throw new Error(`expected ok, got: ${result.failure.message}`);
  return result.data;
}

function refused<T>(result: admin.AdminResult<T>): admin.AdminFailure {
  if (result.kind !== "error") throw new Error("expected a refusal, got ok");
  return result.failure;
}

function ready<T>(load: admin.AdminLoad<T> | learner.LearnerLoad<T>): T {
  if (load.kind !== "ready") throw new Error(`expected ready, got ${load.kind}`);
  return load.data;
}

/**
 * The browser clients against the real routes: what the screens send is judged by
 * the same handlers, authorization and database as in production, and what comes
 * back is what the screens are drawn from. This is where the UI's promises about
 * the API (nothing but the chosen fields is sent, the server's refusals arrive as
 * words, the learner's view is redacted and derived) are proved end to end.
 */
describe("admin clients against the admin path routes", () => {
  it("creates, edits, adds, reorders and reads a path", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const { fetchImpl } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    const created = ok(
      await admin.createPath({ title: "  Leadership  ", description: "" }, fetchImpl)
    );
    expect(created).toMatchObject({ title: "Leadership", description: null, status: "DRAFT" });

    const edited = ok(
      await admin.updatePath(
        created.id,
        { title: "Leadership 2", description: "Basics" },
        fetchImpl
      )
    );
    expect(edited).toMatchObject({ title: "Leadership 2", description: "Basics" });

    ok(await admin.addCourse(created.id, a.id, fetchImpl));
    ok(await admin.addCourse(created.id, b.id, fetchImpl));
    ok(await admin.reorderCourses(created.id, [b.id, a.id], fetchImpl));

    const path = ready(await admin.loadAdminPath(created.id, fetchImpl));
    expect(path.courses.map((c) => [c.courseId, c.position])).toEqual([
      [b.id, 1],
      [a.id, 2],
    ]);
    expect(path.courses.every((c) => c.availability === "AVAILABLE")).toBe(true);
    expect(await w.memberIds(created.id)).toEqual([b.id, a.id]);
  });

  it("sends only what a person chose: no tenant, no actor, no status, no positions", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const path = await w.makePath({ courses: [a, b] });
    const { fetchImpl, sent } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    ok(await admin.createPath({ title: "T", description: "D" }, fetchImpl));
    ok(await admin.updatePath(path.id, { title: "T2", description: "" }, fetchImpl));
    ok(await admin.reorderCourses(path.id, [b.id, a.id], fetchImpl));
    ok(await admin.publishPath(path.id, fetchImpl));

    const bodies = sent.filter((r) => r.body !== null).map((r) => JSON.parse(r.body ?? "null"));
    expect(bodies).toEqual([
      { title: "T", description: "D" },
      { title: "T2", description: null },
      { courseIds: [b.id, a.id] },
    ]);
    const publish = sent.find((r) => r.url.endsWith("/publish"));
    expect(publish).toMatchObject({ method: "POST", body: null });
  });

  it("names the courses that block a publish, and publishes once they are gone", async () => {
    const w = await learnerWorld();
    const a = await w.make();
    const draft = await w.make({ status: "DRAFT" });
    const path = await w.makePath({ courses: [a, draft] });
    const { fetchImpl } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    const refusal = refused(await admin.publishPath(path.id, fetchImpl));
    expect(refusal.code).toBe("PATH_NOT_PUBLISHABLE");
    expect(refusal.message).toBe("This path can't be published yet.");
    expect(describeProblems(refusal.problems)).toEqual({
      intro: "1 course needs attention:",
      items: [{ key: `course-${draft.id}`, text: `${draft.title} isn't published` }],
    });
    expect((await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).status).toBe(
      "DRAFT"
    );

    ok(await admin.removeCourse(path.id, draft.id, fetchImpl));
    const published = ok(await admin.publishPath(path.id, fetchImpl));
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).not.toBeNull();
  });

  it("archives with the courses intact, refuses edits while archived, and republishes", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b] });
    const { fetchImpl } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    expect(ok(await admin.archivePath(path.id, fetchImpl)).status).toBe("ARCHIVED");
    expect(
      ready(await admin.loadAdminPath(path.id, fetchImpl)).courses.map((c) => c.courseId)
    ).toEqual([a.id, b.id]);

    const edit = refused(
      await admin.updatePath(path.id, { title: "x", description: "" }, fetchImpl)
    );
    expect(edit.code).toBe("PATH_ARCHIVED");
    expect(edit.message).toMatch(/archived/i);
    expect(refused(await admin.addCourse(path.id, a.id, fetchImpl)).code).toBe("PATH_ARCHIVED");

    expect(ok(await admin.publishPath(path.id, fetchImpl)).status).toBe("PUBLISHED");
  });

  it("puts every refusal into words, never a code, and says when to re-read the path", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const archived = await w.make();
    await w.archive(archived.id);
    const foreign = await w.makeForeign();
    const draftPath = await w.makePath({ courses: [a, b] });
    const publishedSingle = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const full = await w.makePath({ courses: await w.makeMany(20) });
    const { fetchImpl } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    const cases: [string, admin.AdminFailure, string, boolean][] = [
      [
        "duplicate",
        refused(await admin.addCourse(draftPath.id, a.id, fetchImpl)),
        "DUPLICATE",
        true,
      ],
      [
        "archived course",
        refused(await admin.addCourse(draftPath.id, archived.id, fetchImpl)),
        "COURSE_ARCHIVED",
        true,
      ],
      [
        "foreign course",
        refused(await admin.addCourse(draftPath.id, foreign.id, fetchImpl)),
        "COURSE_NOT_FOUND",
        true,
      ],
      [
        "limit",
        refused(await admin.addCourse(full.id, (await w.make()).id, fetchImpl)),
        "LIMIT_REACHED",
        true,
      ],
      [
        "last course",
        refused(
          await admin.removeCourse(
            publishedSingle.id,
            (await w.memberIds(publishedSingle.id))[0],
            fetchImpl
          )
        ),
        "LAST_COURSE",
        true,
      ],
      [
        "stale order",
        refused(await admin.reorderCourses(draftPath.id, [a.id], fetchImpl)),
        "STALE_ORDER",
        true,
      ],
      [
        "blank title",
        refused(await admin.createPath({ title: "   ", description: "" }, fetchImpl)),
        "INVALID_INPUT",
        false,
      ],
    ];

    for (const [name, failure, code, refresh] of cases) {
      expect(failure.code, name).toBe(code);
      expect(failure.refresh, name).toBe(refresh);
      expect(failure.message, name).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/);
      expect(failure.message.length, name).toBeGreaterThan(10);
    }

    expect(cases.find(([n]) => n === "duplicate")?.[1].message).toBe(
      "That course is already in this path."
    );
    expect(cases.find(([n]) => n === "stale order")?.[1].message).toMatch(/current order/);
  });

  it("reads the list with the server's own status filter and cursor", async () => {
    const w = await learnerWorld();
    const older = await w.makePath({ status: "DRAFT", createdAt: new Date("2026-01-01") });
    const middle = await w.makePath({
      status: "PUBLISHED",
      courses: [await w.make()],
      createdAt: new Date("2026-02-01"),
    });
    const newest = await w.makePath({ status: "ARCHIVED", createdAt: new Date("2026-03-01") });
    const { fetchImpl, sent } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    const all = ready(await admin.loadAdminPaths({ status: null, cursor: null }, fetchImpl));
    expect(all.paths.map((p) => p.id)).toEqual([newest.id, middle.id, older.id]);

    for (const [status, path] of [
      ["DRAFT", older],
      ["PUBLISHED", middle],
      ["ARCHIVED", newest],
    ] as const) {
      const filtered = ready(await admin.loadAdminPaths({ status, cursor: null }, fetchImpl));
      expect(filtered.paths.map((p) => p.id)).toEqual([path.id]);
    }
    expect(sent.some((r) => r.url === "/api/org/paths?status=DRAFT")).toBe(true);

    const firstPage = await (await fetchImpl("/api/org/paths?limit=1")).json();
    expect(firstPage.paths.map((p: { id: string }) => p.id)).toEqual([newest.id]);
    const second = ready(
      await admin.loadAdminPaths({ status: null, cursor: firstPage.nextCursor }, fetchImpl)
    );
    expect(second.paths.map((p) => p.id)).toEqual([middle.id, older.id]);

    expect(
      (await admin.loadAdminPaths({ status: null, cursor: "not-a-cursor" }, fetchImpl)).kind
    ).toBe("not_found");
  });
});

describe("the API stays the authorization layer", () => {
  it("turns away every caller that is not an organisation admin, in words", async () => {
    const w = await learnerWorld();
    const path = await w.makePath({ courses: [await w.make()] });
    const { fetchImpl } = createRouteFetch();

    signInAs(w.learner.user.clerkId);
    const create = refused(await admin.createPath({ title: "Nope", description: "" }, fetchImpl));
    expect(create).toMatchObject({ status: 403 });
    expect(create.message).toMatch(/permission/);
    expect(refused(await admin.publishPath(path.id, fetchImpl)).status).toBe(403);
    const read = await admin.loadAdminPath(path.id, fetchImpl);
    expect(read.kind === "error" && read.failure.status).toBe(403);

    signInAs(null);
    const anonymous = refused(await admin.publishPath(path.id, fetchImpl));
    expect(anonymous.status).toBe(401);
    expect(anonymous.message).toMatch(/session/);

    expect((await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).status).toBe(
      "DRAFT"
    );
  });

  it("gives another organisation's admin the same not-found as a path that does not exist", async () => {
    const mine = await learnerWorld();
    const theirs = await learnerWorld();
    const path = await mine.makePath({ status: "PUBLISHED", courses: [await mine.make()] });
    const { fetchImpl } = createRouteFetch();

    signInAs(theirs.admin.user.clerkId);
    expect((await admin.loadAdminPath(path.id, fetchImpl)).kind).toBe("not_found");
    expect((await admin.loadAdminPath("does-not-exist", fetchImpl)).kind).toBe("not_found");
    const publish = refused(await admin.publishPath(path.id, fetchImpl));
    const unknown = refused(await admin.publishPath("does-not-exist", fetchImpl));
    expect(publish).toEqual(unknown);
    expect(publish.status).toBe(404);
    expect(
      ready(await admin.loadAdminPaths({ status: null, cursor: null }, fetchImpl)).paths
    ).toEqual([]);
  });

  it("refuses a forged body that names a tenant, a creator, a status or a position", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const { fetchImpl } = createRouteFetch();
    signInAs(w.admin.user.clerkId);

    for (const extra of [
      { tenantId: other.tenant.id },
      { createdById: other.admin.user.id },
      { status: "PUBLISHED" },
      { position: 1 },
    ]) {
      const res = await fetchImpl("/api/org/paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Forged", ...extra }),
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await db.learningPath.count({ where: { title: "Forged" } })).toBe(0);
  });
});

describe("the learner clients and the journey from an admin's path to a learner's progress", () => {
  it("shows a published path, then its progress moving as courses are completed", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const { fetchImpl } = createRouteFetch();

    signInAs(w.admin.user.clerkId);
    const created = ok(
      await admin.createPath({ title: "Journey", description: "Two steps" }, fetchImpl)
    );
    ok(await admin.addCourse(created.id, a.id, fetchImpl));
    ok(await admin.addCourse(created.id, b.id, fetchImpl));
    ok(await admin.reorderCourses(created.id, [b.id, a.id], fetchImpl));
    ok(await admin.publishPath(created.id, fetchImpl));

    const before = await w.sideEffects();
    signInAs(w.learner.user.clerkId);

    const list = ready(await learner.loadLearnerPaths(null, fetchImpl));
    const item = list.paths.find((p) => p.id === created.id);
    expect(item?.progress).toEqual({ completed: 0, available: 2, percentage: 0 });
    const card = presentPathCard(item as learner.LearnerPathListItem);
    expect(card).toMatchObject({ courseCountLabel: "2 courses", ctaLabel: "View path" });
    expect(card.progress).toMatchObject({ kind: "measured", summary: "0 of 2 courses completed" });

    const first = ready(await learner.loadLearnerPath(created.id, fetchImpl));
    const firstRows = presentPathCourses(first);
    expect(firstRows.map((r) => [r.positionLabel, r.title, r.availability, r.href])).toEqual([
      ["01", b.title, "AVAILABLE", courseHref(b.slug)],
      ["02", a.title, "AVAILABLE", courseHref(a.slug)],
    ]);

    await w.complete(b.id);
    const half = ready(await learner.loadLearnerPath(created.id, fetchImpl));
    expect(half.progress).toEqual({ completed: 1, available: 1, percentage: 50 });
    expect(presentPathCourses(half).map((r) => r.availability)).toEqual(["COMPLETED", "AVAILABLE"]);
    expect(presentPathCourses(half)[0].ctaLabel).toBe("Review course");
    const halfCard = presentPathCard({
      ...(item as learner.LearnerPathListItem),
      progress: half.progress,
    });
    expect(halfCard.ctaLabel).toBe("Continue");

    await w.complete(a.id);
    const done = ready(await learner.loadLearnerPath(created.id, fetchImpl));
    expect(done.progress).toEqual({ completed: 2, available: 0, percentage: 100 });
    expect(presentProgress(done.progress)).toMatchObject({ kind: "measured", percent: 100 });

    const after = await w.sideEffects();
    expect(after.enrollments).toBe(before.enrollments + 2);
    expect({ ...after, enrollments: 0 }).toEqual({ ...before, enrollments: 0 });
  });

  it("draws a blocked course from its position and prerequisite state alone", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    const draftLater = await w.make();
    await w.requires(b.id, a.id);
    const path = await w.publishedPath([a, b, draftLater]);
    await w.unpublish(draftLater.id);
    const { fetchImpl } = createRouteFetch();
    signInAs(w.learner.user.clerkId);

    const blocked = ready(await learner.loadLearnerPath(path.id, fetchImpl));
    const rows = presentPathCourses(blocked);
    expect(rows.map((r) => [r.availability, r.title, r.href, r.prerequisiteLabel])).toEqual([
      ["AVAILABLE", a.title, courseHref(a.slug), "No prerequisites"],
      ["UNAVAILABLE", null, null, "Prerequisite required"],
      ["UNAVAILABLE", null, null, null],
    ]);
    const shown = JSON.stringify(rows);
    for (const secret of [b.title, b.slug, draftLater.title, draftLater.slug, draftLater.id]) {
      expect(shown).not.toContain(secret);
    }
    expect(blocked.progress).toEqual({ completed: 0, available: 1, percentage: 0 });

    await w.complete(a.id);
    const unblocked = presentPathCourses(ready(await learner.loadLearnerPath(path.id, fetchImpl)));
    expect(unblocked.map((r) => [r.availability, r.prerequisiteLabel])).toEqual([
      ["COMPLETED", "No prerequisites"],
      ["AVAILABLE", "Prerequisites complete"],
      ["UNAVAILABLE", null],
    ]);
  });

  it("does not draw a 0% for a path with nothing open to the learner", async () => {
    const w = await learnerWorld();
    const only = await w.make();
    const path = await w.publishedPath([only]);
    await w.unpublish(only.id);
    const { fetchImpl } = createRouteFetch();
    signInAs(w.learner.user.clerkId);

    const item = ready(await learner.loadLearnerPaths(null, fetchImpl)).paths.find(
      (p) => p.id === path.id
    ) as learner.LearnerPathListItem;
    expect(item.progress).toEqual({ completed: 0, available: 0, percentage: null });
    const view = presentPathCard(item).progress;
    expect(view).toEqual({ kind: "unmeasured", summary: "No courses are open to you yet" });
  });

  it("keeps another organisation's paths out of a learner's list and out of a direct link", async () => {
    const mine = await learnerWorld();
    const theirs = await learnerWorld();
    const foreign = await theirs.publishedPath([await theirs.make()]);
    const own = await mine.publishedPath([await mine.make()]);
    const { fetchImpl } = createRouteFetch();

    signInAs(mine.learner.user.clerkId);
    const ids = ready(await learner.loadLearnerPaths(null, fetchImpl)).paths.map((p) => p.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
    expect((await learner.loadLearnerPath(foreign.id, fetchImpl)).kind).toBe("not_found");
    expect((await learner.loadLearnerPath("does-not-exist", fetchImpl)).kind).toBe("not_found");
  });

  it("hides drafts and archived paths from a learner and refuses non-learners with words", async () => {
    const w = await learnerWorld();
    const draft = await w.makePath({ courses: [await w.make()] });
    const archived = await w.makePath({ status: "ARCHIVED", courses: [await w.make()] });
    const { fetchImpl } = createRouteFetch();

    signInAs(w.learner.user.clerkId);
    expect((await learner.loadLearnerPath(draft.id, fetchImpl)).kind).toBe("not_found");
    expect((await learner.loadLearnerPath(archived.id, fetchImpl)).kind).toBe("not_found");

    signInAs(w.admin.user.clerkId);
    const asAdmin = await learner.loadLearnerPaths(null, fetchImpl);
    expect(asAdmin).toEqual({
      kind: "error",
      message: "Learning paths are available to learners in an organisation.",
    });

    signInAs(null);
    const signedOut = await learner.loadLearnerPaths(null, fetchImpl);
    expect(signedOut.kind === "error" && signedOut.message).toMatch(/session/);
  });
});

describe("the courses an administrator can choose from", () => {
  it("are the organisation's own courses that are not archived, and only those", async () => {
    const w = await learnerWorld();
    const published = await w.make();
    const draft = await w.make({ status: "DRAFT" });
    const archived = await w.make();
    await w.archive(archived.id);
    const catalogue = await w.makeTenantless();
    const foreign = await w.makeForeign();

    const choices = await listPathCourseChoices(w.admin.ctx);
    const byId = new Map(choices.map((c) => [c.id, c]));

    expect(byId.get(published.id)).toMatchObject({ title: published.title, status: "PUBLISHED" });
    expect(byId.get(draft.id)).toMatchObject({ status: "DRAFT" });
    for (const excluded of [archived, catalogue, foreign]) {
      expect(byId.has(excluded.id), excluded.id).toBe(false);
    }
  });

  it("come back by title, whatever order they were made in", async () => {
    const w = await learnerWorld();
    const [c1, c2, c3] = await w.makeMany(3);
    for (const [course, title] of [
      [c1, "Zeta"],
      [c2, "Alpha"],
      [c3, "Mid"],
    ] as const) {
      await db.course.update({ where: { id: course.id }, data: { title } });
    }

    const ours = (await listPathCourseChoices(w.admin.ctx)).filter((c) =>
      [c1.id, c2.id, c3.id].includes(c.id)
    );

    expect(ours.map((c) => c.title)).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  it("are read for an organisation admin only", async () => {
    const w = await learnerWorld();
    await w.make();

    for (const [name, ctx] of w.outsiders) {
      await expect(listPathCourseChoices(ctx), name).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("never include another organisation's courses, whichever admin asks", async () => {
    const mine = await learnerWorld();
    const theirs = await learnerWorld();
    const theirCourse = await theirs.make();
    const myCourse = await mine.make();

    const mineIds = (await listPathCourseChoices(mine.admin.ctx)).map((c) => c.id);
    const theirIds = (await listPathCourseChoices(theirs.admin.ctx)).map((c) => c.id);

    expect(mineIds).toContain(myCourse.id);
    expect(mineIds).not.toContain(theirCourse.id);
    expect(theirIds).toContain(theirCourse.id);
    expect(theirIds).not.toContain(myCourse.id);
  });
});
