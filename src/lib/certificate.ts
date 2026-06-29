import { nanoid } from "nanoid";
import { UTApi } from "uploadthing/server";

import { db } from "./db";
import { resend } from "./resend";

const utapi = new UTApi();

function buildCertHtml(params: {
  certId: string;
  studentName: string;
  courseTitle: string;
  issuedDate: string;
}): string {
  const { certId, studentName, courseTitle, issuedDate } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Certificate of Completion — ${courseTitle}</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Geist:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Geist', system-ui, sans-serif;
      background: #f5f5f6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      -webkit-font-smoothing: antialiased;
    }
    .cert {
      background: #ffffff;
      border: 1px solid #e5e5e7;
      border-top: 4px solid #4f6ef7;
      border-radius: 16px;
      padding: 64px;
      max-width: 820px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.07), 0 4px 6px -4px rgba(0,0,0,0.05);
    }
    .wordmark {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #4f6ef7;
      letter-spacing: -0.02em;
      margin-bottom: 48px;
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #737380;
      margin-bottom: 24px;
    }
    .certifies-that {
      font-size: 14px;
      color: #737380;
      margin-bottom: 12px;
    }
    .student-name {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 36px;
      font-weight: 700;
      color: #0f0f10;
      letter-spacing: -0.02em;
      line-height: 1.15;
      margin-bottom: 20px;
    }
    .has-completed {
      font-size: 14px;
      color: #737380;
      margin-bottom: 16px;
    }
    .course-title {
      display: inline-block;
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 22px;
      font-weight: 600;
      color: #4f6ef7;
      border-bottom: 2px solid #4f6ef7;
      padding-bottom: 6px;
      margin-bottom: 48px;
      max-width: 600px;
      line-height: 1.3;
    }
    .divider {
      border: none;
      border-top: 1px solid #e5e5e7;
      margin: 0 0 32px 0;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .meta-item { text-align: center; flex: 1; }
    .meta-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #a8a8b0;
      margin-bottom: 4px;
    }
    .meta-value {
      font-size: 13px;
      font-weight: 600;
      color: #3d3d3f;
      font-family: 'Space Grotesk', system-ui, sans-serif;
    }
  </style>
</head>
<body>
  <div class="cert">
    <div class="wordmark">✦ Lumio</div>
    <p class="eyebrow">Certificate of Completion</p>
    <p class="certifies-that">This is to certify that</p>
    <p class="student-name">${studentName}</p>
    <p class="has-completed">has successfully completed the course</p>
    <p class="course-title">${courseTitle}</p>
    <hr class="divider">
    <div class="meta">
      <div class="meta-item">
        <div class="meta-label">Issued on</div>
        <div class="meta-value">${issuedDate}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Certificate ID</div>
        <div class="meta-value">${certId}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Issued by</div>
        <div class="meta-value">lumio.io</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildEmailHtml(params: {
  studentName: string;
  courseTitle: string;
  certUrl: string;
  certId: string;
}): string {
  const { studentName, courseTitle, certUrl, certId } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:system-ui,sans-serif;background:#f5f5f6;padding:32px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;border:1px solid #e5e5e7;padding:40px;">
    <p style="font-size:22px;font-weight:700;color:#4f6ef7;margin:0 0 24px;">✦ Lumio</p>
    <h1 style="font-size:22px;font-weight:700;color:#0f0f10;margin:0 0 12px;letter-spacing:-0.02em;">
      Congratulations, ${studentName}!
    </h1>
    <p style="font-size:15px;color:#3d3d3f;margin:0 0 8px;">
      You've successfully completed:
    </p>
    <p style="font-size:17px;font-weight:600;color:#4f6ef7;margin:0 0 28px;">
      ${courseTitle}
    </p>
    <p style="font-size:14px;color:#737380;margin:0 0 24px;">
      Your certificate is ready. You can view and share it at any time using the link below.
    </p>
    <a href="${certUrl}"
       style="display:inline-block;background:#4f6ef7;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
      View Certificate →
    </a>
    <p style="font-size:12px;color:#a8a8b0;margin:24px 0 0;">
      Certificate ID: ${certId}
    </p>
  </div>
</body>
</html>`;
}

export async function generateCertificate(
  userId: string,
  courseId: string
): Promise<void> {
  const existing = await db.certificate.findUnique({
    where: { userId_courseId: { userId, courseId } },
    select: { id: true },
  });
  if (existing) return;

  const [user, course] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
    db.course.findUnique({
      where: { id: courseId },
      select: { title: true },
    }),
  ]);
  if (!user || !course) return;

  const certId = nanoid(12);
  const issuedAt = new Date();
  const issuedDate = issuedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const studentName = user.name ?? user.email.split("@")[0];

  const html = buildCertHtml({ certId, studentName, courseTitle: course.title, issuedDate });

  const file = new File([html], `cert-${certId}.html`, { type: "text/html" });
  const result = await utapi.uploadFiles(file);

  if (result.error || !result.data?.ufsUrl) return;

  const cert = await db.certificate.create({
    data: {
      certificateUrl: result.data.ufsUrl,
      userId,
      courseId,
    },
  });

  await resend.emails.send({
    from: "Lumio <no-reply@lumio.io>",
    to: user.email,
    subject: `You've completed "${course.title}" — your certificate is ready`,
    html: buildEmailHtml({
      studentName,
      courseTitle: course.title,
      certUrl: cert.certificateUrl,
      certId: cert.id,
    }),
  });
}
