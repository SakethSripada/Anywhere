"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { frameTime, type RenderTime } from "@/lib/plan";

const LABEL = { simple: "a simple scene", detailed: "a detailed scene", heavy: "a heavy scene (fog, many lights)" } as const;

/**
 * Estimated minutes per frame on each GPU, as ranges on one shared time axis. The
 * planned GPU carries the accent; the rest stay gray. Numbers come from Blender
 * Open Data benchmarks; a test render on a running desktop replaces them.
 */
export function RenderTimeTable({ data, chosen }: { data: RenderTime; chosen?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!data.rows.length) return null;
  const top = Math.max(...data.rows.map((r) => r.minutes_high));
  const rows = [...data.rows].sort((a, b) => a.minutes_high - b.minutes_high);
  const pick = chosen ?? data.rows[0].gpu;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        Per frame for {LABEL[data.complexity]} at {data.width}×{data.height}, {data.samples} samples
        {data.frames > 1 ? `, ${data.frames} frames` : ""}
        {(data.machines ?? 1) > 1 ? `, split across ${data.machines} GPUs (totals are per GPU, at the same time)` : ""}.
      </p>
      <ol className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const lo = (r.minutes_low / top) * 100;
          const hi = (r.minutes_high / top) * 100;
          const isChosen = r.gpu === pick;
          const each = Math.ceil(data.frames / (data.machines ?? 1));
          const total = data.frames > 1 ? ` · ${frameTime(r.minutes_low * each)}–${frameTime(r.minutes_high * each)} total` : "";
          return (
            <li
              key={r.gpu}
              tabIndex={0}
              onPointerEnter={() => setHover(r.gpu)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(r.gpu)}
              onBlur={() => setHover(null)}
              aria-label={`${r.gpu}: ${frameTime(r.minutes_low)} to ${frameTime(r.minutes_high)} per frame${isChosen ? ", planned" : ""}`}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex items-baseline gap-3">
                <span className={cn("text-[13px]", isChosen && "font-medium")}>{r.gpu}</span>
                {isChosen && <span className="rounded-sm bg-muted px-1.5 text-[11px]">Planned</span>}
                {r.benchmark_runs < 3 && <span className="text-[11px] text-muted-foreground">few benchmarks</span>}
                <span className={cn("ml-auto text-[13px] tabular", isChosen ? "font-medium" : "text-muted-foreground")}>
                  {frameTime(r.minutes_low)}–{frameTime(r.minutes_high)}
                </span>
              </div>
              <span className="relative mt-1 block h-3">
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span
                  className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[4px] transition-opacity"
                  style={{
                    left: `${lo}%`,
                    width: `max(${hi - lo}%, 6px)`,
                    background: isChosen ? "var(--chart-1)" : "var(--chart-4)",
                    opacity: hover == null || hover === r.gpu ? 1 : 0.45,
                  }}
                />
                {hover === r.gpu && (
                  <span
                    className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
                    style={{ left: `${Math.min(lo, 45)}%` }}
                  >
                    <span className="block font-medium tabular">
                      {frameTime(r.minutes_low)}–{frameTime(r.minutes_high)} per frame{total}
                    </span>
                    <span className="block text-muted-foreground">
                      ${r.price_per_hour.toFixed(2)}/hr · from {r.benchmark_runs} benchmark run{r.benchmark_runs === 1 ? "" : "s"}
                    </span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="relative h-4 border-t" aria-hidden>
        <span className="absolute top-1 text-[10.5px] text-muted-foreground tabular">0</span>
        <span className="absolute top-1 right-0 text-[10.5px] text-muted-foreground tabular">{frameTime(top)}</span>
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        Estimated from Blender Open Data benchmarks. Once your scene is saved on a running desktop, Insights → Render time measures it exactly.
      </p>
    </div>
  );
}
