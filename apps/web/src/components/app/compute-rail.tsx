"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useNow, usePlatform, useProjects, useWorkloads } from "@/lib/data";
import { ago, bytes, cents, perHour } from "@/lib/format";
import { ACTIVE, href, liveCents } from "@/lib/workloads";
import { IconCube, IconDesktop, IconFolder, IconWorkload } from "../icons";
import { Meter } from "../ui/meter";
import { StatusPill } from "../ui/status";

export function ComputeRail() {
  const { workloads } = useWorkloads();
  const { projects } = useProjects();
  const { platform } = usePlatform();
  const now = useNow(2000);
  const active = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned");
  const stopped = workloads.filter((w) => w.status === "stopped").slice(0, 3);

  return (
    <aside className="hidden w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line px-4 py-5 xl:flex">
      <Section title="Compute" count={active.length}>
        {active.length === 0 && stopped.length === 0 ? (
          <Empty icon={<IconCube size={16} />}>Nothing running. Machines show up here while they exist — and bill.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {[...active, ...stopped].map((w) => (
              <Link
                key={String(w.id)}
                href={href(w)}
                className="group rounded-lg bg-canvas/40 p-3 outline-none shadow-[inset_0_0_0_1px_var(--color-line)] transition-[background-color,box-shadow] duration-150 hover:bg-hover hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus-ring"
              >
                <div className="flex items-center gap-2">
                  <span className="text-fg-faint">{w.kind === "desktop" ? <IconDesktop size={14} /> : <IconWorkload size={14} />}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{w.title}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <StatusPill status={w.status} />
                  <span className="ml-auto tabular text-xs text-fg-subtle">
                    {w.status === "planned" ? `≤ ${cents(w.estHighCents)}` : cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}
                  </span>
                </div>
                <div className="mt-1.5 truncate text-2xs text-fg-faint">
                  {w.gpuName} · {perHour(w.hourlyCents)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Projects" count={projects.length}>
        {projects.length === 0 ? (
          <Empty icon={<IconFolder size={16} />}>Desktop projects are saved to durable storage, so they outlive the machine.</Empty>
        ) : (
          <div className="-mx-2 flex flex-col">
            {projects.slice(0, 6).map((p) => (
              <div key={String(p.id)} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.04] text-fg-subtle">
                  <IconFolder size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg-muted">{p.name}</div>
                  <div className="truncate text-2xs text-fg-faint">
                    {p.app} · {p.lastSavedAt ? `saved ${ago(p.lastSavedAt, now || undefined)}` : "not saved yet"}
                    {p.sizeBytes > 0n && ` · ${bytes(p.sizeBytes)}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {platform && platform.globalBudgetCents > 0 && (
        <Section title="Shared GPU credit">
          <div className="rounded-lg bg-canvas/40 p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-fg-subtle">
                {platform.activeInstances} of {platform.maxConcurrentInstances} machine{platform.maxConcurrentInstances === 1 ? "" : "s"} in use
              </span>
              <span className="tabular text-fg-muted">
                {cents(platform.globalSpentCents)} <span className="text-fg-faint">/ {cents(platform.globalBudgetCents)}</span>
              </span>
            </div>
            <Meter value={platform.globalSpentCents} max={platform.globalBudgetCents} className="mt-2" />
          </div>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
        {title}
        {!!count && <span className="tabular text-fg-faint">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Empty({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-3 rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs leading-relaxed text-fg-faint", className)}>
      <span className="mt-0.5 shrink-0 text-fg-faint">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
