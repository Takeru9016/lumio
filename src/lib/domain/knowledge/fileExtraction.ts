export const SUPPORTED_MIME_TYPES = {
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES];

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MIN_EXTRACTED_TEXT_LENGTH = 50;
export const MAX_EXTRACTED_TEXT_LENGTH = 50_000;
const PARSE_TIMEOUT_MS = 10_000;

export type FileExtractionErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "MALFORMED_FILE"
  | "PARSE_FAILED"
  | "PARSE_TIMEOUT"
  | "TOO_SHORT"
  | "TOO_LONG";

export class FileExtractionError extends Error {
  constructor(
    public code: FileExtractionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FileExtractionError";
  }
}

/**
 * Detects the file's real format from its bytes, ignoring any
 * client-supplied MIME type or filename extension. PDF: magic bytes
 * `%PDF-`. DOCX: ZIP local-file-header signature `PK\x03\x04` plus the
 * literal `[Content_Types].xml` entry name, which every DOCX (and no
 * non-Office ZIP) must contain — checked via a raw substring search rather
 * than a full ZIP parse, since ZIP stores entry names as uncompressed plain
 * bytes right after each local file header. Deliberately does not add a ZIP
 * library as a direct dependency for this cheap, sufficient check.
 */
function detectFormat(bytes: Buffer): SupportedMimeType | null {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return SUPPORTED_MIME_TYPES.PDF;
  }
  const isZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  if (isZip && bytes.includes(Buffer.from("[Content_Types].xml", "latin1"))) {
    return SUPPORTED_MIME_TYPES.DOCX;
  }
  return null;
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value;
}

/**
 * KNOWN LIMITATION (contract deviation, user-approved): the locked contract
 * called for a genuinely enforceable timeout via a node:worker_threads
 * Worker (real .terminate() cancellation), because unpdf/mammoth expose no
 * cancellation API of their own and both parse CPU-bound on whichever
 * thread calls them. That approach was implemented and empirically failed —
 * `next build` under this repo's Next 16 + Turbopack cannot resolve a
 * worker_threads entry file referenced via `new URL(..., import.meta.url)`
 * from a Node route handler (confirmed via a real production build, not
 * assumed) — so it was reverted rather than shipped as an untested,
 * possibly-broken-in-production mechanism.
 *
 * What ships instead: a plain Promise.race. This stops WAITING at 10s and
 * rejects the caller's promise, but does NOT stop the underlying parse —
 * unpdf/mammoth keep running CPU-bound on this same request's event loop
 * until they finish or error on their own. A pathological file cannot be
 * force-terminated at the 10s mark; the residual bound is the 16MB input
 * cap (§11) and Vercel's request/function timeout, not this constant.
 * This is a disclosed, accepted gap — not silently claimed as a hard
 * timeout — pending a build-compatible worker-isolation mechanism in a
 * future phase.
 */
function withSoftTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FileExtractionError("PARSE_TIMEOUT", "File parsing exceeded the time limit"));
    }, PARSE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export type ExtractKnowledgeTextResult = {
  text: string;
  mimeType: SupportedMimeType;
};

/**
 * Validates the downloaded file's real format from its bytes, extracts
 * plain text, and enforces the Phase 16 contract's extraction-length
 * bounds. Throws FileExtractionError (never a raw parser exception) for
 * every rejection case — callers must never create a KnowledgeDocument row
 * when this throws. See withSoftTimeout's doc comment for the disclosed
 * timeout-enforcement limitation.
 */
export async function extractKnowledgeText(bytes: Buffer): Promise<ExtractKnowledgeTextResult> {
  const mimeType = detectFormat(bytes);
  if (!mimeType) {
    throw new FileExtractionError("UNSUPPORTED_FORMAT", "File is not a valid PDF or DOCX document");
  }

  let rawText: string;
  try {
    const parse =
      mimeType === SUPPORTED_MIME_TYPES.PDF ? extractPdfText(bytes) : extractDocxText(bytes);
    rawText = await withSoftTimeout(parse);
  } catch (err) {
    if (err instanceof FileExtractionError) throw err;
    throw new FileExtractionError("PARSE_FAILED", "Unable to parse file contents");
  }

  const text = normalize(rawText);

  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
    throw new FileExtractionError("TOO_SHORT", "No extractable text found in this file");
  }
  if (text.length > MAX_EXTRACTED_TEXT_LENGTH) {
    throw new FileExtractionError(
      "TOO_LONG",
      "File content is too long — please split it into multiple documents"
    );
  }

  return { text, mimeType };
}
