# /commit

Only run this after /check passes with 0 failures.

1. Stage all changes: `git add -A`

2. Run final type check: `npx tsc --noEmit`
   If it fails, STOP. Fix errors and re-run /check.

3. Commit with the phase/task format:
   `git commit -m "phase/N-task/X: description"`
   The commit message is defined at the bottom of each task prompt.
   Do not invent a different format.

4. Report:
   - Files changed (count)
   - Commit hash
   - What the next task is (read from PHASES.md checklist)

5. Update the checkbox in docs/PHASES.md for the completed task:
   Change `[ ]` to `[x]` for the task just completed.
