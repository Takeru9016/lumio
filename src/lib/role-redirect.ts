import type { Role } from "@/generated/prisma/enums";

export function getRoleDashboard(role: Role): string {
  switch (role) {
    case "STUDENT":
      return "/dashboard";
    case "INSTRUCTOR":
      return "/instructor/courses";
    case "ORG_ADMIN":
      return "/org/dashboard";
    case "SUPER_ADMIN":
      return "/admin/dashboard";
  }
}
