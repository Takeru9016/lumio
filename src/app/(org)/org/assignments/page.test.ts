import { auth } from "@clerk/nextjs/server";
import type { ReactElement } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenant,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("gooey-toast", () => ({ toast: { success: () => {}, error: () => {} } }));

const { default: OrgAssignmentsPage } = await import("./page");
const { AssignmentsClient } = await import("@/components/org/assignments/AssignmentsClient");
const { AssignmentFilters } = await import("@/components/org/assignments/AssignmentFilters");

type Scenario = Awaited<ReturnType<typeof createScenario>>;

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const load = (searchParams: Record<string, string | string[]> = {}) =>
  OrgAssignmentsPage({ searchParams: Promise.resolve(searchParams) });

const redirectTarget = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw err;
  }
  return null;
};

function childProps<T>(element: ReactElement, type: unknown): T {
  const children = (element.props as { children: ReactElement[] }).children;
  const found = children.find((c) => c && (c as ReactElement).type === type) as ReactElement;
  return found.props as T;
}

type ClientProps = {
  rows: { id: string; learnerEmail: string; courseTitle: string; status: string }[];
  options: { learners: { id: string; email: string }[]; courses: { id: string }[] };
  filtered: boolean;
  olderHref: string | null;
  newestHref: string | null;
};

async function assign(s: Scenario, courseId = s.course.id) {
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("/org/assignments — who may load the page", () => {
  it("unauthenticated goes to sign-in", async () => {
    signInAs(null);

    expect(await redirectTarget(load())).toBe("/sign-in");
  });

  it("a Clerk user with no Lumio row goes to sign-in", async () => {
    signInAs("clerk_never_synced");

    expect(await redirectTarget(load())).toBe("/sign-in");
  });

  it("STUDENT, INSTRUCTOR and SUPER_ADMIN are sent to /dashboard and are never shown data", async () => {
    const s = await createScenario();
    await assign(s);
    const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");

    for (const clerkId of [
      s.learner.user.clerkId,
      s.instructor.user.clerkId,
      superAdmin.user.clerkId,
    ]) {
      signInAs(clerkId);
      expect(await redirectTarget(load())).toBe("/dashboard");
    }
  });

  it("an ORG_ADMIN with no organisation is sent to onboarding", async () => {
    const orphan = await db.user.create({
      data: {
        clerkId: `clerk-orphan-${Date.now()}`,
        email: `orphan-${Date.now()}@x.test`,
        role: "ORG_ADMIN",
      },
    });
    signInAs(orphan.clerkId);

    expect(await redirectTarget(load())).toBe("/onboarding");
  });

  it("an ORG_ADMIN gets the page", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    expect(await redirectTarget(load())).toBeNull();
  });
});

describe("/org/assignments — what the page hands to the client", () => {
  it("only the admin's own tenant's assignments, learners and courses", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const forA = await assign(a);
    await assign(b);
    signInAs(a.admin.user.clerkId);

    const props = childProps<ClientProps>(await load(), AssignmentsClient);

    expect(props.rows.map((r) => r.id)).toEqual([forA.id]);
    expect(props.rows[0].learnerEmail).toBe(a.learner.user.email);
    const learnerIds = props.options.learners.map((l) => l.id);
    expect(learnerIds).toContain(a.learner.user.id);
    expect(learnerIds).not.toContain(b.learner.user.id);
    const courseIds = props.options.courses.map((c) => c.id);
    expect(courseIds).toContain(a.course.id);
    expect(courseIds).not.toContain(b.course.id);
  });

  it("does not let the URL name another tenant: only source and status are read", async () => {
    const a = await createScenario();
    const b = await createScenario();
    await assign(b);
    signInAs(a.admin.user.clerkId);

    const props = childProps<ClientProps>(
      await load({ tenantId: b.tenant.id, userId: b.learner.user.id } as never),
      AssignmentsClient
    );

    expect(props.rows).toEqual([]);
    expect(JSON.stringify(props)).not.toContain(b.tenant.id);
    expect(JSON.stringify(props)).not.toContain(b.learner.user.email);
  });

  it("carries no user, course, tenant or assigner id in the rows it passes down", async () => {
    const s = await createScenario();
    await assign(s);
    signInAs(s.admin.user.clerkId);

    const props = childProps<ClientProps>(await load(), AssignmentsClient);
    const rows = JSON.stringify(props.rows);

    for (const forbidden of [s.learner.user.id, s.course.id, s.tenant.id, s.admin.user.id]) {
      expect(rows, forbidden).not.toContain(forbidden);
    }
  });

  it("an empty organisation is an empty list, not an error", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const props = childProps<ClientProps>(await load(), AssignmentsClient);

    expect(props.rows).toEqual([]);
    expect(props.filtered).toBe(false);
    expect(props.olderHref).toBeNull();
    expect(props.newestHref).toBeNull();
  });
});

describe("/org/assignments — filters come from the URL", () => {
  async function withOneCancelled() {
    const s = await createScenario();
    const second = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const keep = await assign(s);
    const gone = await assign(s, second.course.id);
    await cancelAssignment(s.admin.ctx, gone.id);
    signInAs(s.admin.user.clerkId);
    return { s, keep, gone };
  }

  it("applies a status filter and reports that the list is filtered", async () => {
    const { gone } = await withOneCancelled();

    const props = childProps<ClientProps>(await load({ status: "cancelled" }), AssignmentsClient);

    expect(props.rows.map((r) => r.id)).toEqual([gone.id]);
    expect(props.filtered).toBe(true);
  });

  it("applies a source filter", async () => {
    await withOneCancelled();

    const manual = childProps<ClientProps>(await load({ source: "manual" }), AssignmentsClient);
    const mandatory = childProps<ClientProps>(
      await load({ source: "mandatory" }),
      AssignmentsClient
    );

    expect(manual.rows).toHaveLength(2);
    expect(mandatory.rows).toEqual([]);
  });

  it("marks the chosen filters on the filter bar", async () => {
    await withOneCancelled();

    const bar = childProps<{ source: string | null; status: string | null }>(
      await load({ source: "manual", status: "overdue" }),
      AssignmentFilters
    );

    expect(bar).toEqual({ source: "MANUAL", status: "OVERDUE" });
  });

  it("takes the first value when a parameter is repeated", async () => {
    const { gone } = await withOneCancelled();

    const props = childProps<ClientProps>(
      await load({ status: ["cancelled", "assigned"] }),
      AssignmentsClient
    );

    expect(props.rows.map((r) => r.id)).toEqual([gone.id]);
  });

  it("an unknown filter redirects to the unfiltered list instead of silently showing everything as filtered", async () => {
    await withOneCancelled();

    expect(await redirectTarget(load({ status: "nonsense" }))).toBe("/org/assignments");
    expect(await redirectTarget(load({ source: "team" }))).toBe("/org/assignments");
  });
});

describe("/org/assignments — paging comes from the URL", () => {
  async function learners(s: Scenario, count: number, dueDate?: Date) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const learner = await createUserIn(s.tenant.id, "STUDENT");
      const result = await createManualAssignment(s.admin.ctx, {
        userId: learner.user.id,
        courseId: s.course.id,
        ...(dueDate ? { dueDate } : {}),
      });
      if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
      made.push(result.assignment);
    }
    return made;
  }

  it("a full first page links to the older page under the same filters, with no way 'back' yet", async () => {
    const s = await createScenario();
    await learners(s, 51);
    signInAs(s.admin.user.clerkId);

    const props = childProps<ClientProps>(await load({ source: "manual" }), AssignmentsClient);

    expect(props.rows).toHaveLength(50);
    expect(props.olderHref).toMatch(/^\/org\/assignments\?source=manual&cursor=/);
    expect(props.newestHref).toBeNull();
  });

  it("following the link shows the rest, and a way back to the newest that keeps the filters", async () => {
    const s = await createScenario();
    const made = await learners(s, 51);
    signInAs(s.admin.user.clerkId);
    const first = childProps<ClientProps>(await load({ source: "manual" }), AssignmentsClient);
    const cursor = new URL(first.olderHref ?? "", "http://x").searchParams.get("cursor") ?? "";

    const second = childProps<ClientProps>(
      await load({ source: "manual", cursor }),
      AssignmentsClient
    );

    expect(second.rows).toHaveLength(1);
    expect(second.olderHref).toBeNull();
    expect(second.newestHref).toBe("/org/assignments?source=manual");
    expect([...first.rows, ...second.rows].map((r) => r.id).sort()).toEqual(
      made.map((m) => m.id).sort()
    );
  });

  it("a status filter is applied before paging: old overdue rows behind newer ones are on the list", async () => {
    const s = await createScenario();
    const overdue = await learners(s, 2, new Date("2020-01-01T00:00:00.000Z"));
    await learners(s, 3, new Date("2099-01-01T00:00:00.000Z"));
    signInAs(s.admin.user.clerkId);

    const props = childProps<ClientProps>(await load({ status: "overdue" }), AssignmentsClient);

    expect(props.rows.map((r) => r.id).sort()).toEqual(overdue.map((o) => o.id).sort());
    expect(props.olderHref).toBeNull();
  });

  it("a malformed cursor redirects to the same filters' newest page rather than showing the wrong list", async () => {
    const s = await createScenario();
    await learners(s, 1);
    signInAs(s.admin.user.clerkId);

    expect(await redirectTarget(load({ cursor: "garbage" }))).toBe("/org/assignments");
    expect(await redirectTarget(load({ status: "overdue", cursor: "garbage" }))).toBe(
      "/org/assignments?status=overdue"
    );
  });
});

describe("tenant sanity", () => {
  it("the scenarios used above really are different tenants", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const c = await createTenant();

    expect(new Set([a.tenant.id, b.tenant.id, c.id]).size).toBe(3);
  });
});
