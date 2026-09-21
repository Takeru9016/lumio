import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?)$/.test(name) && !/\.test\.ts$/.test(name) && !full.includes("__test__")
      ? [full]
      : [];
  });
}

const UI_DIRS = [
  "components/learning-path",
  "components/learner-path",
  "components/org/paths",
  "app/(student)/paths",
  "app/(org)/org/paths",
];

const uiFiles = UI_DIRS.flatMap((d) => sourceFiles(path.join(root, d)));
/** The code only: comments may name an endpoint or a rule without using it. */
const read = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const rel = (file: string) => path.relative(root, file);

describe("learning path UI boundary", () => {
  it("finds the screens it is guarding", () => {
    expect(uiFiles.length).toBeGreaterThan(20);
  });

  it("never reaches the database from a screen", () => {
    for (const file of uiFiles) {
      const source = read(file);
      expect(source, rel(file)).not.toMatch(/@\/lib\/db\b|@\/generated\/prisma|@prisma\/client/);
      expect(source, rel(file)).not.toMatch(/\bdb\.[a-z]+\.[a-z]+\(|\bprisma\./);
    }
  });

  it("holds no request URLs and does no fetching of its own: the clients own the API", () => {
    for (const file of uiFiles) {
      const source = read(file);
      expect(source, rel(file)).not.toMatch(/["'`]\/api\//);
      expect(source, rel(file)).not.toMatch(/\bfetch\(/);
    }
  });

  it("imports no domain rule: only constants and types cross from the domain", () => {
    const allowedTypeOnly = /^import type /;
    for (const file of uiFiles) {
      for (const line of read(file)
        .split("\n")
        .filter((l) => /from "@\/lib\/domain\//.test(l))) {
        const constants = /@\/lib\/domain\/learning-path\/constants"/.test(line);
        expect(constants || allowedTypeOnly.test(line.trim()), `${rel(file)}: ${line}`).toBe(true);
      }
    }
  });

  it("does not restate the rules the server owns", () => {
    for (const file of uiFiles) {
      const source = read(file);
      expect(source, rel(file)).not.toMatch(
        /LEARNING_PATH_MAX_COURSES|\b20 courses\b|\bMAX_COURSES\b/
      );
      expect(source, rel(file)).not.toMatch(
        /isEnforceablePrerequisite|assertCoursePrerequisitesMet/
      );
      expect(source, rel(file)).not.toMatch(/completed\s*\/\s*\(|Math\.round\(/);
    }
  });

  it("reads the courses to choose from through the one server-side function, only on the editor page", () => {
    const users = uiFiles.filter((f) => /org-path-course-choices/.test(read(f))).map(rel);
    expect(users).toEqual(["app/(org)/org/paths/[pathId]/page.tsx"]);
  });

  it("keeps the learner list and detail free of any per-course request", () => {
    const learner = uiFiles.filter((f) => f.includes("learner-path") || f.includes("(student)"));
    for (const file of learner) {
      const source = read(file);
      expect(source, rel(file)).not.toMatch(/\/api\/courses|\.map\([^)]*(load|fetch)/);
    }
  });

  it("does not touch the AI learning path surface", () => {
    for (const file of uiFiles) {
      expect(read(file), rel(file)).not.toMatch(/LearningPathClient|["'`]\/learning-path["'`/]/);
    }
  });
});
