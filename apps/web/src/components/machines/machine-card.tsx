"use client";

import type { Workload } from "@anywhere/stdb";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useNow } from "@/lib/data";
import { cents } from "@/lib/format";
import { parsePlan } from "@/lib/plan";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";
import { BILLABLE, href, liveCents } from "@/lib/workloads";
import { Uptime } from "./shared";
import { StatusChip } from "./status";

const APP: Record<string, string> = { blender: "Blender", vscode: "VS Code", jupyter: "JupyterLab", terminal: "Linux desktop" };

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${max === min ? 50 : 92 - ((v - min) / (max - min)) * 84}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={cn("h-full w-full", className)} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function DesktopPreview({ w }: { w: Workload }) {
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const run = useMemo(() => runs.filter((r) => r.workloadId === w.id).sort((a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis()))[0], [runs, w.id]);
  const last = useMemo(() => (run ? steps.filter((s) => s.runId === run.id).sort((a, b) => b.seq - a.seq)[0] : undefined), [steps, run]);
  const app = APP[parsePlan(w.planJson)?.intent.application ?? ""] ?? "Desktop";
  const live = w.status === "running";
  const working = live && run?.status === "running" && w.controller === "agent";
  return (
    <div className={cn("relative flex h-full flex-col justify-between overflow-hidden rounded-lg bg-screen p-3 text-white", !live && "opacity-70")}>
      <div className="flex items-center gap-1.5 text-[11px] text-white/60">
        <span className="flex gap-1">
          <span className="size-1.5 rounded-full bg-white/25" />
          <span className="size-1.5 rounded-full bg-white/25" />
          <span className="size-1.5 rounded-full bg-white/25" />
        </span>
        <span className="ml-1 truncate">{app}</span>
        {working && <span className="ml-auto rounded bg-success/90 px-1.5 py-px text-[10px] font-semibold tracking-wide text-white">AGENT</span>}
        {live && !working && <span className="ml-auto text-[10px] tracking-wide text-white/50">{w.controller === "user" ? "YOU" : "IDLE"}</span>}
      </div>
      <div className="min-w-0">
        {working && last ? (
          <p className="truncate text-xs text-white/80">{last.summary}</p>
        ) : live ? (
          <p className="text-xs text-white/50">Ready — open to stream</p>
        ) : (
          <p className="text-xs text-white/50">{w.statusDetail || "Not running"}</p>
        )}
      </div>
    </div>
  );
}

export function JobPreview({ w }: { w: Workload }) {
  const [metrics] = useTable(tables.myMetrics);
  const loss = useMemo(
    () =>
      metrics
        .filter((m) => m.workloadId === w.id && m.name === "loss")
        .sort((a, b) => a.step - b.step)
        .map((m) => m.value),
    [metrics, w.id],
  );
  const latest = loss.at(-1);
  return (
    <div className="flex h-full flex-col justify-between rounded-lg border bg-subtle p-3">
      <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>Training loss</span>
        {latest != null && <span className="font-mono text-xs text-foreground tabular">{latest.toFixed(3)}</span>}
      </div>
      <div className="h-10">{loss.length > 1 ? <Sparkline values={loss.slice(-120)} /> : <p className="text-xs text-muted-foreground">{w.statusDetail || "Waiting for metrics"}</p>}</div>
    </div>
  );
}

export function MachineCard({ w }: { w: Workload }) {
  const now = useNow(2000);
  return (
    <Link
      href={href(w)}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-(--shadow-card) transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-foreground/15 hover:shadow-(--shadow-float)"
    >
      <div className="h-24">{w.kind === "desktop" ? <DesktopPreview w={w} /> : <JobPreview w={w} />}</div>
      <div className="flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1 truncate text-sm font-medium">
            <span className="truncate">{w.title}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {w.gpuName} · {BILLABLE.has(w.status) ? (
              <>
                <Uptime w={w} /> · {cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}
              </>
            ) : w.status === "planned" ? (
              `up to ${cents(w.estHighCents)}`
            ) : (
              `${cents(w.accruedCents, { precise: true })} total`
            )}
          </div>
        </div>
        <StatusChip status={w.status} />
      </div>
    </Link>
  );
}
