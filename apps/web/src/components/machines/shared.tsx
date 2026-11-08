"use client";

import type { Workload } from "@anywhere/stdb";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, useApi } from "@/lib/api";
import { useNow } from "@/lib/data";
import { cents, clock, duration, ms, perHour } from "@/lib/format";
import { NONE, useShared } from "@/lib/tables";
import { cn } from "@/lib/utils";
import { BILLABLE, BOOT_STEPS, liveCents } from "@/lib/workloads";

export type Action = "approve" | "cancel" | "stop" | "resume" | "save" | "delete";

const DONE: Partial<Record<Action, string>> = {
  stop: "Saving files, then stopping",
  resume: "Resuming",
  delete: "Deleting the machine",
  cancel: "Cancelled",
  save: "Saving project files",
};

export function useWorkloadAction(id: bigint) {
  const api = useApi();
  const [busy, setBusy] = useState<Action | null>(null);
  async function run(action: Action) {
    setBusy(action);
    try {
      await api.post(`/v1/workloads/${id}/${action}`);
      if (DONE[action]) toast(DONE[action]);
      return true;
    } catch (err) {
      toast.error("That didn’t work", { description: err instanceof ApiError ? err.message : undefined });
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

export function LiveCost({ w, className }: { w: Workload; className?: string }) {
  const now = useNow(1000);
  return (
    <span className={cn("tabular", className)}>
      {cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}
      {BILLABLE.has(w.status) && <span className="text-muted-foreground"> · {perHour(w.hourlyCents)}</span>}
    </span>
  );
}

export function Uptime({ w }: { w: Workload }) {
  const now = useNow(15_000);
  if (!w.startedAt || !now) return <>-</>;
  const end = BILLABLE.has(w.status) ? now : ms(w.updatedAt);
  return <>{duration(end - ms(w.startedAt))}</>;
}

export function BootProgress({ w }: { w: Workload }) {
  const idx = BOOT_STEPS.findIndex((s) => s.status === w.status);
  return (
    <ol className="flex flex-col gap-3">
      {BOOT_STEPS.map((step, i) => {
        const state = i < idx ? "done" : i === idx ? "current" : "todo";
        return (
          <li key={step.status} className="flex gap-3">
            <span className="grid h-6 w-4 shrink-0 place-items-center">
              {state === "done" ? <Check className="size-3.5 text-muted-foreground" /> : <span className={cn("size-1.5 rounded-full", state === "current" ? "bg-foreground" : "bg-border")} />}
            </span>
            <div>
              <div className={cn("text-sm leading-6", state === "current" ? "shimmer-text" : state === "done" ? "text-muted-foreground" : "text-muted-foreground/60")}>
                {step.label}
              </div>
              {state === "current" && <div className="text-[13px] text-muted-foreground">{w.statusDetail || step.hint}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const LEVEL: Record<string, string> = { warn: "bg-warning", warning: "bg-warning", error: "bg-destructive", success: "bg-success" };

export function EventFeed({ workloadId, limit = 50, className }: { workloadId: bigint; limit?: number; className?: string }) {
  const rows = useShared("myEvents").byWorkload.get(workloadId) ?? NONE;
  const events = useMemo(() => [...rows].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit), [rows, limit]);
  if (!events.length) return <p className={cn("text-[13px] text-muted-foreground", className)}>No activity yet.</p>;
  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {events.map((e) => (
        <li key={String(e.id)} className="flex items-baseline gap-2.5 text-[13px]">
          <span className={cn("size-1.5 shrink-0 -translate-y-px rounded-full", LEVEL[e.level] ?? "bg-muted-foreground/50")} />
          <span className="min-w-0 flex-1">{e.message}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular">{clock(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
