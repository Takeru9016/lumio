import { Suspense } from "react";
import { OrgPathsSkeleton } from "@/components/org/paths/OrgPathSkeletons";
import { OrgPathsClient } from "@/components/org/paths/OrgPathsClient";

/**
 * Organisation admin: learning paths (Phase 29.3.4). The list, the status filter
 * and the page cursor are read from the admin paths API by the client component,
 * with the filter and cursor in the URL. The org layout already turns away anyone
 * who is not an organisation admin, and the API decides everything else.
 */
export default function OrgPathsPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Suspense fallback={<OrgPathsSkeleton />}>
        <OrgPathsClient />
      </Suspense>
    </div>
  );
}
