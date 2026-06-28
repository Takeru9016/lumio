import type { Role } from "@/generated/prisma/enums";

export function getRoleDashboard(role: Role): string {
  switch (role) {
    case "STUDENT":
      return "/courses";
    case "INSTRUCTOR":
      return "/instructor/courses";
    case "ORG_ADMIN":
      return "/courses";
    case "SUPER_ADMIN":
      return "/courses";
  }
}
