import type { Role } from "@/generated/prisma/enums";

export function getRoleDashboard(_role: Role): string {
  // All roles currently redirect to /dashboard.
  // When pages are added across route groups this will need per-role paths
  // e.g. /student/dashboard, /instructor/dashboard to avoid URL conflicts.
  return "/dashboard";
}
