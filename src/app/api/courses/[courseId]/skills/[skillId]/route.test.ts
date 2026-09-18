import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/courseSkillManagement", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/domain/capability/courseSkillManagement")
  >("@/lib/domain/capability/courseSkillManagement");
  return { ...actual, removeCourseSkill: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireRole } = await import("@/lib/auth/context");
const { removeCourseSkill, CourseSkillManagementError } = await import(
  "@/lib/domain/capability/courseSkillManagement"
);
const { DELETE } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireRoleMock = vi.mocked(requireRole);
const removeMock = vi.mocked(removeCourseSkill);

const del = () =>
  DELETE(new Request("http://localhost/api/courses/some-course/skills/s1", { method: "DELETE" }), {
    params: Promise.resolve({ courseId: "some-course", skillId: "s1" }),
  });

function mockAuthed(role: "INSTRUCTOR" | "ORG_ADMIN" | "STUDENT" | "SUPER_ADMIN") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("DELETE /api/courses/[courseId]/skills/[skillId]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await del();

    expect(res.status).toBe(401);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("STUDENT -> 403", async () => {
    mockAuthed("STUDENT");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await del();

    expect(res.status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("success -> 204, passes courseId + skillId through to the domain function", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    removeMock.mockResolvedValue(undefined);

    const res = await del();

    expect(res.status).toBe(204);
    expect(removeMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "ORG_ADMIN" }),
      "some-course",
      "s1"
    );
  });

  it("not mapped -> 404", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    removeMock.mockRejectedValue(
      new CourseSkillManagementError(404, "This skill is not mapped to this course")
    );

    const res = await del();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "This skill is not mapped to this course" });
  });
});
