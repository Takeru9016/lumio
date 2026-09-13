import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMalformedDocx,
  buildMalformedPdf,
  buildValidDocx,
  buildZipWithoutContentTypes,
  LEGACY_DOC_BYTES,
  RANDOM_BYTES,
  readTooShortPdfFixture,
  readValidPdfFixture,
} from "@/lib/domain/knowledge/__test__/fileFixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.doUnmock("unpdf");
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Real end-to-end tests — run through the actual unpdf/mammoth parsers, no
// mocking, to prove extraction and format detection genuinely work.
// ---------------------------------------------------------------------------
describe("extractKnowledgeText — real parser", () => {
  it("extracts text from a valid PDF", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    const result = await extractKnowledgeText(readValidPdfFixture());
    expect(result.mimeType).toBe("application/pdf");
    expect(result.text.length).toBeGreaterThanOrEqual(50);
    expect(result.text).toContain("fifty");
  });

  it("extracts text from a valid DOCX", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    const result = await extractKnowledgeText(buildValidDocx());
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(result.text).toContain("Hello knowledge world");
  });

  it("rejects a malformed PDF (valid header, truncated body) as a parse failure", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(buildMalformedPdf())).rejects.toMatchObject({
      code: "PARSE_FAILED",
    });
  });

  it("rejects a malformed DOCX (valid zip/content-types, corrupt document.xml) as a parse failure", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(buildMalformedDocx())).rejects.toMatchObject({
      code: "PARSE_FAILED",
    });
  });

  it("rejects a .doc (legacy OLE) signature as unsupported format", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(LEGACY_DOC_BYTES)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects arbitrary bytes with no valid magic number", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(RANDOM_BYTES)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects a ZIP that is missing [Content_Types].xml (not a DOCX)", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(buildZipWithoutContentTypes())).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects extracted text below the 50-character minimum, without truncating/accepting it", async () => {
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(readTooShortPdfFixture())).rejects.toMatchObject({
      code: "TOO_SHORT",
    });
  });
});

// ---------------------------------------------------------------------------
// Mocked-parser tests for outcomes that are impractical/non-deterministic to
// exercise with a real file (a >50,000-char result, a parser hang). unpdf's
// own extractText/getDocumentProxy are mocked here — see fileExtraction.ts's
// withSoftTimeout doc comment for why this is a Promise.race "stop waiting"
// timeout, not a genuine cancellation: these tests verify exactly that
// disclosed behavior (the caller's promise rejects at 10s; nothing here
// claims the underlying parse is actually terminated).
// ---------------------------------------------------------------------------
describe("extractKnowledgeText — mocked parser boundary", () => {
  it("rejects extracted text above the 50,000-character maximum, without truncating it", async () => {
    vi.doMock("unpdf", () => ({
      getDocumentProxy: vi.fn().mockResolvedValue({}),
      extractText: vi.fn().mockResolvedValue({ text: "x".repeat(50_001) }),
    }));
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(readValidPdfFixture())).rejects.toMatchObject({
      code: "TOO_LONG",
    });
  });

  it("surfaces a parser rejection as PARSE_FAILED, never a raw parser exception", async () => {
    vi.doMock("unpdf", () => ({
      getDocumentProxy: vi.fn().mockRejectedValue(new Error("pdfjs internal stack trace")),
      extractText: vi.fn(),
    }));
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    await expect(extractKnowledgeText(readValidPdfFixture())).rejects.toThrow(
      "Unable to parse file contents"
    );
  });

  it("stops waiting at the 10s deadline when the parser never resolves (disclosed soft-timeout behavior)", async () => {
    vi.useFakeTimers();
    vi.doMock("unpdf", () => ({
      getDocumentProxy: vi.fn(() => new Promise(() => {})), // never resolves
      extractText: vi.fn(),
    }));
    const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
    const promise = extractKnowledgeText(readValidPdfFixture());
    const expectation = expect(promise).rejects.toMatchObject({ code: "PARSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
  });
});
