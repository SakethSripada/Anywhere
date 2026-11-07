"use client";

import type { Workload } from "@anywhere/stdb";
import { ArrowUpRight, Monitor } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useWorkloads } from "@/lib/data";
import { centsRange } from "@/lib/format";
import { parsePlan } from "@/lib/plan";
import { BILLABLE, href } from "@/lib/workloads";
import { DesktopPreview, JobPreview, MachineCard } from "../machines/machine-card";
import { BootProgress, LiveCost, Uptime } from "../machines/shared";
import { StatusChip } from "../machines/status";
import { PlanCard } from "./plan-card";

/** The machines this task is about: plan → approval → boot → running, always in view. */
export function ContextPanel({ conversationId }: { conversationId: bigint | null }) {
  const { all } = useWorkloads();
  const items = useMemo(
    () => (conversationId == null ? [] : all.filter((w) => w.conversationId === conversationId && w.status !== "terminated").sort((a, b) => Number(b.createdAt.toMillis() - a.createdAt.toMillis()))),
    [all, conversationId],
  );

  return (
    <aside className="hidden w-[380px] shrink-0 flex-col overflow-y-auto border-l bg-subtle xl:flex">
      <div className="flex h-12 shrink-0 items-center border-b px-4 text-[13px] font-medium text-muted-foreground">This task</div>
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span className="mb-3 grid size-10 place-items-center rounded-xl border bg-background text-muted-foreground">
            <Monitor className="size-5" />
          </span>
          <p className="text-sm font-medium">No machine yet</p>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">When Anywhere proposes a plan for this task, you’ll review and approve it here, then watch it come up.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {items.map((w, i) => (
            <Entry key={String(w.id)} w={w} primary={i === 0} />
          ))}
        </div>
      )}
    </aside>
  );
}

function Entry({ w, primary }: { w: Workload; primary: boolean }) {
  if (w.status === "planned")
    return (
      <div className="flex flex-col gap-4">
        <PlanCard workloadId={w.id} />
        {primary && (
          <div className="px-1">
            <div className="mb-2 text-xs font-medium text-muted-foreground">What happens when you approve</div>
            <ol className="flex flex-col gap-2 text-[13px]">
              {(w.kind === "desktop"
                ? ["Anywhere reserves the GPU on NVIDIA Brev", "It installs the desktop and your apps", "You open it here and work in the browser", "Stop any time — your files are saved first"]
                : ["Anywhere reserves the GPU on NVIDIA Brev", "It downloads your dataset and starts training", "Watch loss and logs live; ask the agent anything", "Results are saved and the machine shuts down"]
              ).map((t, i) => (
                <li key={t} className="flex gap-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full border bg-background text-[11px] font-medium text-muted-foreground tabular">{i + 1}</span>
                  <span className="pt-px text-foreground/80">{t}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    );
  if (["approved", "provisioning", "configuring"].includes(w.status)) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <Header w={w} />
        <div className="progress-indeterminate my-4 h-1 rounded-full bg-muted" />
        <BootProgress w={w} />
        <p className="mt-4 text-xs leading-5 text-muted-foreground">Usually 5–10 minutes. You can leave this page — Anywhere keeps going and notifies you.</p>
      </div>
    );
  }
  if (!primary || !BILLABLE.has(w.status)) return <MachineCard w={w} />;
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <Header w={w} />
      <div className="h-32">{w.kind === "desktop" ? <DesktopPreview w={w} /> : <JobPreview w={w} />}</div>
      <dl className="grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <dt className="text-xs text-muted-foreground">Running for</dt>
          <dd className="mt-0.5 font-medium tabular">
            <Uptime w={w} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Spent</dt>
          <dd className="mt-0.5 font-medium">
            <LiveCost w={w} />
          </dd>
        </div>
      </dl>
      <Button nativeButton={false} render={<Link href={href(w)} />}>
        {w.kind === "desktop" ? "Open desktop" : "Open job"}
        <ArrowUpRight className="size-4" />
      </Button>
    </div>
  );
}

function Header({ w }: { w: Workload }) {
  const plan = parsePlan(w.planJson);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{w.title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          NVIDIA {w.gpuName}
          {plan && ` · est. ${centsRange(plan.selected.estimate.cost_low_cents, plan.selected.estimate.cost_high_cents)}`}
        </div>
      </div>
      <StatusChip status={w.status} />
    </div>
  );
}
