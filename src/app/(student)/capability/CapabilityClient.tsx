"use client";

import { motion } from "motion/react";
import Link from "next/link";

import { EmptyState } from "@/components";

export type EvidenceRow = {
  id: string;
  type: string;
  score: number | null;
  verificationStatus: string;
  createdAt: string;
};

export type RequiredSkillRow = {
  skillId: string;
  skillName: string;
  currentProficiency: string;
  requiredProficiency: string;
  met: boolean;
  lastAssessedAt: string | null;
  evidence: EvidenceRow[];
};

interface CapabilityClientProps {
  state: "ready" | "no-role" | "no-tenant" | "load-failed";
  roleName: string | null;
  skills: RequiredSkillRow[];
}

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: "easeOut" as const } },
};

function proficiencyLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function verificationLabel(value: string): string {
  switch (value) {
    case "VERIFIED":
      return "Verified";
    case "REJECTED":
      return "Rejected";
    case "PENDING":
      return "Pending review";
    default:
      return "Unverified";
  }
}

function evidenceTypeLabel(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

export function CapabilityClient({ state, roleName, skills }: CapabilityClientProps) {
  if (state === "no-tenant") {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <EmptyState
          icon="🎯"
          title="Capability tracking isn't available for your account"
          description="Skill profiles are tracked at the organisation level. Join or create an organisation to start building a capability profile."
          ctaLabel="Back to dashboard"
          ctaHref="/dashboard"
        />
      </div>
    );
  }

  if (state === "load-failed") {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <EmptyState
          icon="⚠️"
          title="Couldn't load your capability profile"
          description="Something went wrong loading your skill data. Please try again shortly."
          ctaLabel="Back to dashboard"
          ctaHref="/dashboard"
        />
      </div>
    );
  }

  if (state === "no-role") {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <EmptyState
          icon="🎯"
          title="No role has been assigned yet"
          description="Once your organisation assigns you a role, your required skills, progress, and evidence will show up here."
          ctaLabel="Back to dashboard"
          ctaHref="/dashboard"
        />
      </div>
    );
  }

  const metCount = skills.filter((s) => s.met).length;

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="p-6 max-w-3xl mx-auto space-y-6"
    >
      <motion.div variants={itemVariants} className="space-y-1">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Capability profile
        </h1>
        <p className="text-sm text-text-muted">
          Primary role: <span className="text-text-primary font-medium">{roleName}</span>
        </p>
        {skills.length > 0 && (
          <p className="text-sm text-text-muted">
            {metCount} of {skills.length} required skills met
          </p>
        )}
      </motion.div>

      <div className="space-y-3">
        {skills.length === 0 ? (
          <motion.div
            variants={itemVariants}
            className="bg-surface-1 border border-border rounded-lg"
          >
            <EmptyState
              icon="📋"
              title="No required skills yet"
              description="Your role currently has no required skills configured."
              ctaLabel="Back to dashboard"
              ctaHref="/dashboard"
            />
          </motion.div>
        ) : (
          skills.map((skill) => (
            <motion.div
              key={skill.skillId}
              variants={itemVariants}
              className="bg-surface-1 border border-border rounded-lg p-4 shadow-sm space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-text-primary">{skill.skillName}</p>
                <span
                  className={`text-xs font-medium rounded-full px-2 py-0.5 shrink-0 ${
                    skill.met ? "bg-surface-3 text-text-muted" : "bg-ai-bg text-ai"
                  }`}
                >
                  {skill.met ? "Met" : "Gap"}
                </span>
              </div>

              <p className="text-xs text-text-muted">
                {proficiencyLabel(skill.currentProficiency)} →{" "}
                {proficiencyLabel(skill.requiredProficiency)}
                {skill.lastAssessedAt && (
                  <> · last assessed {new Date(skill.lastAssessedAt).toLocaleDateString()}</>
                )}
              </p>

              <div className="space-y-1.5">
                {skill.evidence.length === 0 ? (
                  <p className="text-xs text-text-muted">No evidence yet</p>
                ) : (
                  skill.evidence.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between text-xs text-text-muted bg-surface-3 rounded-md px-2 py-1"
                    >
                      <span>
                        {evidenceTypeLabel(e.type)}
                        {e.score !== null && ` · ${e.score}%`}
                      </span>
                      <span className="flex items-center gap-2">
                        <span>{verificationLabel(e.verificationStatus)}</span>
                        <span>{new Date(e.createdAt).toLocaleDateString()}</span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          ))
        )}
      </div>

      <motion.div variants={itemVariants}>
        <Link
          href="/dashboard"
          className="flex items-center gap-3 bg-ai-bg border border-ai-border rounded-lg p-4 hover:opacity-90 transition-opacity"
        >
          <span className="text-xl text-ai">✦</span>
          <div>
            <p className="text-sm font-semibold text-ai">View recommended learning</p>
            <p className="text-xs text-text-muted mt-0.5">
              See courses matched to your remaining skill gaps
            </p>
          </div>
        </Link>
      </motion.div>
    </motion.div>
  );
}
