import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/courseSkillManagement", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/domain/capability/courseSkillManagement")
  >("@/lib/domain/capability/courseSkillManagement");
  return {
    ...actual,
    listCourseSkills: vi.fn(),
    addCourseSkill: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireRole } = await import("@/lib/auth/context");
const { listCourseSkills, addCourseSkill, CourseSkillManagementError } = await import(
  "@/lib/domain/capability/courseSkillManagement"
);
const { GET, POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listCourseSkills);
const addMock = vi.mocked(addCourseSkill);

const getReq = () =>
  GET(new Request("http://localhost/api/courses/some-course/skills"), {
    params: Promise.resolve({ courseId: "some-course" }),
  });

const postReq = (body: unknown) =>
  POST(
    new Request("http://localhost/api/courses/some-course/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ courseId: "some-course" }) }
  );

function mockAuthed(role: "INSTRUCTOR" | "ORG_ADMIN" | "STUDENT" | "SUPER_ADMIN") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/courses/[courseId]/skills", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await getReq();

    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("STUDENT -> 403, never reaches the domain function", async () => {
    mockAuthed("STUDENT");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await getReq();

    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("INSTRUCTOR -> 200 with the domain result", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([{ skillId: "s1", skillName: "Skill 1", skillDescription: null }]);

    const res = await getReq();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      skills: [{ skillId: "s1", skillName: "Skill 1", skillDescription: null }],
    });
  });

  it("domain error (course not found) -> propagated status/message", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    listMock.mockRejectedValue(new CourseSkillManagementError(404, "Course not found"));

    const res = await getReq();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Course not found" });
  });
});

describe("POST /api/courses/[courseId]/skills", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await postReq({ skillId: "s1" });

    expect(res.status).toBe(401);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("malformed JSON body -> 400", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(
      new Request("http://localhost/api/courses/some-course/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      { params: Promise.resolve({ courseId: "some-course" }) }
    );

    expect(res.status).toBe(400);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("valid body -> 201 with the created mapping, passes courseId + body through to the domain function", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    addMock.mockResolvedValue({ skillId: "s1", skillName: "Skill 1", skillDescription: "desc" });

    const res = await postReq({ skillId: "s1" });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ skillId: "s1", skillName: "Skill 1", skillDescription: "desc" });
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "INSTRUCTOR" }),
      "some-course",
      { skillId: "s1" }
    );
  });

  it("duplicate mapping -> 409", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    addMock.mockRejectedValue(
      new CourseSkillManagementError(409, "This skill is already mapped to this course")
    );

    const res = await postReq({ skillId: "s1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "This skill is already mapped to this course" });
  });
});
