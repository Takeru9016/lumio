import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

const uploadFilesMock = vi.fn();
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    uploadFiles = uploadFilesMock;
  },
}));

const sendMock = vi.fn();
vi.mock("@/lib/resend", () => ({
  resend: { emails: { send: (...args: unknown[]) => sendMock(...args) } },
}));

const { buildCertHtml, generateCertificate } = await import("./certificate");
const { CertificateEmail } = await import("./emails/certificate");

const NORMAL = {
  certId: "AbC123_-xYz9",
  studentName: "Jane Doe",
  courseTitle: "Intro to TypeScript",
  issuedDate: "March 4, 2026",
};

function titleOf(html: string): string {
  const match = html.match(/<title>([\s\S]*?)<\/title>/);
  return match?.[1] ?? "";
}

beforeEach(() => {
  uploadFilesMock.mockReset();
  sendMock.mockReset();
  uploadFilesMock.mockImplementation(async (file: File) => ({
    data: { ufsUrl: `https://utfs.test/${file.name}` },
    error: null,
  }));
  sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("buildCertHtml — escaping", () => {
  it("escapes a script payload in the learner name", () => {
    const html = buildCertHtml({ ...NORMAL, studentName: "<script>alert(1)</script>" });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain('<p class="student-name">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it("escapes a script payload in the course title in both places it appears", () => {
    const html = buildCertHtml({ ...NORMAL, courseTitle: "<script>alert(1)</script>" });

    expect(html).not.toContain("<script");
    expect(titleOf(html)).toBe("Certificate of Completion — &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<p class="course-title">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it("cannot break out of <title> with a closing-title payload", () => {
    const payload = "</title><script>alert(1)</script>";
    const html = buildCertHtml({ ...NORMAL, courseTitle: payload });

    expect(html).not.toContain("<script");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<\/title>/g)).toHaveLength(1);
    expect(titleOf(html)).not.toContain("<");
    expect(titleOf(html)).toContain("&lt;/title&gt;&lt;script&gt;");
  });

  it("neutralizes an HTML tag with an event-handler attribute", () => {
    const html = buildCertHtml({
      ...NORMAL,
      studentName: "<img src=x onerror=alert(1)>",
      courseTitle: "<img src=x onerror=alert(1)>",
    });

    expect(html).not.toContain("<img");
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)).toHaveLength(3);
  });

  it("neutralizes an attribute-injection style payload", () => {
    const payload = '" onmouseover="alert(1)" x="';
    const html = buildCertHtml({ ...NORMAL, studentName: payload, courseTitle: payload });

    expect(html).not.toContain('onmouseover="');
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)&quot; x=&quot;");
  });

  it("escapes ampersands and both quote characters", () => {
    const html = buildCertHtml({ ...NORMAL, studentName: `Tom & "Jerry's" <3` });

    expect(html).toContain('<p class="student-name">Tom &amp; &quot;Jerry&#39;s&quot; &lt;3</p>');
  });

  it("escapes certId and issuedDate too (defense in depth)", () => {
    const html = buildCertHtml({
      ...NORMAL,
      certId: "<b>id</b>",
      issuedDate: "<i>today</i>",
    });

    expect(html).not.toContain("<b>id</b>");
    expect(html).not.toContain("<i>today</i>");
    expect(html).toContain('<div class="meta-value">&lt;b&gt;id&lt;/b&gt;</div>');
    expect(html).toContain('<div class="meta-value">&lt;i&gt;today&lt;/i&gt;</div>');
  });

  it("renders normal values unchanged (no entities introduced)", () => {
    const html = buildCertHtml(NORMAL);

    expect(html).toContain('<p class="student-name">Jane Doe</p>');
    expect(html).toContain('<p class="course-title">Intro to TypeScript</p>');
    expect(html).toContain("<title>Certificate of Completion — Intro to TypeScript</title>");
    expect(html).toContain('<div class="meta-value">AbC123_-xYz9</div>');
    expect(html).toContain('<div class="meta-value">March 4, 2026</div>');
    expect(html).not.toMatch(/&(amp|lt|gt|quot|#39);/);
  });

  it("keeps the fixed template markup intact", () => {
    const html = buildCertHtml(NORMAL);

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<div class="wordmark">✦ Lumio</div>');
    expect(html).toContain("<style>");
    expect(html).toContain("</html>");
  });
});

describe("generateCertificate — end to end", () => {
  async function seed(name: string | null, title: string) {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, instructor.id);
    await db.course.update({ where: { id: course.id }, data: { title } });
    const learner = await createUserInTenant(tenant.id, "STUDENT");
    await db.user.update({ where: { id: learner.id }, data: { name } });
    return { learner, course };
  }

  it("uploads escaped HTML for a malicious name and title and leaves stored data raw", async () => {
    const name = "<script>alert('n')</script>";
    const title = "</title><img src=x onerror=alert(1)>";
    const { learner, course } = await seed(name, title);

    await generateCertificate(learner.id, course.id);

    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    const file = uploadFilesMock.mock.calls[0][0] as File;
    const html = await file.text();
    expect(file.type).toBe("text/html");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&#39;n&#39;)&lt;/script&gt;");
    expect(html.match(/<\/title>/g)).toHaveLength(1);

    const [user, storedCourse] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: learner.id } }),
      db.course.findUniqueOrThrow({ where: { id: course.id } }),
    ]);
    expect(user.name).toBe(name);
    expect(storedCourse.title).toBe(title);
  });

  it("falls back to the email local part when the learner has no name", async () => {
    const { learner, course } = await seed(null, "Plain Course");

    await generateCertificate(learner.id, course.id);

    const html = await (uploadFilesMock.mock.calls[0][0] as File).text();
    const local = learner.email.split("@")[0];
    expect(html).toContain(`<p class="student-name">${local}</p>`);
  });

  it("creates one certificate row pointing at the upload and keeps the cuid certificate id", async () => {
    const { learner, course } = await seed("Jane Doe", "Plain Course");

    await generateCertificate(learner.id, course.id);

    const cert = await db.certificate.findUniqueOrThrow({
      where: { userId_courseId: { userId: learner.id, courseId: course.id } },
    });
    expect(cert.certificateUrl).toMatch(/^https:\/\/utfs\.test\/cert-.+\.html$/);
    const markup = renderToStaticMarkup(sendMock.mock.calls[0][0].react as ReactElement);
    expect(markup).toContain(cert.id);
    expect(markup).toContain(cert.certificateUrl);
  });

  it("still escapes the email through React (raw values in, escaped markup out)", async () => {
    const name = "<script>alert(1)</script>";
    const title = '<img src=x onerror="alert(1)">';
    const { learner, course } = await seed(name, title);

    await generateCertificate(learner.id, course.id);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as { to: string; react: ReactElement };
    expect(payload.to).toBe(learner.email);
    const markup = renderToStaticMarkup(payload.react);
    expect(markup).not.toContain("<script>alert(1)</script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders the certificate email for normal values without entities", () => {
    const markup = renderToStaticMarkup(
      createElement(CertificateEmail, {
        name: "Jane Doe",
        courseTitle: "Intro to TypeScript",
        certUrl: "https://utfs.test/cert.html",
        certId: "cert_1",
      })
    );

    expect(markup).toContain("Jane Doe");
    expect(markup).toContain("Intro to TypeScript");
    expect(markup).toContain('href="https://utfs.test/cert.html"');
  });

  it("short-circuits when a certificate already exists (no upload, no email, no second row)", async () => {
    const { learner, course } = await seed("Jane Doe", "Plain Course");
    await db.certificate.create({
      data: {
        certificateUrl: "https://utfs.test/existing.html",
        userId: learner.id,
        courseId: course.id,
      },
    });

    await generateCertificate(learner.id, course.id);

    expect(uploadFilesMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(await db.certificate.count({ where: { userId: learner.id, courseId: course.id } })).toBe(
      1
    );
  });

  it("creates no certificate and sends no email when the upload fails", async () => {
    const { learner, course } = await seed("Jane Doe", "Plain Course");
    uploadFilesMock.mockResolvedValueOnce({ data: null, error: new Error("upload failed") });

    await generateCertificate(learner.id, course.id);

    expect(sendMock).not.toHaveBeenCalled();
    expect(await db.certificate.count({ where: { userId: learner.id, courseId: course.id } })).toBe(
      0
    );
  });
});
