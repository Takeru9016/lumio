"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface CreateCourseButtonProps {
  disabled: boolean;
  planName: string;
  label?: string;
}

export function CreateCourseButton({
  disabled,
  planName,
  label = "New Course",
}: CreateCourseButtonProps) {
  if (!disabled) {
    return (
      <Link
        href="/courses/new"
        className="flex items-center gap-2 bg-brand text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
      >
        <Plus size={15} />
        {label}
      </Link>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-disabled="true"
            className="flex items-center gap-2 bg-surface-3 text-text-disabled rounded-lg px-4 py-2 text-sm font-medium cursor-not-allowed"
          >
            <Plus size={15} />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          You&apos;ve reached the course limit on your {planName} plan. Upgrade to create more.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
