import { PathEditorSkeleton } from "@/components/org/paths/OrgPathSkeletons";

export default function OrgPathLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <PathEditorSkeleton />
    </div>
  );
}
