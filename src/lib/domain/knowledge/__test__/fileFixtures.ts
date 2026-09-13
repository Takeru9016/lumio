import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";

const FIXTURES_DIR = join(__dirname, "fixtures");

/** A real, valid PDF (generated via a system print filter, not hand-rolled)
 * whose extracted text comfortably clears the 50-character minimum. */
export function readValidPdfFixture(): Buffer {
  return readFileSync(join(FIXTURES_DIR, "valid.pdf"));
}

/** A real, valid PDF whose only text is "short" — under the 50-character minimum. */
export function readTooShortPdfFixture(): Buffer {
  return readFileSync(join(FIXTURES_DIR, "tooshort.pdf"));
}

/** A PDF with a valid %PDF- header but a body truncated mid-stream — a
 * genuine parse failure through the real parser, not a mocked one. */
export function buildMalformedPdf(): Buffer {
  const valid = readValidPdfFixture();
  return valid.subarray(0, Math.floor(valid.length * 0.4));
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** Minimal, pure-Node (no external tool) ZIP writer — used to build small,
 * deterministic, in-memory DOCX fixtures without checking in binary blobs
 * or depending on a platform-specific converter. */
function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    localParts.push(local);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(centralStart),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`;
}

/** A real, valid minimal DOCX whose body is the given text, repeated enough
 * to clear the 50-character minimum by default. */
export function buildValidDocx(text = "Hello knowledge world. ".repeat(4)): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS_XML, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml(text), "utf8") },
  ]);
}

/** A syntactically valid ZIP (correct PK signature) that is missing
 * `[Content_Types].xml` entirely — must be rejected as not-a-DOCX by magic
 * detection before ever reaching mammoth. */
export function buildZipWithoutContentTypes(): Buffer {
  return buildZip([{ name: "readme.txt", data: Buffer.from("not a docx", "utf8") }]);
}

/** A ZIP that declares [Content_Types].xml (passes format detection) but
 * whose word/document.xml is corrupt XML — a genuine parse failure through
 * the real mammoth parser. */
export function buildMalformedDocx(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS_XML, "utf8") },
    { name: "word/document.xml", data: Buffer.from("<w:document><unclosed", "utf8") },
  ]);
}

/** Legacy binary .doc signature (OLE Compound File) — must never be mistaken
 * for either PDF or DOCX. */
export const LEGACY_DOC_BYTES = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
]);

export const RANDOM_BYTES = Buffer.from("just some plain bytes, not a document at all");
