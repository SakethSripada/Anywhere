"use client";

import type { Workload } from "@anywhere/stdb";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useAgentState } from "@/lib/agent";
import { useNow } from "@/lib/data";
import { cents } from "@/lib/format";
import { NONE, useShared } from "@/lib/tables";
import { cn } from "@/lib/utils";
import { BILLABLE, href, liveCents } from "@/lib/workloads";
import { AppLogo, appKey, appName } from "../app/app-logo";
import { Uptime } from "./shared";
import { StatusChip } from "./status";


export function Sparkline({ values, className, fill = true }: { values: number[]; className?: string; fill?: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, max === min ? 50 : 92 - ((v - min) / (max - min)) * 84] as const);
  const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={cn("h-full w-full", className)} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <polygon points={`0,100 ${line} 100,100`} fill="url(#spark-fill)" />}
      <polyline points={line} fill="none" stroke="var(--chart-1)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function DesktopPreview({ w }: { w: Workload }) {
  const { working, last } = useAgentState(w);
  const app = appKey(w);
  const live = w.status === "running";
  return (
    <div className={cn("relative flex h-full flex-col overflow-hidden rounded-[7px] canvas-dots text-white", working && "agent-glow")}>
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-white/[0.05] bg-black/40 px-2.5 text-[10.5px] text-white/50">
        <span className="flex gap-1">
          <span className="size-1.5 rounded-full bg-white/20" />
          <span className="size-1.5 rounded-full bg-white/20" />
          <span className="size-1.5 rounded-full bg-white/20" />
        </span>
        <AppLogo app={app} size={11} className="ml-1" />
        <span className="truncate">{appName(app)}</span>
        {working && (
          <span className="ml-auto flex items-center gap-1 rounded bg-agent px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-white" /> AGENT
          </span>
        )}
        {live && !working && <span className="ml-auto text-[9.5px] tracking-wide text-white/40">{w.controller === "user" ? "YOU" : "IDLE"}</span>}
      </div>
      <div className="flex min-h-0 flex-1 items-end p-2.5">
        {working && last ? (
          <p className="truncate text-[11.5px] text-white/85">
            <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-agent align-middle" />
            {last.summary}
          </p>
        ) : live ? (
          <p className="text-[11.5px] text-white/45">Ready</p>
        ) : (
          <p className="truncate text-[11.5px] text-white/45">{w.statusDetail || "Not running"}</p>
        )}
      </div>
    </div>
  );
}

export function JobPreview({ w }: { w: Workload }) {
  const mine = useShared("myMetrics").byWorkload.get(w.id) ?? NONE;
  const { loss, progress } = useMemo(() => {
    return {
      loss: mine
        .filter((m) => m.name === "loss")
        .sort((a, b) => a.step - b.step)
        .map((m) => m.value),
      progress: mine.filter((m) => m.name === "progress").sort((a, b) => b.step - a.step)[0]?.value,
    };
  }, [mine]);
  const latest = loss.at(-1);
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[7px] bg-inset">
      <div className="flex items-baseline justify-between px-2.5 pt-2 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <AppLogo app="pytorch" size={11} /> loss
        </span>
        {latest != null && <span className="text-[11.5px] text-foreground tabular">{latest.toFixed(3)}</span>}
      </div>
      <div className="min-h-0 flex-1">
        {loss.length > 1 ? <Sparkline values={loss.slice(-160)} /> : <p className="px-2.5 pt-2 text-[11.5px] text-muted-foreground">{w.statusDetail || "Waiting for metrics"}</p>}
      </div>
      {progress != null && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
          <div className="h-full bg-brand" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export function MachineCard({ w }: { w: Workload }) {
  const now = useNow(2000, BILLABLE.has(w.status));
  return (
    <Link
      href={href(w)}
      className="group flex flex-col gap-3 rounded-card bg-card p-2.5 shadow-hairline transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-overlay"
    >
      <div className="h-28">{w.kind === "desktop" ? <DesktopPreview w={w} /> : <JobPreview w={w} />}</div>
      <div className="flex items-start justify-between gap-2 px-1 pb-0.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-[13px] font-medium">
            <span className="truncate">{w.title}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
            <span>{w.gpuName}</span> ·{" "}
            {BILLABLE.has(w.status) ? (
              <>
                <Uptime w={w} /> · <span className="tabular">{cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}</span>
              </>
            ) : w.status === "planned" ? (
              `up to ${cents(w.estHighCents)}`
            ) : (
              `${cents(w.accruedCents, { precise: true })} total`
            )}
          </div>
        </div>
        <StatusChip status={w.status} className="text-[12px]" />
      </div>
    </Link>
  );
}
