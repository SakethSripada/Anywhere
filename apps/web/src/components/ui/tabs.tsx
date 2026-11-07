"use client";

import { Tabs as T } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Segmented tabs with a sliding thumb that follows the active tab. */
export function Segmented<V extends string>({
  value,
  onValueChange,
  items,
  className,
  size = "md",
}: {
  value: V;
  onValueChange: (value: V) => void;
  items: { value: V; label: ReactNode; count?: number }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <T.Root value={value} onValueChange={(v) => onValueChange(v as V)}>
      <T.List
        className={cn(
          "relative inline-flex items-center gap-0.5 rounded-lg bg-canvas/70 p-0.5 shadow-[inset_0_0_0_1px_var(--color-line)]",
          className,
        )}
      >
        {items.map((item) => (
          <T.Tab
            key={item.value}
            value={item.value}
            className={cn(
              "relative z-[1] inline-flex items-center gap-1.5 rounded-md font-medium text-fg-subtle outline-none",
              "transition-colors duration-150 hover:text-fg-muted data-[active]:text-fg focus-ring",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="tabular rounded-[4px] bg-white/[0.06] px-1 text-2xs text-fg-subtle">{item.count}</span>
            )}
          </T.Tab>
        ))}
        <T.Indicator
          className={cn(
            "absolute top-1/2 left-0 z-0 -translate-y-1/2 rounded-md bg-raised",
            "shadow-[inset_0_1px_0_0_oklch(1_0_0/0.06),0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0_0_0/0.35)]",
            "h-[var(--active-tab-height)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)]",
            "transition-[translate,width] duration-250 ease-out",
          )}
        />
      </T.List>
    </T.Root>
  );
}
