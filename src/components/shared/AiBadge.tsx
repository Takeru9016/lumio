interface AiBadgeProps {
  label?: string;
  size?: "sm" | "md";
}

export function AiBadge({ label = "AI", size = "sm" }: AiBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-(--color-ai-bg) font-semibold text-(--color-ai) ${
        size === "md"
          ? "px-2.5 py-1 text-xs"
          : "px-2 py-0.5 text-[11px]"
      }`}
    >
      ✦ {label}
    </span>
  );
}
