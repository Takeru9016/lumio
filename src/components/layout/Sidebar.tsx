"use client";

import {
  BarChart2,
  BookOpen,
  Building2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  Globe,
  LayoutDashboard,
  Map as MapIcon,
  Settings,
  Sparkles,
  Trophy,
  Users,
  Users2,
} from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Role } from "@/generated/prisma/enums";
import type { NavItem } from "@/types";

const ROLE_NAV_ITEMS: Record<Role, NavItem[]> = {
  STUDENT: [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "My Courses", href: "/courses", icon: BookOpen },
    { label: "Learning Path", href: "/learning-path", icon: MapIcon },
    { label: "AI Tutor", href: "/ai-tutor", icon: Sparkles },
    { label: "Assignments", href: "/assignments", icon: ClipboardList },
    { label: "Leaderboard", href: "/leaderboard", icon: Trophy },
    { label: "Settings", href: "/settings", icon: Settings },
  ],
  INSTRUCTOR: [
    { label: "My Courses", href: "/instructor/courses", icon: BookOpen },
    { label: "Students", href: "/instructor/students", icon: Users },
  ],
  ORG_ADMIN: [
    { label: "Overview", href: "/org/dashboard", icon: LayoutDashboard },
    { label: "Teams", href: "/org/teams", icon: Users2 },
    { label: "Courses", href: "/org/courses", icon: BookOpen },
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

interface SidebarProps {
  role: Role;
}

export function Sidebar({ role }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const pathname = usePathname();
  const items = ROLE_NAV_ITEMS[role];

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setIsCollapsed(stored === "true");
  }, []);

  const toggle = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  return (
    <motion.nav
      animate={{ width: isCollapsed ? 64 : 240 }}
      initial={{ width: 240 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="hidden md:flex flex-col h-full border-r border-border bg-white shrink-0 overflow-hidden"
    >
      <div className="flex-1 flex flex-col py-3 px-2 gap-0.5">
        {items.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              title={isCollapsed ? item.label : undefined}
              className={`flex items-center py-2 rounded-md text-sm transition-colors ${
                isCollapsed ? "justify-center px-3" : "gap-3 px-3"
              } ${
                isActive
                  ? `bg-brand-light text-brand font-medium${
                      isCollapsed ? "" : " border-l-2 border-brand"
                    }`
                  : "text-text-secondary hover:bg-surface-2"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </div>

      <div className="p-2 border-t border-border">
        <button
          type="button"
          onClick={toggle}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-full flex items-center justify-center p-2 text-text-muted hover:bg-surface-2 rounded-md transition-colors"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </motion.nav>
  );
}
