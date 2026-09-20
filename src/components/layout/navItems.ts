import {
  BarChart2,
  BookOpen,
  Briefcase,
  Building2,
  ClipboardList,
  CreditCard,
  Globe,
  Inbox,
  LayoutDashboard,
  Library,
  Map as MapIcon,
  Search,
  Settings,
  Sparkles,
  Target,
  Trophy,
  Users,
  Users2,
} from "lucide-react";
import type { Role } from "@/generated/prisma/enums";
import type { NavItem } from "@/types";

export const ROLE_NAV_ITEMS: Record<Role, NavItem[]> = {
  STUDENT: [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "My Courses", href: "/courses", icon: BookOpen },
    { label: "Learning Path", href: "/learning-path", icon: MapIcon },
    { label: "AI Tutor", href: "/ai-tutor", icon: Sparkles },
    { label: "Search", href: "/search", icon: Search },
    { label: "Assignments", href: "/assignments", icon: ClipboardList },
    { label: "Leaderboard", href: "/leaderboard", icon: Trophy },
    { label: "Settings", href: "/settings", icon: Settings },
  ],
  INSTRUCTOR: [
    { label: "Dashboard", href: "/instructor/dashboard", icon: LayoutDashboard },
    { label: "My Courses", href: "/instructor/courses", icon: BookOpen },
    { label: "AI Course Creator", href: "/courses/create-ai", icon: Sparkles },
    { label: "Students", href: "/instructor/students", icon: Users },
    { label: "Capability", href: "/instructor/capability", icon: Target },
    { label: "Knowledge", href: "/instructor/knowledge", icon: Library },
    { label: "Requests", href: "/instructor/requests", icon: Inbox },
  ],
  ORG_ADMIN: [
    { label: "Overview", href: "/org/dashboard", icon: LayoutDashboard },
    { label: "Teams", href: "/org/teams", icon: Users2 },
    { label: "Capability roles", href: "/org/roles", icon: Briefcase },
    { label: "Courses", href: "/org/courses", icon: BookOpen },
    { label: "Knowledge", href: "/org/knowledge", icon: Library },
    { label: "Requests", href: "/org/requests", icon: Inbox },
    { label: "Reports", href: "/reports", icon: BarChart2 },
    { label: "Billing", href: "/org/settings/billing", icon: CreditCard },
    { label: "Settings", href: "/org/settings", icon: Settings },
  ],
  SUPER_ADMIN: [
    { label: "Platform Overview", href: "/admin/dashboard", icon: Globe },
    { label: "Tenants", href: "/admin/tenants", icon: Building2 },
    { label: "Users", href: "/admin/users", icon: Users },
    { label: "Billing", href: "/admin/billing", icon: CreditCard },
  ],
};

/**
 * Nav items can share a URL prefix (e.g. "/org/settings" and "/org/settings/billing"),
 * so matching each item independently would light up both. Only the longest matching
 * href — the most specific one — should be treated as active.
 */
export function getActiveHref(items: NavItem[], pathname: string | null): string | undefined {
  if (!pathname) return undefined;
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}
