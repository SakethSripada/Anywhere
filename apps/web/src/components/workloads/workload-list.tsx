"use client";

import type { Workload } from "@anywhere/stdb";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useNow, useWorkloads } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { ACTIVE, BILLABLE, href, liveCents } from "@/lib/workloads";
import { IconArrowRight, IconDesktop, IconPlus, IconWorkload } from "../icons";
import { StatusPill } from "../ui/status";
import { Segmented } from "../ui/tabs";
import { Uptime } from "./shared";

type Filter = "active" | "queued" | "completed" | "failed" | "all";

const MATCH: Record<Filter, (w: Workload) => boolean> = {
  active: (w) => BILLABLE.has(w.status),
  queued: (w) => w.status === "planned" || w.status === "approved",
  completed: (w) => ["succeeded", "stopped", "cancelled"].includes(w.status),
  failed: (w) => w.status === "failed",
  all: () => true,
};

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-4 px-5 pt-7 pb-5 sm:px-8">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tighter text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-subtle">{description}</p>}
      </div>
      {actions}
    </header>
  );
}

export function NewTaskLink({ children = "New task" }: { children?: ReactNode }) {
  return (
    <Link
      href="/"
      className="group inline-flex h-8 items-center gap-1.5 rounded-md bg-raised px-3 text-sm font-medium text-fg shadow-[inset_0_1px_0_0_oklch(1_0_0/0.06),0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0_0_0/0.3)] outline-none transition-colors hover:bg-overlay focus-ring"
    >
      <IconPlus size={14} className="text-fg-muted transition-transform duration-200 ease-spring group-hover:rotate-90" />
      {children}
    </Link>
  );
}

export function WorkloadList() {
  const { workloads, ready } = useWorkloads();
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(
    () => Object.fromEntries((Object.keys(MATCH) as Filter[]).map((f) => [f, workloads.filter(MATCH[f]).length])) as Record<Filter, number>,
    [workloads],
  );
  const rows = workloads.filter(MATCH[filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Workloads" description="Everything Anywhere has planned, run, or is running for you." actions={<NewTaskLink />} />
      <div className="px-5 pb-4 sm:px-8">
        <Segmented
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "all", label: "All", count: counts.all },
            { value: "active", label: "Active", count: counts.active },
            { value: "queued", label: "Queued", count: counts.queued },
            { value: "completed", label: "Completed", count: counts.completed },
            { value: "failed", label: "Failed", count: counts.failed },
          ]}
        />
      </div>
      <div className="px-5 pb-10 sm:px-8">
        <div className="overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--color-line)]">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_9rem_minmax(0,1.2fr)_5rem_6rem_6rem] gap-4 border-b border-line bg-canvas/30 px-4 py-2 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint md:grid">
            <span>Task</span>
            <span>Status</span>
            <span>Machine</span>
            <span>Runtime</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Updated</span>
          </div>
          {!ready ? (
            <div className="space-y-px">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-4 py-3.5">
                  <div className="skeleton h-4 w-1/2" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <span className="mb-3 grid size-10 place-items-center rounded-xl bg-white/[0.04] text-fg-subtle">
                <IconWorkload size={18} />
              </span>
              <p className="text-sm text-fg-muted">{filter === "all" ? "No workloads yet" : `Nothing ${filter} right now`}</p>
              <p className="mt-1 text-xs text-fg-faint">Describe a task in the workspace and Anywhere will plan the compute for it.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((w) => (
                <Row key={String(w.id)} w={w} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ w }: { w: Workload }) {
  const now = useNow(5000);
  return (
    <li>
      <Link
        href={href(w)}
        className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 outline-none transition-colors duration-100 hover:bg-hover focus-visible:bg-hover md:grid-cols-[minmax(0,2.2fr)_9rem_minmax(0,1.2fr)_5rem_6rem_6rem]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.04] text-fg-subtle">
            {w.kind === "desktop" ? <IconDesktop size={14} /> : <IconWorkload size={14} />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">{w.title}</div>
            <div className="truncate text-xs text-fg-faint">{w.summary}</div>
          </div>
        </div>
        <div className="justify-self-end md:justify-self-start">
          <StatusPill status={w.status} />
        </div>
        <span className="hidden truncate text-sm text-fg-subtle md:block">{w.gpuName}</span>
        <span className="hidden text-sm text-fg-subtle tabular md:block">
          <Uptime w={w} />
        </span>
        <span className="hidden text-right text-sm text-fg-muted tabular md:block">
          {w.status === "planned" ? <span className="text-fg-faint">≤ {cents(w.estHighCents)}</span> : cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}
        </span>
        <span className="hidden items-center justify-end gap-1.5 text-xs text-fg-faint md:flex">
          {ago(w.updatedAt, now || undefined)}
          <IconArrowRight size={12} className={cn("-mr-1 opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100")} />
        </span>
      </Link>
    </li>
  );
}

export function DesktopGrid() {
  const { workloads, ready } = useWorkloads();
  const now = useNow(5000);
  const desktops = workloads.filter((w) => w.kind === "desktop" && w.status !== "cancelled");
  const live = desktops.filter((w) => ACTIVE.has(w.status) || w.status === "planned");
  const rest = desktops.filter((w) => !live.includes(w));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Desktops"
        description="Persistent GPU desktops. Closing your browser never stops them — stopping does, and your projects are saved first."
        actions={<NewTaskLink>New desktop</NewTaskLink>}
      />
      <div className="px-5 pb-10 sm:px-8">
        {ready && desktops.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl px-6 py-16 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="mb-3 grid size-10 place-items-center rounded-xl bg-white/[0.04] text-fg-subtle">
              <IconDesktop size={18} />
            </span>
            <p className="text-sm text-fg-muted">No desktops yet</p>
            <p className="mt-1 max-w-xs text-xs text-fg-faint">Try “Set up a Blender desktop for a 3D game scene” in the workspace.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {[...live, ...rest].map((w) => (
              <Link
                key={String(w.id)}
                href={href(w)}
                className="group flex flex-col overflow-hidden rounded-xl bg-canvas/30 outline-none shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color,transform] duration-200 hover:-translate-y-px hover:bg-hover hover:shadow-[inset_0_0_0_1px_var(--color-line-strong),0_12px_24px_-16px_oklch(0_0_0/0.6)] focus-ring"
              >
                <div className="relative grid aspect-[16/8] place-items-center overflow-hidden border-b border-line bg-[radial-gradient(ellipse_at_top,oklch(1_0_0/0.04),transparent_70%)]">
                  <div className="flex h-[58%] w-[70%] flex-col overflow-hidden rounded-md bg-canvas shadow-[0_0_0_1px_var(--color-line-strong),0_8px_20px_-10px_oklch(0_0_0/0.8)] transition-transform duration-300 ease-out group-hover:scale-[1.02]">
                    <div className="flex h-3 shrink-0 items-center gap-1 border-b border-line px-1.5">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="size-1 rounded-full bg-white/15" />
                      ))}
                    </div>
                    <div className="grid flex-1 place-items-center">
                      {BILLABLE.has(w.status) ? (
                        <span className="size-2 animate-pulse-dot rounded-full bg-ok text-ok" />
                      ) : (
                        <IconDesktop size={16} className="text-fg-faint" />
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{w.title}</div>
                    <div className="mt-0.5 truncate text-xs text-fg-faint">
                      {w.gpuName} · {w.status === "planned" ? `≤ ${cents(w.estHighCents)}` : `${cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })} spent`}
                    </div>
                  </div>
                  <StatusPill status={w.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
