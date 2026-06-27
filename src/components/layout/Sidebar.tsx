"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import {
  LayoutDashboard,
  BookOpen,
  Map,
  Sparkles,
  ClipboardList,
  Trophy,
  Settings,
  Users,
  DollarSign,
  BarChart2,
  Globe,
  Building2,
  CreditCard,
  Users2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { NavItem } from "@/types";
import type { Role } from "@/generated/prisma/enums";

const ROLE_NAV_ITEMS: Record<Role, NavItem[]> = {
  STUDENT: [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "My Courses", href: "/courses", icon: BookOpen },
    { label: "Learning Path", href: "/learning-path", icon: Map },
    { label: "AI Tutor", href: "/ai-tutor", icon: Sparkles },
    { label: "Assignments", href: "/assignments", icon: ClipboardList },
    { label: "Leaderboard", href: "/leaderboard", icon: Trophy },
    { label: "Settings", href: "/settings", icon: Settings },
  ],
  INSTRUCTOR: [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "My Courses", href: "/courses", icon: BookOpen },
    { label: "Students", href: "/students", icon: Users },
    { label: "Earnings", href: "/earnings", icon: DollarSign },
  ],
  ORG_ADMIN: [
    { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
    { label: "Teams", href: "/teams", icon: Users2 },
    { label: "Courses", href: "/courses", icon: BookOpen },
    { label: "Reports", href: "/reports", icon: BarChart2 },
    { label: "Settings", href: "/settings", icon: Settings },
  ],
  SUPER_ADMIN: [
    { label: "Platform Overview", href: "/dashboard", icon: Globe },
    { label: "Tenants", href: "/tenants", icon: Building2 },
    { label: "Users", href: "/users", icon: Users },
    { label: "Billing", href: "/billing", icon: CreditCard },
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
      className="hidden md:flex flex-col h-full border-r border-(--color-border) bg-white flex-shrink-0 overflow-hidden"
    >
      <div className="flex-1 flex flex-col py-3 px-2 gap-0.5">
        {items.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
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
                  ? `bg-(--color-brand-light) text-(--color-brand) font-medium${
                      isCollapsed ? "" : " border-l-2 border-(--color-brand)"
                    }`
                  : "text-(--color-text-secondary) hover:bg-(--color-surface-2)"
              }`}
            >
              <Icon size={16} className="flex-shrink-0" />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </div>

      <div className="p-2 border-t border-(--color-border)">
        <button
          onClick={toggle}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-full flex items-center justify-center p-2 text-(--color-text-muted) hover:bg-(--color-surface-2) rounded-md transition-colors"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </motion.nav>
  );
}
