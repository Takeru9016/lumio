import { z } from "zod";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { db } from "@/lib/db";
import {
  extractKnowledgeText,
  FileExtractionError,
  MAX_FILE_BYTES,
  SUPPORTED_MIME_TYPES,
} from "@/lib/domain/knowledge/fileExtraction";
import { createTextDocument, indexDocument } from "@/lib/domain/knowledge/ingestion";
import { findOrCreateCreatorSource, grantOwnerAccess } from "@/lib/domain/knowledge/management";

// .strict() rejects tenantId/userId/createdByUserId/createdByRole/sourceId
// outright, matching the existing text-creation route — every identity
// field this route ever writes is server-derived from the resolved
// AuthContext, never accepted from the request body.
const uploadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    visibility: z.enum(["TENANT", "RESTRICTED"]).optional(),
    file: z
      .object({
        url: z.string().min(1).max(2000),
        name: z.string().min(1).max(1000),
        size: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const ALLOWED_UPLOAD_HOSTS_SUFFIX = ".ufs.sh";
const ALLOWED_UPLOAD_HOSTS_EXACT = new Set(["ufs.sh", "utfs.io"]);

/**
 * The upload URL comes from the browser and is therefore untrusted — this
 * must never become an arbitrary server-side fetch primitive. Only a real
 * Uploadthing-hosted origin is accepted: HTTPS only, host is exactly
 * "ufs.sh"/"utfs.io" or a subdomain of "ufs.sh" (Uploadthing's actual file
 * CDN domains — the appId-specific subdomain is not something an attacker
 * can control). Any other host — including localhost, private/loopback/
 * link-local IPs, or a lookalike host — is rejected before any network call.
 */
function isAllowedUploadthingUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (ALLOWED_UPLOAD_HOSTS_EXACT.has(host)) return url;
  if (
    host.endsWith(ALLOWED_UPLOAD_HOSTS_SUFFIX) &&
    host.length > ALLOWED_UPLOAD_HOSTS_SUFFIX.length
  ) {
    return url;
  }
  return null;
}

/** Strips control characters and path-traversal sequences, truncates to
 * match the existing `title` field's cap — display-only, never used to
 * construct a filesystem path or storage key. */
function normalizeFilename(name: string): string {
  const stripped = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control chars from an untrusted filename
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\.\.\//g, "")
    .replace(/^\/+/, "");
  return stripped.slice(0, 200) || "upload";
}

type DownloadResult = { buffer: Buffer } | { error: "TOO_LARGE" | "FETCH_FAILED" | "REDIRECTED" };

/**
 * Downloads the file server-side with redirects disabled (never blindly
 * follow — a redirect to a non-allowlisted host would defeat the host
 * check above) and a hard byte ceiling enforced while streaming, so a
 * missing or dishonest Content-Length cannot bypass the 16MB limit.
 */
async function downloadFile(url: URL): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch {
    return { error: "FETCH_FAILED" };
  }

  if (response.status >= 300 && response.status < 400) {
    return { error: "REDIRECTED" };
  }
  if (!response.ok || !response.body) {
    return { error: "FETCH_FAILED" };
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_FILE_BYTES) {
    return { error: "TOO_LARGE" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel();
      return { error: "TOO_LARGE" };
    }
    chunks.push(value);
  }

  return { buffer: Buffer.concat(chunks) };
}

function extensionFor(name: string): string {
  const match = /\.[a-z0-9]+$/i.exec(name);
  return match ? match[0].toLowerCase() : "";
}

const EXTENSION_BY_MIME: Record<string, string> = {
  [SUPPORTED_MIME_TYPES.PDF]: ".pdf",
  [SUPPORTED_MIME_TYPES.DOCX]: ".docx",
};

/**
 * Phase 16 — staff Knowledge file upload. INSTRUCTOR and ORG_ADMIN only
 * (SUPER_ADMIN explicitly denied, matching Phase 14's locked role
 * correction). Re-downloads the Uploadthing-hosted file server-side
 * (never trusting the client-declared size/MIME/filename), validates its
 * real format from the downloaded bytes, extracts plain text, then feeds
 * that text into the existing, unmodified Phase 14
 * createTextDocument()/indexDocument() pipeline — no second ingestion path.
 */
export async function POST(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR", "ORG_ADMIN"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = uploadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { title, visibility, file } = parsed.data;

  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "File too large" }, { status: 413 });
  }

  const allowedUrl = isAllowedUploadthingUrl(file.url);
  if (!allowedUrl) {
    return Response.json({ error: "Invalid file URL" }, { status: 400 });
  }

  const declaredExtension = extensionFor(file.name);
  if (declaredExtension !== ".pdf" && declaredExtension !== ".docx") {
    return Response.json({ error: "Unsupported file type" }, { status: 422 });
  }

  const download = await downloadFile(allowedUrl);
  if ("error" in download) {
    if (download.error === "TOO_LARGE") {
      return Response.json({ error: "File too large" }, { status: 413 });
    }
    return Response.json({ error: "Upload failed — please try again" }, { status: 502 });
  }

  let extraction: Awaited<ReturnType<typeof extractKnowledgeText>>;
  try {
    extraction = await extractKnowledgeText(download.buffer);
  } catch (err) {
    if (err instanceof FileExtractionError) {
      return Response.json({ error: extractionErrorMessage(err.code) }, { status: 422 });
    }
    console.error("[knowledge] Unexpected extraction error", err);
    return Response.json({ error: "Upload failed — please try again" }, { status: 500 });
  }

  // Belt-and-suspenders AND check (contract §6): the declared extension
  // must also match the format actually detected from the bytes — a PDF
  // renamed to .docx (or vice versa) is rejected even though its magic
  // bytes alone would otherwise be extractable.
  if (EXTENSION_BY_MIME[extraction.mimeType] !== declaredExtension) {
    return Response.json({ error: "Unsupported file type" }, { status: 422 });
  }

  try {
    const source = await findOrCreateCreatorSource(ctx);
    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title,
      textContent: extraction.text,
      mimeType: extraction.mimeType,
      url: allowedUrl.toString(),
      visibility: visibility ?? "TENANT",
      metadata: {
        createdByUserId: ctx.userId,
        createdByRole: ctx.role,
        file: {
          provider: "uploadthing",
          originalName: normalizeFilename(file.name),
          sizeBytes: download.buffer.byteLength,
        },
      },
    });

    if (document.visibility === "RESTRICTED") {
      await grantOwnerAccess(ctx, document.id);
    }

    try {
      await indexDocument(ctx, document.id);
    } catch (err) {
      // indexDocument already persisted status: "ERROR" internally before
      // rethrowing — nothing further to do here except let the refetch
      // below pick up that outcome, matching the existing text-creation
      // route's behavior exactly.
      console.error("[knowledge] Indexing failed for uploaded document", document.id, err);
    }

    const finalDocument = await db.knowledgeDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { id: true, title: true, status: true, visibility: true, createdAt: true },
    });

    return Response.json({ document: finalDocument });
  } catch (err) {
    console.error("[knowledge] Failed to create document from upload", err);
    return Response.json({ error: "Failed to create document" }, { status: 500 });
  }
}

function extractionErrorMessage(code: FileExtractionError["code"]): string {
  switch (code) {
    case "UNSUPPORTED_FORMAT":
      return "File is not a valid PDF or DOCX document";
    case "TOO_SHORT":
      return "No extractable text found in this file";
    case "TOO_LONG":
      return "File content is too long — please split it into multiple documents";
    case "PARSE_TIMEOUT":
      return "File took too long to process — please try a smaller file";
    default:
      return "Unable to process this file";
  }
}
