import type {
  EvidenceConfidence,
  EvidenceStandingAction,
  EvidenceState,
  EvidenceType,
  EvidenceVerificationStatus,
  ProficiencyEventCause,
  Role,
  SkillProficiency,
} from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";

// Phase 30.4 — read-only capability history surfaces (docs/PHASE_30.4_DISCOVERY.md).
// SkillProficiencyEvent answers "why did proficiency change"; EvidenceStandingEvent
// answers "what happened to this evidence's standing" — kept as two distinct item
// types in one unioned feed (discovery §3/§18), never merged in meaning.

export type HistoryEventType = "PROFICIENCY_CHANGED" | "EVIDENCE_STANDING_CHANGED";

export type ProficiencyHistoryItem = {
  type: "PROFICIENCY_CHANGED";
  skillId: string;
  skillName: string;
  cause: ProficiencyEventCause;
  previousProficiency: SkillProficiency | null;
  newProficiency: SkillProficiency;
  previousConfidence: EvidenceConfidence | null;
  newConfidence: EvidenceConfidence | null;
  occurredAt: Date;
  recordedAt: Date;
  evidenceId: string | null;
  actorRole: Role | null;
  reason: string | null;
};

export type EvidenceStandingHistoryItem = {
  type: "EVIDENCE_STANDING_CHANGED";
  evidenceId: string;
  skillId: string;
  skillName: string;
  evidenceType: EvidenceType;
  sourceContext: { courseTitle: string | null };
  action: EvidenceStandingAction;
  previousVerificationStatus: EvidenceVerificationStatus;
  newVerificationStatus: EvidenceVerificationStatus;
  previousState: EvidenceState;
  newState: EvidenceState;
  actorRole: Role | null;
  actorName?: string | null; // present only for instructor/org viewers (discovery §5/§6)
  reason: string | null;
  occurredAt: Date;
};

export type HistoryItem = ProficiencyHistoryItem | EvidenceStandingHistoryItem;

export type HistoryPage = {
  items: HistoryItem[];
  nextCursor: string | null;
};

export type HistoryFilters = {
  skillId?: string;
  type?: HistoryEventType;
  from?: Date;
  to?: Date;
  /** Instructor/org only — never exposed on the learner route (discovery §14). */
  evidenceId?: string;
};

export type HistoryPageOpts = {
  cursor?: string;
  limit?: number;
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export class HistoryCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "HistoryCursorError";
  }
}

// ---------------------------------------------------------------------------
// Ordering mode — a pure function of the requested filters (discovery §12/§13).
// "seq"/"revision" are lock-serialized, proven-stable counters, used only when
// the filters already narrow the request to the one scope each is valid for.
// Every other request uses "recorded" ((recordedAt, id) keyset), the only
// column both tables share with comparable semantics.
// ---------------------------------------------------------------------------

export type OrderingMode = "seq" | "revision" | "recorded";

export function determineOrderingMode(filters: HistoryFilters): {
  mode: OrderingMode;
  tables: HistoryEventType[];
} {
  const tables: HistoryEventType[] = filters.type
    ? [filters.type]
    : ["PROFICIENCY_CHANGED", "EVIDENCE_STANDING_CHANGED"];

  if (tables.length === 1 && tables[0] === "PROFICIENCY_CHANGED" && filters.skillId) {
    return { mode: "seq", tables };
  }
  if (tables.length === 1 && tables[0] === "EVIDENCE_STANDING_CHANGED" && filters.evidenceId) {
    return { mode: "revision", tables };
  }
  return { mode: "recorded", tables };
}

// ---------------------------------------------------------------------------
// Cursor — opaque base64(JSON), one codec for this module (every view here
// shares the same authorization-independent position semantics, unlike
// instructorReport.ts/organizationReport.ts's per-file duplication, which
// exists to decouple different *files*, not different calls within one).
// The cursor's own `m` (mode) field must match the mode the current
// request's filters compute — a cursor issued for one ordering mode is
// rejected, not silently reinterpreted, against a request whose filters
// changed (discovery §13, "tied to the authorized query shape").
// ---------------------------------------------------------------------------

type SeqCursor = { m: "seq"; seq: number; id: string };
type RevisionCursor = { m: "rev"; rev: number; id: string };
type RecordedCursor = { m: "rec"; t: string; id: string };
type HistoryCursor = SeqCursor | RevisionCursor | RecordedCursor;

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

function decodeCursor(raw: string, expectedMode: OrderingMode): HistoryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new HistoryCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new HistoryCursorError();
  const p = parsed as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 64) {
    throw new HistoryCursorError();
  }

  if (expectedMode === "seq") {
    if (p.m !== "seq" || typeof p.seq !== "number" || !Number.isInteger(p.seq)) {
      throw new HistoryCursorError();
    }
    return { m: "seq", seq: p.seq, id: p.id };
  }
  if (expectedMode === "revision") {
    if (p.m !== "rev" || typeof p.rev !== "number" || !Number.isInteger(p.rev)) {
      throw new HistoryCursorError();
    }
    return { m: "rev", rev: p.rev, id: p.id };
  }
  if (p.m !== "rec" || typeof p.t !== "string") throw new HistoryCursorError();
  const t = new Date(p.t);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== p.t) throw new HistoryCursorError();
  return { m: "rec", t: p.t, id: p.id };
}

// ---------------------------------------------------------------------------
// Source-context resolution — batched (discovery §11/§20), never one query
// per row. Mirrors resolveSourceCourse's four branches (verification.ts)
// exactly, including the legacy pre-Phase-25 "QuizAttempt" sourceType, so a
// history read never silently drops legacy evidence resolveSourceCourse
// itself would still resolve. Every batch query bakes the tenant predicate
// into the query itself (never a post-fetch check) so a malformed sourceId
// can never pull another tenant's course title into this tenant's response.
// ---------------------------------------------------------------------------

type ResolvedCourse = { courseTitle: string; instructorId: string };

async function batchResolveSourceContext(
  tenantId: string,
  rows: { sourceType: string; sourceId: string | null }[]
): Promise<Map<string, ResolvedCourse>> {
  const result = new Map<string, ResolvedCourse>();
  const byType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    const set = byType.get(row.sourceType) ?? new Set<string>();
    set.add(row.sourceId);
    byType.set(row.sourceType, set);
  }

  const courseIds = byType.get("Course");
  if (courseIds && courseIds.size > 0) {
    const courses = await db.course.findMany({
      where: { id: { in: [...courseIds] }, tenantId },
      select: { id: true, title: true, instructorId: true },
    });
    for (const c of courses) {
      result.set(`Course:${c.id}`, { courseTitle: c.title, instructorId: c.instructorId });
    }
  }

  const quizIds = byType.get("Quiz");
  if (quizIds && quizIds.size > 0) {
    const quizzes = await db.quiz.findMany({
      where: { id: { in: [...quizIds] }, lesson: { section: { course: { tenantId } } } },
      select: {
        id: true,
        lesson: {
          select: {
            section: { select: { course: { select: { title: true, instructorId: true } } } },
          },
        },
      },
    });
    for (const q of quizzes) {
      const course = q.lesson.section.course;
      result.set(`Quiz:${q.id}`, { courseTitle: course.title, instructorId: course.instructorId });
    }
  }

  const attemptIds = byType.get("QuizAttempt");
  if (attemptIds && attemptIds.size > 0) {
    const attempts = await db.quizAttempt.findMany({
      where: {
        id: { in: [...attemptIds] },
        quiz: { lesson: { section: { course: { tenantId } } } },
      },
      select: {
        id: true,
        quiz: {
          select: {
            lesson: {
              select: {
                section: { select: { course: { select: { title: true, instructorId: true } } } },
              },
            },
          },
        },
      },
    });
    for (const a of attempts) {
      const course = a.quiz.lesson.section.course;
      result.set(`QuizAttempt:${a.id}`, {
        courseTitle: course.title,
        instructorId: course.instructorId,
      });
    }
  }

  const submissionIds = byType.get("AssignmentSubmission");
  if (submissionIds && submissionIds.size > 0) {
    const submissions = await db.assignmentSubmission.findMany({
      where: {
        id: { in: [...submissionIds] },
        assignment: { lesson: { section: { course: { tenantId } } } },
      },
      select: {
        id: true,
        assignment: {
          select: {
            lesson: {
              select: {
                section: { select: { course: { select: { title: true, instructorId: true } } } },
              },
            },
          },
        },
      },
    });
    for (const s of submissions) {
      const course = s.assignment.lesson.section.course;
      result.set(`AssignmentSubmission:${s.id}`, {
        courseTitle: course.title,
        instructorId: course.instructorId,
      });
    }
  }

  return result;
}

async function batchSkillNames(tenantId: string, skillIds: string[]): Promise<Map<string, string>> {
  if (skillIds.length === 0) return new Map();
  const rows = await db.skill.findMany({
    where: { id: { in: skillIds }, tenantId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Only these cause/action reasons are ever exposed — never a pass-through
 * of whatever the underlying row's `reason` column holds (discovery §6: the
 * BASELINE backfill hardcodes an internal migration-metadata string onto
 * every row it writes, which must never reach a response). */
const REASON_ALLOWED_CAUSES = new Set<ProficiencyEventCause>([
  "EVIDENCE_REVOKED",
  "EVIDENCE_REINSTATED",
]);
const REASON_ALLOWED_ACTIONS = new Set<EvidenceStandingAction>(["REVOKE", "REINSTATE"]);

// ---------------------------------------------------------------------------
// Raw row shapes and mapping
// ---------------------------------------------------------------------------

const proficiencySelect = {
  id: true,
  skillId: true,
  cause: true,
  previousProficiency: true,
  newProficiency: true,
  previousConfidence: true,
  newConfidence: true,
  occurredAt: true,
  recordedAt: true,
  evidenceId: true,
  actorRole: true,
  reason: true,
  seq: true,
} as const;

type RawProficiencyRow = {
  id: string;
  skillId: string;
  cause: ProficiencyEventCause;
  previousProficiency: SkillProficiency | null;
  newProficiency: SkillProficiency;
  previousConfidence: EvidenceConfidence | null;
  newConfidence: EvidenceConfidence | null;
  occurredAt: Date;
  recordedAt: Date;
  evidenceId: string | null;
  actorRole: Role | null;
  reason: string | null;
  seq: number;
};

const standingSelect = {
  id: true,
  evidenceId: true,
  skillId: true,
  action: true,
  previousVerificationStatus: true,
  newVerificationStatus: true,
  previousState: true,
  newState: true,
  actorRole: true,
  actorName: true,
  reason: true,
  occurredAt: true,
  recordedAt: true,
  evidenceRevision: true,
} as const;

type RawStandingRow = {
  id: string;
  evidenceId: string;
  skillId: string;
  action: EvidenceStandingAction;
  previousVerificationStatus: EvidenceVerificationStatus;
  newVerificationStatus: EvidenceVerificationStatus;
  previousState: EvidenceState;
  newState: EvidenceState;
  actorRole: Role | null;
  actorName: string | null;
  reason: string | null;
  occurredAt: Date;
  recordedAt: Date;
  evidenceRevision: number;
};

type SortKey = { recordedAt: Date; id: string };

function compareDesc(a: SortKey, b: SortKey): number {
  const t = b.recordedAt.getTime() - a.recordedAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function dateWhere(from?: Date, to?: Date): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const clause: { gte?: Date; lt?: Date } = {};
  if (from) clause.gte = from;
  if (to) clause.lt = to; // [from, to) — discovery §15
  return clause;
}

async function queryProficiencyPage(
  where: {
    tenantId: string;
    userId: string;
    skillId?: string;
    evidenceId?: string;
    evidenceIdIn?: string[];
  },
  occurredAtRange: { gte?: Date; lt?: Date } | undefined,
  mode: OrderingMode,
  cursor: HistoryCursor | undefined,
  limit: number
): Promise<RawProficiencyRow[]> {
  // evidenceIdIn (the instructor's authorized-evidence allow-list, discovery
  // §7) is applied HERE, in the query's own WHERE clause — never as a
  // post-fetch filter after the page is already cut (§14's regression).
  // `in: []` on an empty allow-list correctly matches zero rows via Prisma;
  // it also correctly excludes every BASELINE/RECALCULATED row (evidenceId
  // null never matches an `in` list), the stated, deliberate consequence
  // discovery §7 accepts.
  if (where.evidenceIdIn !== undefined && where.evidenceIdIn.length === 0) return [];
  const baseWhere: Record<string, unknown> = {
    tenantId: where.tenantId,
    userId: where.userId,
    ...(where.skillId ? { skillId: where.skillId } : {}),
    ...(where.evidenceId ? { evidenceId: where.evidenceId } : {}),
    ...(where.evidenceIdIn ? { evidenceId: { in: where.evidenceIdIn } } : {}),
    ...(occurredAtRange ? { occurredAt: occurredAtRange } : {}),
  };

  if (mode === "seq") {
    if (cursor && cursor.m === "seq") {
      baseWhere.seq = { lt: cursor.seq };
    }
    return db.skillProficiencyEvent.findMany({
      where: baseWhere,
      select: proficiencySelect,
      orderBy: [{ seq: "desc" }],
      take: limit,
    });
  }

  if (cursor && cursor.m === "rec") {
    const t = new Date(cursor.t);
    baseWhere.OR = [{ recordedAt: { lt: t } }, { recordedAt: t, id: { lt: cursor.id } }];
  }
  return db.skillProficiencyEvent.findMany({
    where: baseWhere,
    select: proficiencySelect,
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

async function queryStandingPage(
  where: {
    tenantId: string;
    userId: string;
    skillId?: string;
    evidenceIdIn?: string[];
    evidenceId?: string;
  },
  occurredAtRange: { gte?: Date; lt?: Date } | undefined,
  mode: OrderingMode,
  cursor: HistoryCursor | undefined,
  limit: number
): Promise<RawStandingRow[]> {
  if (where.evidenceIdIn !== undefined && where.evidenceIdIn.length === 0) return [];
  const baseWhere: Record<string, unknown> = {
    tenantId: where.tenantId,
    userId: where.userId,
    ...(where.skillId ? { skillId: where.skillId } : {}),
    ...(where.evidenceId ? { evidenceId: where.evidenceId } : {}),
    ...(where.evidenceIdIn ? { evidenceId: { in: where.evidenceIdIn } } : {}),
    ...(occurredAtRange ? { occurredAt: occurredAtRange } : {}),
  };

  if (mode === "revision") {
    if (cursor && cursor.m === "rev") {
      baseWhere.evidenceRevision = { lt: cursor.rev };
    }
    return db.evidenceStandingEvent.findMany({
      where: baseWhere,
      select: standingSelect,
      orderBy: [{ evidenceRevision: "desc" }],
      take: limit,
    });
  }

  if (cursor && cursor.m === "rec") {
    const t = new Date(cursor.t);
    baseWhere.OR = [{ recordedAt: { lt: t } }, { recordedAt: t, id: { lt: cursor.id } }];
  }
  return db.evidenceStandingEvent.findMany({
    where: baseWhere,
    select: standingSelect,
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

function mapProficiencyRow(
  row: RawProficiencyRow,
  skillNames: Map<string, string>
): ProficiencyHistoryItem {
  return {
    type: "PROFICIENCY_CHANGED",
    skillId: row.skillId,
    skillName: skillNames.get(row.skillId) ?? "",
    cause: row.cause,
    previousProficiency: row.previousProficiency,
    newProficiency: row.newProficiency,
    previousConfidence: row.previousConfidence,
    newConfidence: row.newConfidence,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    evidenceId: row.evidenceId,
    actorRole: row.actorRole,
    reason: REASON_ALLOWED_CAUSES.has(row.cause) ? row.reason : null,
  };
}

function mapStandingRow(
  row: RawStandingRow,
  skillNames: Map<string, string>,
  sourceContext: Map<string, ResolvedCourse>,
  evidenceSourceKey: Map<string, string>,
  includeActorName: boolean
): EvidenceStandingHistoryItem {
  const key = evidenceSourceKey.get(row.evidenceId);
  const resolved = key ? sourceContext.get(key) : undefined;
  const item: EvidenceStandingHistoryItem = {
    type: "EVIDENCE_STANDING_CHANGED",
    evidenceId: row.evidenceId,
    skillId: row.skillId,
    skillName: skillNames.get(row.skillId) ?? "",
    evidenceType: "MANUAL", // overwritten below once evidenceType map is threaded in by caller
    sourceContext: { courseTitle: resolved?.courseTitle ?? null },
    action: row.action,
    previousVerificationStatus: row.previousVerificationStatus,
    newVerificationStatus: row.newVerificationStatus,
    previousState: row.previousState,
    newState: row.newState,
    actorRole: row.actorRole,
    reason: REASON_ALLOWED_ACTIONS.has(row.action) ? row.reason : null,
    occurredAt: row.occurredAt,
  };
  if (includeActorName) item.actorName = row.actorName;
  return item;
}

/** Internal: proficiency + standing rows carry their own sort key for the merge. */
type SortedProficiency = { kind: "p"; row: RawProficiencyRow; key: SortKey };
type SortedStanding = { kind: "s"; row: RawStandingRow; key: SortKey };
type SortedRow = SortedProficiency | SortedStanding;

async function fetchAndMerge(
  tenantId: string,
  userId: string,
  filters: HistoryFilters,
  instructorEvidenceIds: string[] | undefined,
  cursorRaw: string | undefined,
  limit: number
): Promise<{ rows: SortedRow[]; nextCursor: string | null }> {
  const { mode, tables } = determineOrderingMode(filters);
  const cursor = cursorRaw ? decodeCursor(cursorRaw, mode) : undefined;
  const occurredAtRange = dateWhere(filters.from, filters.to);

  const wantsProficiency = tables.includes("PROFICIENCY_CHANGED");
  const wantsStanding = tables.includes("EVIDENCE_STANDING_CHANGED");

  // filters.evidenceId (an explicit single-id filter, discovery §14) applies
  // as an equality predicate on BOTH tables, in EVERY ordering mode — not
  // only "revision" mode, which merely happens to be the mode a single
  // evidenceId + a narrowing type filter triggers (determineOrderingMode).
  // A caller can equally ask for one evidenceId's PROFICIENCY_CHANGED events
  // (mode "recorded", tables=[PROFICIENCY_CHANGED]), and the filter must
  // still apply there. For the instructor scope, that id must itself be a
  // member of the authorized set, checked once here before any query runs —
  // never resolved by an IN() list (a single equality filter has no list to
  // intersect against), and never left to fall through unfiltered.
  if (filters.evidenceId !== undefined) {
    if (
      instructorEvidenceIds !== undefined &&
      !instructorEvidenceIds.includes(filters.evidenceId)
    ) {
      return { rows: [], nextCursor: null };
    }
  }
  // Once a single evidenceId is authorized (or no authorization scope
  // applies, e.g. the org/learner views), the broader IN() allow-list is
  // redundant and is not passed alongside the equality filter — the two
  // must never both be set on one query (queryProficiencyPage/
  // queryStandingPage write both to the same `evidenceId` where-key).
  const evidenceIdIn = filters.evidenceId === undefined ? instructorEvidenceIds : undefined;

  const [profRows, standRows] = await Promise.all([
    wantsProficiency
      ? queryProficiencyPage(
          {
            tenantId,
            userId,
            skillId: filters.skillId,
            evidenceId: filters.evidenceId,
            evidenceIdIn,
          },
          occurredAtRange,
          mode,
          cursor,
          limit + 1
        )
      : Promise.resolve([]),
    wantsStanding
      ? queryStandingPage(
          {
            tenantId,
            userId,
            skillId: filters.skillId,
            evidenceId: filters.evidenceId,
            evidenceIdIn,
          },
          occurredAtRange,
          mode,
          cursor,
          limit + 1
        )
      : Promise.resolve([]),
  ]);

  const merged: SortedRow[] = [
    ...profRows.map(
      (row): SortedProficiency => ({
        kind: "p",
        row,
        key: { recordedAt: row.recordedAt, id: row.id },
      })
    ),
    ...standRows.map(
      (row): SortedStanding => ({ kind: "s", row, key: { recordedAt: row.recordedAt, id: row.id } })
    ),
  ];

  if (mode === "seq") {
    merged.sort((a, b) => (b as SortedProficiency).row.seq - (a as SortedProficiency).row.seq);
  } else if (mode === "revision") {
    merged.sort(
      (a, b) =>
        (b as SortedStanding).row.evidenceRevision - (a as SortedStanding).row.evidenceRevision
    );
  } else {
    merged.sort((a, b) => compareDesc(a.key, b.key));
  }

  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    if (mode === "seq") {
      nextCursor = encodeCursor({
        m: "seq",
        seq: (last as SortedProficiency).row.seq,
        id: last.row.id,
      });
    } else if (mode === "revision") {
      nextCursor = encodeCursor({
        m: "rev",
        rev: (last as SortedStanding).row.evidenceRevision,
        id: last.row.id,
      });
    } else {
      nextCursor = encodeCursor({
        m: "rec",
        t: last.key.recordedAt.toISOString(),
        id: last.row.id,
      });
    }
  }

  return { rows: page, nextCursor };
}

async function toHistoryItems(
  tenantId: string,
  rows: SortedRow[],
  includeActorName: boolean
): Promise<HistoryItem[]> {
  const skillIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const r of rows) {
    skillIds.add(r.row.skillId);
    if (r.kind === "s") evidenceIds.add(r.row.evidenceId);
  }

  const [skillNames, evidenceRows] = await Promise.all([
    batchSkillNames(tenantId, [...skillIds]),
    evidenceIds.size > 0
      ? db.skillEvidence.findMany({
          where: { id: { in: [...evidenceIds] }, tenantId },
          select: { id: true, type: true, sourceType: true, sourceId: true },
        })
      : Promise.resolve([]),
  ]);

  const evidenceType = new Map(evidenceRows.map((e) => [e.id, e.type]));
  const evidenceSourceKey = new Map(
    evidenceRows.map((e) => [e.id, `${e.sourceType}:${e.sourceId}`])
  );
  const sourceContext = await batchResolveSourceContext(
    tenantId,
    evidenceRows.map((e) => ({ sourceType: e.sourceType, sourceId: e.sourceId }))
  );

  return rows.map((r) => {
    if (r.kind === "p") return mapProficiencyRow(r.row, skillNames);
    const item = mapStandingRow(
      r.row,
      skillNames,
      sourceContext,
      evidenceSourceKey,
      includeActorName
    );
    item.evidenceType = evidenceType.get(r.row.evidenceId) ?? "MANUAL";
    return item;
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Learner's own capability history — self-scoped only, no userId parameter
 * to forge (discovery §4): tenantId and userId come only from ctx. */
export async function getLearnerHistory(
  ctx: AuthContext & { tenantId: string },
  filters: HistoryFilters,
  opts: HistoryPageOpts = {}
): Promise<HistoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { rows, nextCursor } = await fetchAndMerge(
    ctx.tenantId,
    ctx.userId,
    filters,
    undefined,
    opts.cursor,
    limit
  );
  const items = await toHistoryItems(ctx.tenantId, rows, false);
  return { items, nextCursor };
}

/**
 * Instructor's owned-evidence-scoped history for one learner (discovery §7).
 * Returns null when the learner is not authorized for this instructor (no
 * shared enrollment in an owned course) or is soft-deleted — the caller
 * maps both to the same 404, never distinguishing why (matching
 * getInstructorLearnerRoles's own convention).
 *
 * Authorization is resolved into a concrete evidenceId allow-list BEFORE any
 * event query runs, and that allow-list is baked into the event queries'
 * own WHERE clause (evidenceId IN (...)) — never fetched broadly and
 * filtered after the page is cut (discovery §7/§14, the defect this
 * revision's own discovery pass found and fixed in design).
 */
export async function getInstructorLearnerHistory(
  ctx: AuthContext & { tenantId: string },
  learnerId: string,
  filters: HistoryFilters,
  opts: HistoryPageOpts = {}
): Promise<HistoryPage | null> {
  const owns = await db.enrollment.findFirst({
    where: { userId: learnerId, course: { instructorId: ctx.userId, tenantId: ctx.tenantId } },
    select: { id: true },
  });
  if (!owns) return null;

  const learner = await db.user.findFirst({
    where: { id: learnerId, tenantId: ctx.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!learner) return null;

  const evidenceRows = await db.skillEvidence.findMany({
    where: { tenantId: ctx.tenantId, userId: learnerId },
    select: { id: true, sourceType: true, sourceId: true },
  });
  const sourceContext = await batchResolveSourceContext(ctx.tenantId, evidenceRows);
  const authorizedEvidenceIds = evidenceRows
    .filter((e) => {
      const resolved = sourceContext.get(`${e.sourceType}:${e.sourceId}`);
      return resolved !== undefined && resolved.instructorId === ctx.userId;
    })
    .map((e) => e.id);

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // authorizedEvidenceIds is threaded into every underlying query's own
  // WHERE clause (queryProficiencyPage/queryStandingPage's evidenceIdIn) —
  // an empty list short-circuits each query to zero rows before it even
  // runs. Nothing here re-filters after the fact: the page fetchAndMerge
  // returns is already the correctly-sized, fully-authorized page (discovery
  // §7/§14 — the exact defect this phase's own discovery pass found and
  // designed around).
  const { rows, nextCursor } = await fetchAndMerge(
    ctx.tenantId,
    learnerId,
    filters,
    authorizedEvidenceIds,
    opts.cursor,
    limit
  );
  const items = await toHistoryItems(ctx.tenantId, rows, true);
  return { items, nextCursor };
}

/**
 * ORG_ADMIN's tenant-wide history for one learner (discovery §8) — no
 * course-ownership narrowing, but the same soft-delete exclusion as the
 * instructor scope (contract E6).
 */
export async function getOrgLearnerHistory(
  ctx: AuthContext & { tenantId: string },
  learnerId: string,
  filters: HistoryFilters,
  opts: HistoryPageOpts = {}
): Promise<HistoryPage | null> {
  const learner = await db.user.findFirst({
    where: { id: learnerId, tenantId: ctx.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!learner) return null;

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { rows, nextCursor } = await fetchAndMerge(
    ctx.tenantId,
    learnerId,
    filters,
    undefined,
    opts.cursor,
    limit
  );
  const items = await toHistoryItems(ctx.tenantId, rows, true);
  return { items, nextCursor };
}
