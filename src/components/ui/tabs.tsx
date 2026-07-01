"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={`inline-flex h-9 items-center justify-center rounded-lg bg-surface-3 p-1 text-text-muted ${className ?? ""}`}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-surface-1 data-[state=active]:text-text-primary data-[state=active]:shadow-sm ${className ?? ""}`}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={`mt-2 focus-visible:outline-none ${className ?? ""}`}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
