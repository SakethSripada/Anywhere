"use client";

import type { AgentStep, Workload } from "@anywhere/stdb";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";

export function useRunSteps(runId: bigint | null) {
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const run = runId == null ? undefined : runs.find((r) => r.id === runId);
  const list = useMemo(
    () => (runId == null ? [] : steps.filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq)),
    [steps, runId],
  );
  return { run, steps: list };
}

/** Presigned URL for the newest screenshot the agent took, if storage is configured. */
function useLatestShot(steps: AgentStep[]) {
  const api = useApi();
  const key = [...steps].reverse().find((s) => s.screenshotKey)?.screenshotKey ?? null;
  const [shot, setShot] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api
      .get<{ url: string }>(`/v1/files?key=${encodeURIComponent(key)}`)
      .then(({ url }) => !cancelled && setShot({ key, url }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, key]);
  return shot && shot.key === key ? shot.url : null;
}

export function StepList({ steps, live, className }: { steps: AgentStep[]; live: boolean; className?: string }) {
  return (
    <ol className={cn("flex flex-col gap-1 text-[13px] leading-5", className)}>
      {steps.map((s) => (
        <li
          key={String(s.id)}
          className={cn(
            "animate-in duration-200 fade-in-0",
            s.kind === "observe" ? "text-muted-foreground" : s.kind === "error" ? "text-destructive" : "text-foreground/85",
          )}
        >
          {s.summary}
        </li>
      ))}
      {live && <li className="shimmer-text w-fit">Working</li>}
    </ol>
  );
}

/** Live view of a desktop agent run inside the chat thread. */
export function AgentRunInline({ workload, runId }: { workload: Workload; runId: bigint }) {
  const { run, steps } = useRunSteps(runId);
  const shot = useLatestShot(steps);
  const live = run?.status === "running" && workload.controller === "agent";

  return (
    <div className="flex flex-col gap-3 py-2">
      {shot && (
        <Link href={`/w/${workload.id}`} className="group relative block w-full max-w-md overflow-hidden rounded-xl border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived URL */}
          <img src={shot} alt="Latest screenshot from the desktop" className="aspect-video w-full object-cover" />
          <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/30">
            <span className="rounded-full bg-background px-3 py-1.5 text-xs font-medium opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              Watch live
            </span>
          </span>
        </Link>
      )}
      <StepList steps={steps.slice(-8)} live={live} className="border-l pl-3.5" />
      {run && run.status !== "running" && run.result && (
        <p className={cn("text-[13px]", run.status === "done" ? "text-muted-foreground" : "text-destructive")}>{run.result}</p>
      )}
      <Link
        href={`/w/${workload.id}`}
        className="w-fit text-[13px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {live ? "Watch it live" : "Open desktop"}
      </Link>
    </div>
  );
}
