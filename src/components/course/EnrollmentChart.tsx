"use client";

import type { ReactNode } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface EnrollmentChartProps {
  data: { date: string; count: number }[];
  seriesName?: string;
}

function formatTick(date: string | number) {
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatLabel(label: ReactNode) {
  return typeof label === "string" ? formatTick(label) : label;
}

export function EnrollmentChart({ data, seriesName = "Enrollments" }: EnrollmentChartProps) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="date"
          tickFormatter={formatTick}
          tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
          axisLine={{ stroke: "var(--color-border)" }}
          tickLine={false}
          interval={4}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <Tooltip
          labelFormatter={formatLabel}
          contentStyle={{
            borderRadius: 8,
            borderColor: "var(--color-border)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="count"
          name={seriesName}
          stroke="var(--color-brand)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
