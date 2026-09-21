import type { AdminFailure } from "@/lib/admin-path-client";
import { describeProblems } from "@/lib/admin-path-view";

/**
 * A refused change, in words. When the server named what blocks a publish, it is
 * listed exactly as sent: a course it gave only by id has no title here, and
 * nothing else is looked up to fill the gap.
 */
export function FailureNotice({ failure }: { failure: AdminFailure }) {
  const problems = describeProblems(failure.problems);

  return (
    <div
      role="alert"
      className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger"
    >
      <p className="wrap-break-word">{failure.message}</p>
      {problems && (
        <div className="mt-2 space-y-1 text-text-primary">
          {problems.intro && <p className="text-sm font-medium">{problems.intro}</p>}
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {problems.items.map((item) => (
              <li key={item.key} className="wrap-break-word">
                {item.text}
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">Review the affected courses and try again.</p>
        </div>
      )}
    </div>
  );
}
