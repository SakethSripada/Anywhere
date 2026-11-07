"use client";

import type { Workload } from "@anywhere/stdb";
import { useMemo, useState, type ReactNode } from "react";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/data";
import { cents, clock, duration, ms, perHour } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";
import { BILLABLE, BOOT_STEPS, liveCents } from "@/lib/workloads";
import { IconCheck } from "../icons";
import { Button } from "../ui/button";
import { DialogClose, DialogContent, DialogRoot } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toast } from "../ui/toast";

export type Action = "approve" | "cancel" | "stop" | "resume" | "save" | "delete";

const DONE_MSG: Partial<Record<Action, string>> = {
  stop: "Stopping — your files are saved first",
  resume: "Resuming your desktop",
  delete: "Deleting the machine",
  cancel: "Cancelled",
};

export function useWorkloadAction(id: bigint) {
  const api = useApi();
  const [busy, setBusy] = useState<Action | null>(null);
  async function run(action: Action) {
    setBusy(action);
    try {
      await api.post(`/v1/workloads/${id}/${action}`);
      if (DONE_MSG[action]) toast.info(DONE_MSG[action]);
      return true;
    } catch (err) {
      toast.error("That didn't work", err instanceof ApiError ? err.message : undefined);
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

/** Spend so far, ticking smoothly between server updates while billing. */
export function LiveCost({ w, className }: { w: Workload; className?: string }) {
  const now = useNow(1000);
  const billing = BILLABLE.has(w.status);
  return (
    <span className={cn("tabular inline-flex items-baseline gap-1.5", className)}>
      <span className="font-medium text-fg">{cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}</span>
      <span className="text-fg-faint">{billing ? perHour(w.hourlyCents) : "total"}</span>
    </span>
  );
}

export function Uptime({ w }: { w: Workload }) {
  const now = useNow(15_000);
  if (!w.startedAt || !now) return <>—</>;
  const end = BILLABLE.has(w.status) ? now : ms(w.updatedAt);
  return <>{duration(end - ms(w.startedAt))}</>;
}

export function BootProgress({ w }: { w: Workload }) {
  const idx = BOOT_STEPS.findIndex((s) => s.status === w.status);
  return (
    <ol className="flex flex-col gap-0.5">
      {BOOT_STEPS.map((step, i) => {
        const state = i < idx ? "done" : i === idx ? "current" : "todo";
        return (
          <li key={step.status} className="relative flex gap-3.5 pb-5 last:pb-0">
            {i < BOOT_STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn("absolute top-7 bottom-1 left-[13px] w-px transition-colors duration-500", state === "done" ? "bg-ok/40" : "bg-line")}
              />
            )}
            <span
              className={cn(
                "relative grid size-[27px] shrink-0 place-items-center rounded-full transition-[background-color,box-shadow] duration-300",
                state === "done" && "bg-ok-soft text-ok",
                state === "current" && "bg-busy-soft text-busy shadow-[0_0_0_4px_var(--color-busy-soft)]",
                state === "todo" && "bg-white/[0.03] text-fg-faint shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
              )}
            >
              {state === "done" ? <IconCheck size={13} /> : state === "current" ? <Spinner size={13} /> : <span className="size-1.5 rounded-full bg-current" />}
            </span>
            <div className="pt-0.5">
              <div className={cn("text-sm font-medium", state === "todo" ? "text-fg-faint" : "text-fg")}>{step.label}</div>
              <div className={cn("text-xs", state === "current" ? "text-fg-subtle" : "text-fg-faint")}>
                {state === "current" && w.statusDetail ? w.statusDetail : step.hint}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const LEVEL_DOT: Record<string, string> = {
  info: "bg-fg-faint",
  warn: "bg-wait",
  warning: "bg-wait",
  error: "bg-bad",
  success: "bg-ok",
};

export function EventFeed({ workloadId, limit = 50, className }: { workloadId: bigint; limit?: number; className?: string }) {
  const [rows] = useTable(tables.myEvents);
  const events = useMemo(
    () =>
      rows
        .filter((e) => e.workloadId === workloadId)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit),
    [rows, workloadId, limit],
  );
  if (!events.length) return <p className={cn("text-xs text-fg-faint", className)}>No activity yet.</p>;
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {events.map((e) => (
        <li key={String(e.id)} className="flex animate-fade-in items-baseline gap-2.5 text-xs">
          <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", LEVEL_DOT[e.level] ?? "bg-fg-faint")} />
          <span className="min-w-0 flex-1 text-fg-muted">{e.message}</span>
          <span className="shrink-0 tabular text-fg-faint">{clock(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  tone = "danger",
  onConfirm,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirm: string;
  tone?: "danger" | "primary";
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Keep it</DialogClose>
            <Button variant={tone === "danger" ? "danger" : "primary"} size="sm" loading={busy} onClick={() => void onConfirm()}>
              {confirm}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </DialogRoot>
  );
}

export function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-canvas/40 px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]", className)}>
      <div className="text-xs text-fg-faint">{label}</div>
      <div className="mt-1 truncate text-md text-fg">{children}</div>
    </div>
  );
}
