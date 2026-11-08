"use client";

import type { Workload } from "@anywhere/stdb";
import { useState, type ReactNode } from "react";
import { useNow } from "@/lib/data";
import { clockSeconds, elapsed, useBootTimeline, useGpuTelemetry, type Boot } from "@/lib/insights";
import { cn } from "@/lib/utils";
import { TelemetryChart } from "./telemetry-chart";

/**
 * The machine's insights, one panel per question, spaced so nothing crowds:
 * what the GPU is doing right now, and where the boot time went.
 */
export function Insights({ w }: { w: Workload }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-8">
        <GpuPanel w={w} />
        <BootPanel w={w} />
      </div>
    </div>
  );
}

function Panel({ title, subtitle, aside, children }: { title: string; subtitle: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-start gap-4 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>
        </div>
        {aside && <div className="ml-auto shrink-0">{aside}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ── GPU ─────────────────────────────────────────────────────────────────── */

const pct = (v: number) => `${Math.round(v)}%`;
const gb = (v: number) => `${v === 0 ? 0 : v.toFixed(v < 10 ? 1 : 0)} GB`;
const deg = (v: number) => `${Math.round(v)}°C`;
const watts = (v: number) => `${Math.round(v)} W`;

function GpuPanel({ w }: { w: Workload }) {
  const g = useGpuTelemetry(w.id);
  const live = w.status === "running";
  const latest = (s: { v: number }[]) => s.at(-1)?.v;
  const has = g.util.length > 0;

  return (
    <Panel
      title={`GPU · NVIDIA ${w.gpuName || "GPU"}`}
      subtitle={live ? "Live from nvidia-smi on the machine, every 10 seconds" : "Readings from while the machine was running"}
      aside={live && has ? <LiveDot /> : undefined}
    >
      {!has ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          {live ? "Waiting for the first reading from the GPU…" : "GPU readings appear while the machine is running."}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Utilization" value={pct(latest(g.util) ?? 0)} />
            <Stat
              label="VRAM in use"
              value={gb(latest(g.mem) ?? 0)}
              sub={g.memTotal ? `of ${gb(g.memTotal)}` : undefined}
            />
            <Stat label="Temperature" value={latest(g.temp) != null ? deg(latest(g.temp)!) : "-"} />
            <Stat label="Power draw" value={latest(g.power) != null ? watts(latest(g.power)!) : "-"} sub={latest(g.power) == null ? "Not reported" : undefined} />
          </dl>
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
            <ChartBlock title="Utilization">
              <TelemetryChart points={g.util} label="GPU utilization" format={pct} max={100} />
            </ChartBlock>
            <ChartBlock title="VRAM in use">
              <TelemetryChart points={g.mem} label="VRAM in use" format={gb} max={g.memTotal ?? undefined} />
            </ChartBlock>
            <ChartBlock title="Temperature">
              <TelemetryChart points={g.temp} label="GPU temperature" format={deg} />
            </ChartBlock>
            <ChartBlock title="Power draw">
              <TelemetryChart points={g.power} label="GPU power draw" format={watts} />
            </ChartBlock>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border px-4 py-3">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      {/* Proportional figures on standalone values (tabular only where numbers align in columns). */}
      <dd className="mt-1 text-[22px] font-semibold tracking-tight">{value}</dd>
      {sub && <dd className="text-[12px] text-muted-foreground">{sub}</dd>}
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[13px] font-medium">{title}</h3>
      {children}
    </div>
  );
}

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/60" />
        <span className="relative size-2 rounded-full bg-brand" />
      </span>
      Live
    </span>
  );
}

/* ── Boot timeline ───────────────────────────────────────────────────────── */

function BootPanel({ w }: { w: Workload }) {
  const now = useNow(1000);
  const boot = useBootTimeline(w.id, now);
  return (
    <Panel
      title="Boot timeline"
      subtitle={
        boot
          ? boot.kind === "resume"
            ? "From Resume to ready, stage by stage"
            : "From approval to a ready machine, stage by stage"
          : "Where the time goes between asking for a machine and using it"
      }
      aside={
        boot && (
          <div className="text-right">
            <div className="text-[22px] font-semibold tracking-tight">{elapsed(boot.total)}</div>
            <div className="text-[12px] text-muted-foreground">
              {boot.done ? (boot.kind === "resume" ? "Resumed" : "Cold start") : "In progress"}
            </div>
          </div>
        )
      }
    >
      {boot ? <Waterfall boot={boot} /> : <p className="py-6 text-center text-[13px] text-muted-foreground">The timeline appears once the machine starts booting.</p>}
    </Panel>
  );
}

const ROW = 30;
const BAR = 14;

/**
 * Each stage is a bar placed where it started and as long as it took, on one
 * shared time axis. The longest stage carries the accent; the rest stay gray,
 * so the eye lands on the bottleneck. Every row names its stage and duration in
 * text, so nothing depends on color alone.
 */
function Waterfall({ boot }: { boot: Boot }) {
  const [hover, setHover] = useState<number | null>(null);
  const span = Math.max(boot.total, 1);
  const longest = boot.stages.reduce((best, s, i, all) => (s.end - s.start > all[best].end - all[best].start ? i : best), 0);
  const ticks = timeTicks(span);

  const cols = "grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_4.5rem] items-center gap-x-4";
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col">
        {boot.stages.map((s, i) => {
          const dur = s.end - s.start;
          const left = (s.start / span) * 100;
          const width = Math.max((dur / span) * 100, 0.6);
          const accent = i === longest && boot.stages.length > 1;
          return (
            <li
              key={`${s.label}-${i}`}
              className={cn(cols, "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50")}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${s.label}: ${elapsed(dur)}, starting at ${clockSeconds(s.start / 1000)}`}
            >
              <span className={cn("truncate py-1.5 text-[13px]", hover === i ? "text-foreground" : "text-foreground/85")} title={s.label}>
                {s.label}
              </span>
              <span className="relative block" style={{ height: ROW }}>
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span
                  className={cn("absolute top-1/2 -translate-y-1/2 rounded-[4px] transition-opacity", s.open && "animate-pulse")}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    height: BAR,
                    background: accent ? "var(--chart-1)" : "var(--chart-4)",
                    opacity: hover == null || hover === i ? 1 : 0.45,
                  }}
                />
                {hover === i && (
                  <span
                    className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
                    style={{ left: `${Math.min(left, 70)}%` }}
                  >
                    <span className="block font-medium tabular">{elapsed(dur)}</span>
                    <span className="block text-muted-foreground tabular">starts at +{clockSeconds(s.start / 1000)}</span>
                  </span>
                )}
              </span>
              <span className={cn("text-right text-[13px] tabular", accent ? "font-medium text-foreground" : "text-muted-foreground")}>
                {s.open ? `${elapsed(dur)}…` : elapsed(dur)}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Shared time axis under the bars. */}
      <div className={cols} aria-hidden>
        <span />
        <span className="relative mt-1 block h-5 border-t">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-1 -translate-x-1/2 text-[10.5px] text-muted-foreground tabular first:translate-x-0"
              style={{ left: `${(t / span) * 100}%` }}
            >
              {clockSeconds(t / 1000)}
            </span>
          ))}
        </span>
        <span />
      </div>
      {boot.stages.length > 1 && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{boot.stages[longest].label}</span> took{" "}
          {Math.round(((boot.stages[longest].end - boot.stages[longest].start) / span) * 100)}% of the time.
        </p>
      )}
    </div>
  );
}

/** Clean minute (or 15-second) marks across the span, ending inside it. */
function timeTicks(spanMs: number): number[] {
  const steps = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = steps.find((s) => spanMs / s <= 5) ?? 900_000;
  const out: number[] = [];
  for (let t = 0; t <= spanMs - step * 0.35; t += step) out.push(t);
  return out;
}
