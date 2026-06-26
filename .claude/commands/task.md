# /task

Read docs/PHASES.md and report the current build status.

Show:

1. **Completed tasks** (marked [x]) — count and list
2. **Current task** — the first unchecked [ ] task
3. **Remaining tasks** — count per phase and overall
4. **Next 3 tasks** — brief description of what comes after current

Also flag:

- Any tasks with "BEFORE STARTING" prerequisite notes (e.g. Phase 4 pgvector extension)
- Model recommendation for the current task (Sonnet or Opus)
