import { describe, expect, it } from "vitest";
import type { SkillProficiency } from "@/generated/prisma/client";
import { PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";
import {
  CONFIDENCE_FRESHNESS_WINDOW_DAYS,
  ceilingFor,
  confidenceFor,
  doesEvidenceContribute,
  type EvidenceStanding,
  isAssessable,
  isEvidenceValid,
  MAX_GRANTABLE_LEVEL,
  projectProficiency,
} from "@/lib/domain/capability/proficiencyPolicy";

const asOf = new Date("2026-09-22T00:00:00Z");

function evidence(overrides: Partial<EvidenceStanding> = {}): EvidenceStanding {
  return {
    verificationStatus: "UNVERIFIED",
    state: "ACTIVE",
    validUntil: null,
    ...overrides,
  };
}

describe("ceilingFor — Policy 1, V1-compatible", () => {
  it("VERIFIED grants INTERMEDIATE", () => {
    expect(ceilingFor({ verificationStatus: "VERIFIED" })).toBe("INTERMEDIATE");
  });
  it("UNVERIFIED grants BEGINNER", () => {
    expect(ceilingFor({ verificationStatus: "UNVERIFIED" })).toBe("BEGINNER");
  });
  it("PENDING grants BEGINNER — treated explicitly, identically to UNVERIFIED", () => {
    expect(ceilingFor({ verificationStatus: "PENDING" })).toBe("BEGINNER");
  });
  it("REJECTED grants NONE", () => {
    expect(ceilingFor({ verificationStatus: "REJECTED" })).toBe("NONE");
  });
  it("never exceeds INTERMEDIATE for any verification status Policy 1 knows about", () => {
    const statuses = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"] as const;
    for (const verificationStatus of statuses) {
      expect(PROFICIENCY_ORDER.indexOf(ceilingFor({ verificationStatus }))).toBeLessThanOrEqual(
        PROFICIENCY_ORDER.indexOf("INTERMEDIATE")
      );
    }
  });
});

describe("isEvidenceValid — contract §B2", () => {
  it("ACTIVE, non-rejected, no expiry -> valid", () => {
    expect(isEvidenceValid(evidence(), asOf)).toBe(true);
  });
  it.each(["SUPERSEDED", "EXPIRED", "REVOKED"] as const)("state=%s -> invalid", (state) => {
    expect(isEvidenceValid(evidence({ state }), asOf)).toBe(false);
  });
  it("REJECTED is invalid even while ACTIVE", () => {
    expect(isEvidenceValid(evidence({ verificationStatus: "REJECTED" }), asOf)).toBe(false);
  });
  it("validUntil in the past -> invalid", () => {
    const past = new Date(asOf.getTime() - 1000);
    expect(isEvidenceValid(evidence({ validUntil: past }), asOf)).toBe(false);
  });
  it("validUntil exactly at asOf -> invalid (expiry is a hard boundary, not inclusive)", () => {
    expect(isEvidenceValid(evidence({ validUntil: asOf }), asOf)).toBe(false);
  });
  it("validUntil in the future -> valid", () => {
    const future = new Date(asOf.getTime() + 1000);
    expect(isEvidenceValid(evidence({ validUntil: future }), asOf)).toBe(true);
  });
  it("validUntil null -> never expires", () => {
    expect(isEvidenceValid(evidence({ validUntil: null }), asOf)).toBe(true);
  });
});

describe("doesEvidenceContribute — contract §B3", () => {
  it("under Policy 1, contributes exactly where valid — the only NONE grant (REJECTED) is already excluded by validity", () => {
    const cases: EvidenceStanding[] = [
      evidence({ verificationStatus: "UNVERIFIED" }),
      evidence({ verificationStatus: "PENDING" }),
      evidence({ verificationStatus: "VERIFIED" }),
      evidence({ verificationStatus: "REJECTED" }),
      evidence({ state: "EXPIRED" }),
      evidence({ state: "REVOKED" }),
      evidence({ state: "SUPERSEDED" }),
      evidence({ validUntil: new Date(asOf.getTime() - 1) }),
    ];
    for (const e of cases) {
      expect(doesEvidenceContribute(e, asOf)).toBe(isEvidenceValid(e, asOf));
    }
  });

  it("existence, validity and contribution are three different answers for the same row", () => {
    const rejected = evidence({ verificationStatus: "REJECTED" });
    // exists: the row is a real EvidenceStanding value — true by construction
    expect(isEvidenceValid(rejected, asOf)).toBe(false); // not valid
    expect(doesEvidenceContribute(rejected, asOf)).toBe(false); // and so does not contribute
  });
});

describe("projectProficiency — the pure core of what proficiency.ts's recompute does", () => {
  it("no evidence -> NONE", () => {
    expect(projectProficiency([], asOf)).toBe("NONE");
  });

  it("a single VERIFIED row -> INTERMEDIATE", () => {
    expect(projectProficiency([evidence({ verificationStatus: "VERIFIED" })], asOf)).toBe(
      "INTERMEDIATE"
    );
  });

  it("REJECTED evidence contributes nothing", () => {
    expect(projectProficiency([evidence({ verificationStatus: "REJECTED" })], asOf)).toBe("NONE");
  });

  it("EXPIRED/REVOKED/SUPERSEDED evidence contributes nothing even if otherwise VERIFIED", () => {
    const states = ["EXPIRED", "REVOKED", "SUPERSEDED"] as const;
    for (const state of states) {
      expect(projectProficiency([evidence({ verificationStatus: "VERIFIED", state })], asOf)).toBe(
        "NONE"
      );
    }
  });

  it("expired-by-validUntil evidence contributes nothing", () => {
    const expired = evidence({
      verificationStatus: "VERIFIED",
      validUntil: new Date(asOf.getTime() - 1),
    });
    expect(projectProficiency([expired], asOf)).toBe("NONE");
  });

  it("takes the maximum, not the first or last, row", () => {
    const rows = [
      evidence({ verificationStatus: "UNVERIFIED" }),
      evidence({ verificationStatus: "VERIFIED" }),
      evidence({ verificationStatus: "REJECTED" }),
    ];
    expect(projectProficiency(rows, asOf)).toBe("INTERMEDIATE");
  });

  it("is order-independent — the same set, in every permutation, produces the same result", () => {
    const rows = [
      evidence({ verificationStatus: "REJECTED" }),
      evidence({ verificationStatus: "UNVERIFIED" }),
      evidence({ verificationStatus: "VERIFIED" }),
    ];
    const permutations = [
      [rows[0], rows[1], rows[2]],
      [rows[2], rows[1], rows[0]],
      [rows[1], rows[0], rows[2]],
    ];
    const results = permutations.map((p) => projectProficiency(p, asOf));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("INTERMEDIATE");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("confidenceFor — contract §D1/§D2", () => {
  it("NONE level -> null (nothing to have confidence about)", () => {
    expect(confidenceFor("NONE", [], asOf)).toBeNull();
  });

  it("no evidence supports the given level -> null", () => {
    const onlyBeginnerGrant = [
      {
        verificationStatus: "UNVERIFIED" as const,
        state: "ACTIVE" as const,
        validUntil: null,
        type: "MANUAL" as const,
        occurredAt: asOf,
      },
    ];
    expect(confidenceFor("INTERMEDIATE", onlyBeginnerGrant, asOf)).toBeNull();
  });

  it("a fresh VERIFIED row -> HIGH", () => {
    const fresh = {
      verificationStatus: "VERIFIED" as const,
      state: "ACTIVE" as const,
      validUntil: null,
      type: "COURSE_COMPLETION" as const,
      occurredAt: new Date(asOf.getTime() - DAY_MS),
    };
    expect(confidenceFor("INTERMEDIATE", [fresh], asOf)).toBe("HIGH");
  });

  it("a stale VERIFIED row (older than the freshness window) -> MEDIUM, not HIGH", () => {
    const stale = {
      verificationStatus: "VERIFIED" as const,
      state: "ACTIVE" as const,
      validUntil: null,
      type: "COURSE_COMPLETION" as const,
      occurredAt: new Date(asOf.getTime() - (CONFIDENCE_FRESHNESS_WINDOW_DAYS + 1) * DAY_MS),
    };
    expect(confidenceFor("INTERMEDIATE", [stale], asOf)).toBe("MEDIUM");
  });

  it("exactly at the freshness window boundary -> still fresh (HIGH)", () => {
    const atBoundary = {
      verificationStatus: "VERIFIED" as const,
      state: "ACTIVE" as const,
      validUntil: null,
      type: "COURSE_COMPLETION" as const,
      occurredAt: new Date(asOf.getTime() - CONFIDENCE_FRESHNESS_WINDOW_DAYS * DAY_MS),
    };
    expect(confidenceFor("INTERMEDIATE", [atBoundary], asOf)).toBe("HIGH");
  });

  it("an unresolved occurredAt (null, no validUntil) is never treated as fresh", () => {
    const unknownAge = {
      verificationStatus: "VERIFIED" as const,
      state: "ACTIVE" as const,
      validUntil: null,
      type: "COURSE_COMPLETION" as const,
      occurredAt: null,
    };
    expect(confidenceFor("INTERMEDIATE", [unknownAge], asOf)).toBe("MEDIUM");
  });

  it("two distinct unverified evidence types -> MEDIUM (corroboration by type, not by source id)", () => {
    const rows = [
      {
        verificationStatus: "UNVERIFIED" as const,
        state: "ACTIVE" as const,
        validUntil: null,
        type: "COURSE_COMPLETION" as const,
        occurredAt: asOf,
      },
      {
        verificationStatus: "UNVERIFIED" as const,
        state: "ACTIVE" as const,
        validUntil: null,
        type: "QUIZ_SCORE" as const,
        occurredAt: asOf,
      },
    ];
    expect(confidenceFor("BEGINNER", rows, asOf)).toBe("MEDIUM");
  });

  it("a single unverified type, however many rows -> LOW, not MEDIUM", () => {
    const rows = [
      {
        verificationStatus: "UNVERIFIED" as const,
        state: "ACTIVE" as const,
        validUntil: null,
        type: "QUIZ_SCORE" as const,
        occurredAt: asOf,
      },
      {
        verificationStatus: "UNVERIFIED" as const,
        state: "ACTIVE" as const,
        validUntil: null,
        type: "QUIZ_SCORE" as const,
        occurredAt: asOf,
      },
    ];
    expect(confidenceFor("BEGINNER", rows, asOf)).toBe("LOW");
  });
});

describe("MAX_GRANTABLE_LEVEL / isAssessable — pre-flight audit §8's G1 guard primitive", () => {
  it("MAX_GRANTABLE_LEVEL is derived from ceilingFor's own output range, currently INTERMEDIATE", () => {
    // This is the one place the current policy's actual ceiling is named —
    // isAssessable itself never repeats this literal (see the loop below).
    expect(MAX_GRANTABLE_LEVEL).toBe("INTERMEDIATE");
  });

  it("matches the policy's ceiling for every proficiency level, without the test (or the implementation) naming a level", () => {
    const ceilingIndex = PROFICIENCY_ORDER.indexOf(MAX_GRANTABLE_LEVEL);
    for (const [index, level] of PROFICIENCY_ORDER.entries()) {
      expect(isAssessable(level as SkillProficiency)).toBe(index <= ceilingIndex);
    }
  });
});
