"use client";

import type { Workload } from "@anywhere/stdb";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ApiError, useApi } from "@/lib/api";
import { useWorkload } from "@/lib/data";
import { bytes, centsRange, clock } from "@/lib/format";
import { parsePlan } from "@/lib/plan";
import { tables, useTable } from "@/lib/stdb";
import { BILLABLE } from "@/lib/workloads";
import { IconChevronLeft, IconDownload, IconFile, IconStop } from "../icons";
import { PlanCard } from "../app/plan-card";
import { Button } from "../ui/button";
import { StatusPill } from "../ui/status";
import { Segmented } from "../ui/tabs";
import { toast } from "../ui/toast";
import { BootProgress, ConfirmDialog, EventFeed, LiveCost, Stat, Uptime, useWorkloadAction } from "./shared";
import { LogView } from "./log-view";
import { MetricChart } from "./metric-chart";

export function WorkloadDetail({ id }: { id: string }) {
  const wid = /^\d+$/.test(id) ? BigInt(id) : null;
  const { workload: w, ready } = useWorkload(wid);
  if (!w) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-fg-subtle">
        {ready ? "This workload doesn't exist or isn't yours." : <div className="skeleton h-6 w-48" />}
      </div>
    );
  }
  return <Detail w={w} />;
}

function Detail({ w }: { w: Workload }) {
  const { busy, run } = useWorkloadAction(w.id);
  const [confirm, setConfirm] = useState(false);
  const plan = useMemo(() => parsePlan(w.planJson), [w.planJson]);
  const booting = ["approved", "provisioning", "configuring"].includes(w.status);
  const cancellable = ["approved", "provisioning", "configuring"].includes(w.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-3 px-5 pt-6 pb-5 sm:px-8">
        <Link
          href="/workloads"
          aria-label="All workloads"
          className="grid size-7 place-items-center rounded-md text-fg-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-ring"
        >
          <IconChevronLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-xl font-semibold tracking-tighter text-fg">{w.title}</h1>
            <StatusPill status={w.status} />
          </div>
          <p className="mt-0.5 truncate text-sm text-fg-subtle">{w.statusDetail || w.summary}</p>
        </div>
        {(w.status === "running" || cancellable) && (
          <Button variant="secondary" size="sm" leading={<IconStop />} onClick={() => setConfirm(true)}>
            {w.status === "running" ? "Stop job" : "Cancel"}
          </Button>
        )}
      </header>

      {w.status === "planned" ? (
        <div className="px-5 pb-10 sm:px-8">
          <PlanCard workloadId={w.id} />
        </div>
      ) : (
        <div className="flex flex-col gap-6 px-5 pb-10 sm:px-8">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Spent">
              <LiveCost w={w} className="text-md" />
            </Stat>
            <Stat label="Estimate">
              <span className="tabular">{centsRange(w.estLowCents, w.estHighCents)}</span>
            </Stat>
            <Stat label="Runtime">
              <span className="tabular">
                <Uptime w={w} />
              </span>
            </Stat>
            <Stat label="Machine">{w.gpuName}</Stat>
          </div>

          {booting && (
            <section className="rounded-xl p-5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <BootProgress w={w} />
            </section>
          )}

          {w.kind === "batch" && <Metrics workloadId={w.id} />}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className="min-w-0">
              <SectionTitle>Logs</SectionTitle>
              <LogView workloadId={w.id} className="h-[420px]" />
            </section>
            <div className="flex min-w-0 flex-col gap-6">
              <section>
                <SectionTitle>Outputs</SectionTitle>
                <Artifacts workloadId={w.id} expected={plan?.outputs ?? []} done={!BILLABLE.has(w.status) && w.status !== "approved"} />
              </section>
              <section>
                <SectionTitle>Activity</SectionTitle>
                <EventFeed workloadId={w.id} limit={30} />
              </section>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={w.status === "running" ? "Stop this job?" : "Cancel this job?"}
        description={
          w.status === "running"
            ? "Training stops now. Checkpoints already written are kept; the machine is shut down."
            : "Anywhere will cancel provisioning and clean up anything already created."
        }
        confirm={w.status === "running" ? "Stop job" : "Cancel job"}
        busy={busy === "stop" || busy === "cancel"}
        onConfirm={async () => {
          if (await run(w.status === "running" ? "stop" : "cancel")) setConfirm(false);
        }}
      />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-xs font-medium text-fg-subtle">{children}</h2>;
}

function Metrics({ workloadId }: { workloadId: bigint }) {
  const [rows] = useTable(tables.myMetrics);
  const series = useMemo(() => {
    const by = new Map<string, { step: number; value: number }[]>();
    for (const r of rows) {
      if (r.workloadId !== workloadId || !Number.isFinite(r.value)) continue;
      const list = by.get(r.name) ?? [];
      list.push({ step: r.step, value: r.value });
      by.set(r.name, list);
    }
    for (const list of by.values()) list.sort((a, b) => a.step - b.step);
    return by;
  }, [rows, workloadId]);
  const names = [...series.keys()].sort((a, b) => (a === "loss" ? -1 : b === "loss" ? 1 : a.localeCompare(b)));
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked && series.has(picked) ? picked : (names[0] ?? "loss");
  const points = series.get(name) ?? [];
  const latest = points.at(-1);

  return (
    <section className="rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-xs font-medium text-fg-subtle">Training metrics</h2>
          {latest && (
            <div className="mt-0.5 text-lg font-semibold tracking-tight text-fg tabular">
              {latest.value.toPrecision(4)}
              <span className="ml-2 text-xs font-normal text-fg-faint">
                {name} at step {latest.step.toLocaleString()}
              </span>
            </div>
          )}
        </div>
        {names.length > 1 && (
          <div className="ml-auto">
            <Segmented size="sm" value={name} onValueChange={setPicked} items={names.map((n) => ({ value: n, label: n.replace(/_/g, " ") }))} />
          </div>
        )}
      </div>
      <MetricChart points={points} label={name.replace(/_/g, " ")} />
    </section>
  );
}

function Artifacts({ workloadId, expected, done }: { workloadId: bigint; expected: string[]; done: boolean }) {
  const api = useApi();
  const [rows] = useTable(tables.myArtifacts);
  const files = useMemo(() => rows.filter((a) => a.workloadId === workloadId && !a.name.startsWith("agent-")), [rows, workloadId]);

  async function download(key: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/v1/files?key=${encodeURIComponent(key)}`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast.error("Download failed", err instanceof ApiError ? err.message : undefined);
    }
  }

  if (!files.length) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-4 text-xs text-fg-faint">
        {done ? "This run didn't produce any files." : "Outputs appear here as they're saved"}
        {!done && expected.length > 0 && (
          <ul className="mt-2 space-y-1">
            {expected.map((e) => (
              <li key={e} className="flex gap-2 text-fg-subtle">
                <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-fg-faint" />
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--color-line)]">
      {files.map((a) => (
        <li key={String(a.id)}>
          <button
            type="button"
            onClick={() => void download(a.storageKey)}
            className="group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle">
              <IconFile size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-fg-muted group-hover:text-fg">{a.name}</div>
              <div className="text-2xs text-fg-faint">
                {bytes(a.sizeBytes)} · {clock(a.createdAt)}
              </div>
            </div>
            <IconDownload size={15} className="text-fg-faint transition-colors group-hover:text-fg-muted" />
          </button>
        </li>
      ))}
    </ul>
  );
}

