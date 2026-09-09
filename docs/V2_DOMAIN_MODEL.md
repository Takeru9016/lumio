# Lumio V2 Domain Model

## Goal
Move from a primarily `User → Course → Section → Lesson` model toward a capability-aware learning platform while retaining backward compatibility.

## Core domains

### Identity and organization
Existing `User`, `Tenant`, `Team`, `TeamMember`, `Invitation` remain foundational.

Add:

- `OrganizationMembership` — explicit membership when one user can belong to multiple organizations.
- `Permission` — named capability such as `course.publish`, `skill.manage`, `knowledge.read`, `ai.execute`.
- `RolePermission` — maps application roles to permissions.

### Learning
Retain existing Course/Section/Lesson initially. Introduce richer concepts additively:

- `LearningProgram` — top-level learning experience/path.
- `LearningProgramItem` — ordered courses or activities in a program.
- `Activity` — generalized learning unit: video, article, document, quiz, assignment, practice, scenario, simulation, reflection, discussion, AI activity, resource.
- `Assessment` — generalized assessment container.
- `AssessmentItem` — question/task definition.
- `LearningGoal` — intended outcome for a program/course/activity.

Existing `Lesson` becomes a compatibility representation of an Activity until migrated.

### Capability
Add:

- `SkillCategory` — taxonomy grouping.
- `Skill` — atomic capability with name, description and level model.
- `SkillLevel` — optional normalized proficiency level definition.
- `JobRole` — organizational role such as Sales Manager or Backend Engineer.
- `RoleSkill` — required/target skill and proficiency for a role.
- `UserJobRole` — current/target role assignment.
- `UserSkill` — observed or assessed user proficiency.
- `CourseSkill` — skills developed by a course/activity.
- `SkillEvidence` — evidence linking a user to a skill through assessment, project, completion, manager validation or other source.
- `SkillGap` — calculated gap between current proficiency and target proficiency.

### Knowledge
Add:

- `KnowledgeSource` — origin such as course, upload, policy, URL, transcript or integration.
- `KnowledgeDocument` — normalized retrievable document.
- `KnowledgeChunk` — chunked text with metadata and embedding.
- `KnowledgeAccess` — explicit tenant/user/team/role visibility when needed.
- `KnowledgeCitation` — durable source metadata for AI responses.

Do not make the course Lesson embedding the canonical knowledge store.

### AI
Replace the conceptual single `AIChat.messages Json` approach with an extensible runtime:

- `AIConversation` — conversation metadata and scope.
- `AIMessage` — individual message.
- `AIToolCall` — tool invocation and result metadata.
- `AISourceCitation` — sources attached to an AI response.
- `AIExecution` — one AI generation/action execution with status, model, latency and cost metadata.
- `AIUsageEvent` — billable/observable usage event.
- `AIAgentRun` — agent execution lifecycle when agents are introduced.

Existing `AIChat` should be retained temporarily for migration compatibility.

### Analytics and evidence
Add:

- `LearningEvent` — immutable event record for meaningful learner/system activity.
- `EvidenceEvent` — optional normalized evidence signal when a learning event contributes to capability state.

Operational state such as `LessonProgress` remains useful; events capture the historical trail.

## Relationship graph

`Tenant → User/Team → JobRole → RoleSkill → Skill`

`User → UserSkill → SkillEvidence → LearningEvent`

`Course → CourseSkill → Skill`

`LearningProgram → Course/Activity → Assessment → LearningEvent`

`KnowledgeSource → KnowledgeDocument → KnowledgeChunk → AI Citation`

`AIConversation → AIMessage → AIExecution → AIToolCall/Citation`

## Important invariants

- Every tenant-owned entity must be tenant-addressable or inherit tenant scope through a trusted parent.
- A user cannot gain access to a skill, document, course or AI context solely because an ID is known.
- Skill proficiency must have provenance: source, timestamp and confidence where applicable.
- AI-generated content must retain provenance and generation metadata.
- AI writes/executions must be auditable.
- Historical learning events are append-only; corrections should be represented as new events or explicit correction records.

## Migration strategy

1. Add new tables with nullable/backfillable foreign keys.
2. Backfill tenant relationships from existing course/user ownership.
3. Create initial skill taxonomy and role mappings.
4. Map each existing Course to a learning program or maintain a one-to-one compatibility mapping.
5. Map each Lesson to an Activity representation.
6. Import existing AIChat JSON into AIConversation/AIMessage where practical.
7. Re-index lesson/text/video transcripts into KnowledgeChunk.
8. Start emitting LearningEvent for new activity.
9. Move UI/service reads to V2 models incrementally.
10. Deprecate legacy fields only after production validation.
