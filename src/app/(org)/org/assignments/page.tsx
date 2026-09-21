import { redirect } from "next/navigation";

import { AssignmentFilters } from "@/components/org/assignments/AssignmentFilters";
import { AssignmentsClient } from "@/components/org/assignments/AssignmentsClient";
import { ASSIGNMENTS_PATH, filterHref, presentAdminAssignment } from "@/lib/admin-assignment-view";
import { getAuthContext } from "@/lib/auth/context";
import {
  AssignmentCursorError,
  listAssignmentOptions,
  listOrgAssignments,
} from "@/lib/domain/learning-assignment/adminAssignments";
import { parseAssignmentFilters } from "@/lib/learning-assignment-api";

type SearchParams = Promise<{
  source?: string | string[];
  status?: string | string[];
  cursor?: string | string[];
}>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Organisation admin: learning assignments (Phase 28.5). Server-rendered: the
 * list is read by the domain for the session's own tenant, the filters live in
 * the URL, and after a change the client asks Next to re-render this page. The
 * layout also redirects non-admins, but this page checks for itself rather than
 * relying on that.
 *
 * The list is paged newest first with the source and status filters applied
 * before each page is cut. A cursor in the URL is the position of an older page;
 * a malformed one (or an unknown filter) sends the visitor back to the newest
 * assignments rather than showing a list that is not what the URL says.
 */
export default async function OrgAssignmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!ctx.tenantId) redirect("/onboarding");

  const params = await searchParams;
  const parsed = parseAssignmentFilters({
    source: first(params.source),
    status: first(params.status),
  });
  if (!parsed.ok) redirect(ASSIGNMENTS_PATH);
  const { filters } = parsed;

  const cursor = first(params.cursor) || undefined;

  let page: Awaited<ReturnType<typeof listOrgAssignments>>;
  try {
    page = await listOrgAssignments(ctx, filters, { cursor });
  } catch (err) {
    if (err instanceof AssignmentCursorError) redirect(filterHref(filters));
    throw err;
  }
  const options = await listAssignmentOptions(ctx);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="font-heading text-xl font-semibold text-text-primary">Assignments</h1>
        <p className="mt-1 text-sm text-text-muted">
          Assign courses to learners and see who has been assigned what, and where they stand.
        </p>
      </div>

      <AssignmentFilters source={filters.source ?? null} status={filters.status ?? null} />

      <AssignmentsClient
        rows={page.assignments.map(presentAdminAssignment)}
        options={options}
        filtered={Boolean(filters.source || filters.status)}
        olderHref={page.nextCursor ? filterHref({ ...filters, cursor: page.nextCursor }) : null}
        newestHref={cursor ? filterHref(filters) : null}
      />
    </div>
  );
}
