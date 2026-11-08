"use client";

import { useState } from "react";
import { cents, centsRange } from "@/lib/format";
import type { PlanDoc } from "@/lib/plan";
import { cn } from "@/lib/utils";

/**
 * "Why this GPU?": every machine the planner could have used, as its estimated
 * cost range on one shared dollar axis. The chosen one carries the accent and a
 * "Chosen" label; the alternatives stay gray, so the comparison reads at a glance.
 */
export function GpuCompare({ plan }: { plan: PlanDoc }) {
  const [hover, setHover] = useState<string | null>(null);
  const rows = [
    { ...plan.selected, chosen: true },
    ...plan.alternatives.filter((a) => a.offer.type !== plan.selected.offer.type).map((a) => ({ ...a, chosen: false })),
  ].sort((a, b) => a.estimate.cost_high_cents - b.estimate.cost_high_cents);
  const top = niceCents(Math.max(...rows.map((r) => r.estimate.cost_high_cents), 1));
  const ticks = [0, top / 2, top];
  const req = plan.requirements;
  const why = req.rationale[0];

  return (
    <div className="space-y-4 border-t px-5 py-4">
      <div>
        <h4 className="text-[13px] font-medium">Why this GPU</h4>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Needs at least {req.min_vram_gb} GB of GPU memory{plan.intent.preference ? `, optimizing for ${plan.intent.preference}` : ""}.
          {why ? ` ${why}` : ""}
        </p>
      </div>

      <ol className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const lo = (r.estimate.cost_low_cents / top) * 100;
          const hi = (r.estimate.cost_high_cents / top) * 100;
          const key = r.offer.type;
          return (
            <li
              key={key}
              tabIndex={0}
              onPointerEnter={() => setHover(key)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(key)}
              onBlur={() => setHover(null)}
              aria-label={`${r.offer.gpu}, ${r.offer.vram_gb} GB, ${centsRange(r.estimate.cost_low_cents, r.estimate.cost_high_cents)}${r.chosen ? ", chosen" : ""}`}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex items-baseline gap-3">
                <span className={cn("min-w-0 truncate text-[13px]", r.chosen && "font-medium")}>
                  {r.offer.gpu} · {r.offer.vram_gb} GB
                  <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground tabular">${r.offer.price_per_hour.toFixed(2)}/hr</span>
                </span>
                {r.chosen && <span className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] text-foreground">Chosen</span>}
                <span className={cn("ml-auto shrink-0 text-[13px] tabular", r.chosen ? "font-medium" : "text-muted-foreground")}>
                  {centsRange(r.estimate.cost_low_cents, r.estimate.cost_high_cents)}
                </span>
              </div>
              {/* Range bar from the low to the high estimate, on the shared axis below. */}
              <span className="relative mt-1 block h-3">
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span
                  className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[4px] transition-opacity"
                  style={{
                    left: `${lo}%`,
                    width: `max(${hi - lo}%, 6px)`,
                    background: r.chosen ? "var(--chart-1)" : "var(--chart-4)",
                    opacity: hover == null || hover === key ? 1 : 0.45,
                  }}
                />
                {hover === key && (
                  <span
                    className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
                    style={{ left: `${Math.min(lo, 45)}%` }}
                  >
                    <span className="block font-medium tabular">{centsRange(r.estimate.cost_low_cents, r.estimate.cost_high_cents)}</span>
                    <span className="block text-muted-foreground">
                      {r.offer.label} · {r.offer.vcpus} vCPU · {r.offer.ram_gb} GB RAM
                    </span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="relative h-4 border-t" aria-hidden>
        {ticks.map((t, i) => (
          <span
            key={t}
            className={cn(
              "absolute top-1 text-[10.5px] text-muted-foreground tabular",
              i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
            )}
            style={{ left: `${(t / top) * 100}%` }}
          >
            {cents(t)}
          </span>
        ))}
      </div>
      <p className="text-[11.5px] text-muted-foreground">Estimated total cost for this task. Live Brev prices.</p>
    </div>
  );
}

/** Round the axis top up to a clean dollar amount. */
function niceCents(v: number): number {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 10000) * 10000;
}
