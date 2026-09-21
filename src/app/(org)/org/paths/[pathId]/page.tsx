import { redirect } from "next/navigation";

import { PathEditor } from "@/components/org/paths/PathEditor";
import { getAuthContext } from "@/lib/auth/context";
import { listPathCourseChoices } from "@/lib/org-path-course-choices";

/**
 * One learning path's editor. The path itself is read from the API by the client;
 * only the list of courses to choose from is read here, because no API lists them.
 * The layout also redirects non-admins, but this page checks for itself rather
 * than relying on that.
 */
export default async function OrgPathPage({ params }: { params: Promise<{ pathId: string }> }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!ctx.tenantId) redirect("/onboarding");

  const [{ pathId }, courseChoices] = await Promise.all([params, listPathCourseChoices(ctx)]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <PathEditor pathId={pathId} courseChoices={courseChoices} />
    </div>
  );
}
