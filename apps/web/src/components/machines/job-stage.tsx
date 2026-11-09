"use client";

import type { Workload } from "@anywhere/stdb";
import { Download, FileArchive, FileJson, FileText, Package } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ApiError, useApi } from "@/lib/api";
import { useNow } from "@/lib/data";
import { bytes, centsRange, clock, compact, duration, ms } from "@/lib/format";
import { frameTime, parsePlan } from "@/lib/plan";
import { NONE, useShared, useWorkloadRows } from "@/lib/tables";
import { cn } from "@/lib/utils";
import { BILLABLE } from "@/lib/workloads";
import { PlanCard } from "../chat/plan-card";
import { LogView } from "./log-view";
import { MetricChart } from "./metric-chart";
import { BootProgress, EventFeed, LiveCost } from "./shared";

type Point = { step: number; value: number };

function useSeries(workloadId: bigint) {
  const rows = useWorkloadRows("myMetrics", workloadId);
  return useMemo(() => {
    const by = new Map<string, Point[]>();
    for (const r of rows) {
      if (!Number.isFinite(r.value)) continue;
      const list = by.get(r.name);
      if (list) list.push({ step: r.step, value: r.value });
      else by.set(r.name, [{ step: r.step, value: r.value }]);
    }
    for (const list of by.values()) list.sort((a, b) => a.step - b.step);
    return by;
  }, [rows]);
}

const PRETTY: Record<string, string> = {
  loss: "Loss",
  eval_loss: "Eval loss",
  learning_rate: "Learning rate",
  grad_norm: "Grad norm",
  tokens_per_sec: "Tokens / s",
  seconds_per_frame: "Seconds / frame",
};
const pretty = (n: string) => PRETTY[n] ?? n.replace(/_/g, " ");

export function JobStage({ w }: { w: Workload }) {
  if (w.status === "planned" || ["approved", "provisioning", "configuring"].includes(w.status)) return <JobState w={w} />;
  return (
    <ResizablePanelGroup orientation="vertical" className="h-full min-h-0">
      <ResizablePanel defaultSize="62%" minSize="25%">
        <div className="h-full overflow-y-auto">
          <Overview w={w} />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="38%" minSize="12%" collapsible collapsedSize="40px">
        <LogView workloadId={w.id} className="h-full" title="Live output" />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function Overview({ w }: { w: Workload }) {
  const plan = useMemo(() => parsePlan(w.planJson), [w.planJson]);
  const series = useSeries(w.id);
  // Only a running job's elapsed time and ETA change by the second.
  const now = useNow(1000, BILLABLE.has(w.status));
  const loss = series.get("loss") ?? [];
  const latest = loss.at(-1);
  const prior = loss.length > 20 ? loss[Math.max(0, loss.length - 21)] : loss[0];
  const live = BILLABLE.has(w.status);

  // Progress: the trainer reports it directly; otherwise estimate from epochs.
  const progressPt = series.get("progress")?.at(-1);
  // The trainer's epoch count: the request's, or the default the control plane picked for the dataset.
  const configEpochs = plan?.inputs?.train_config?.epochs;
  const epochs = typeof configEpochs === "number" ? configEpochs : (plan?.intent.epochs ?? null);
  const epochPt = series.get("epoch")?.at(-1);
  const progress = w.status === "succeeded" ? 1 : progressPt ? progressPt.value : epochs && epochPt ? epochPt.value / epochs : null;
  const elapsed = w.startedAt && now ? (live ? now : ms(w.updatedAt)) - ms(w.startedAt) : 0;
  const eta = live && progress && progress > 0.02 && progress < 1 ? (elapsed * (1 - progress)) / progress : null;
  const tps = series.get("tokens_per_sec")?.at(-1);
  const render = plan?.requirements.environment === "blender-render";
  const perFrame = series.get("seconds_per_frame") ?? [];
  const framesTotal = plan?.intent.render_frames ?? 1;
  const framesDone = progressPt ? Math.round(progressPt.value * framesTotal) : 0;
  const estRow = plan?.render_time?.rows.find((r) => r.gpu === w.gpuName) ?? plan?.render_time?.rows[0];

  return (
    <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4 p-4 lg:p-5">
      {/* Progress + KPIs */}
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pt-3.5 pb-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Progress</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight tabular">{progress != null ? `${Math.round(progress * 100)}%` : w.status === "failed" ? "Failed" : "-"}</span>
              <span className="truncate text-[13px] text-muted-foreground">{w.statusDetail}</span>
            </div>
          </div>
          {eta != null && (
            <div className="text-right">
              <div className="eyebrow">Time left</div>
              <div className="mt-1 text-[15px] font-medium tabular">~{duration(eta)}</div>
            </div>
          )}
        </div>
        <div className="mx-4 mb-3.5 h-1.5 overflow-hidden rounded-full bg-muted">
          {progress != null ? (
            <div className={cn("h-full rounded-full transition-[width] duration-700", w.status === "failed" ? "bg-destructive" : "bg-brand")} style={{ width: `${Math.max(2, progress * 100)}%` }} />
          ) : live ? (
            <div className="progress-indeterminate h-full" />
          ) : null}
        </div>
        <dl className="grid grid-cols-2 border-t @2xl:grid-cols-5 [&>div]:border-b [&>div]:px-4 [&>div]:py-3 @2xl:[&>div]:border-b-0 @2xl:[&>div:not(:last-child)]:border-r [&>div:nth-child(odd)]:border-r">
          {render ? (
            <>
              <Kpi label="Frames" value={`${framesDone} of ${framesTotal}`} sub={framesDone ? "rendered" : "Waiting for the first frame"} />
              <Kpi
                label="Per frame"
                value={perFrame.length ? frameTime(perFrame.at(-1)!.value / 60) : "-"}
                sub={estRow ? `est. ${frameTime(estRow.minutes_low)}–${frameTime(estRow.minutes_high)}` : "measured"}
              />
              <Kpi label="GPU" value={`NVIDIA ${w.gpuName}`} sub="shuts down when done" />
            </>
          ) : (
            <>
              <Kpi label="Training loss" value={latest ? latest.value.toFixed(4) : "-"} sub={latest && prior && prior !== latest ? <Delta from={prior.value} to={latest.value} /> : "Waiting for metrics"} />
              <Kpi label="Step" value={latest ? latest.step.toLocaleString() : "-"} sub={epochPt && epochs ? `epoch ${epochPt.value.toFixed(1)} of ${epochs}` : (plan?.requirements.method?.toUpperCase() ?? "")} />
              <Kpi label="Throughput" value={tps ? compact(Math.round(tps.value)) : "-"} sub={tps ? "tokens / s" : "not reported"} />
            </>
          )}
          <Kpi label="Runtime" value={elapsed ? duration(elapsed) : "-"} sub={plan ? `est. ${duration(plan.selected.estimate.hours_low * 3_600_000)}–${duration(plan.selected.estimate.hours_high * 3_600_000)}` : ""} />
          <Kpi label="Spent" value={<LiveCost w={w} />} sub={`est. ${centsRange(w.estLowCents, w.estHighCents)}`} />
        </dl>
      </section>

      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <Metrics series={series} />
        <div className="flex flex-col gap-4">
          <Outputs workloadId={w.id} expected={plan?.outputs ?? []} done={!live} />
          <section className="rounded-xl border bg-card">
            <h3 className="border-b px-4 py-2.5 text-[13px] font-medium">Machine</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-4 py-3 text-[12.5px]">
              <Spec label="GPU" value={`NVIDIA ${w.gpuName}${plan ? ` · ${plan.selected.offer.vram_gb} GB` : ""}`} />
              <Spec label="Rate" value={`$${(w.hourlyCents / 100).toFixed(2)}/hr`} />
              <Spec label="Instance" value={w.instanceType} mono />
              <Spec label="Provider" value={`Brev · ${w.provider.toUpperCase()}`} />
              {plan?.inputs?.dataset_name && <Spec label="Dataset" value={`${plan.inputs.dataset_name} · ${(plan.inputs.dataset_rows ?? 0).toLocaleString()} rows`} wide />}
              {plan?.inputs?.source_title && <Spec label="Scene" value={`${plan.inputs.blend_path ?? "newest .blend"} · from ${plan.inputs.source_title}`} wide />}
              {plan?.inputs?.chunk && (
                <Spec
                  label="Split render"
                  value={`Part ${plan.inputs.chunk.index + 1} of ${plan.inputs.chunk.count} · frames ${plan.inputs.chunk.offset + 1}–${plan.inputs.chunk.offset + plan.inputs.chunk.frames} of ${plan.inputs.chunk.total}`}
                  wide
                />
              )}
            </dl>
          </section>
          <section className="rounded-xl border bg-card">
            <h3 className="border-b px-4 py-2.5 text-[13px] font-medium">Events</h3>
            <div className="max-h-56 overflow-y-auto px-4 py-3">
              <EventFeed workloadId={w.id} limit={20} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[17px] font-semibold tracking-tight tabular">{value}</dd>
      {sub && <dd className="truncate text-[11.5px] text-muted-foreground">{sub}</dd>}
    </div>
  );
}

function Delta({ from, to }: { from: number; to: number }) {
  const pct = from ? ((to - from) / Math.abs(from)) * 100 : 0;
  const good = pct <= 0;
  return (
    <span className={cn("tabular", good ? "text-brand" : "text-warning")}>
      {good ? "↓" : "↑"} {Math.abs(pct).toFixed(1)}% <span className="text-muted-foreground">last 20 steps</span>
    </span>
  );
}

function Metrics({ series }: { series: Map<string, Point[]> }) {
  const names = [...series.keys()].filter((n) => n !== "progress" && n !== "epoch" && n !== "eval_loss" && !n.startsWith("gpu.")).sort((a, b) => (a === "loss" ? -1 : b === "loss" ? 1 : a.localeCompare(b)));
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked && series.has(picked) ? picked : (names[0] ?? "loss");
  const points = series.get(name) ?? [];
  const compare = name === "loss" ? series.get("eval_loss") : undefined;
  const latest = points.at(-1);

  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <h3 className="text-[13px] font-medium">Metrics</h3>
        {latest && (
          <span className="text-[11.5px] text-muted-foreground tabular">
            {compact(latest.value)} @ step {latest.step.toLocaleString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {names.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPicked(n)}
              className={cn("h-6 rounded-md px-2 text-[12px] transition-colors", n === name ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
            >
              {pretty(n)}
            </button>
          ))}
        </div>
      </div>
      <div className="px-3 pt-3 pb-2">
        <MetricChart points={points} label={pretty(name)} compare={compare} compareLabel="Eval loss" />
        {compare && compare.length > 0 && (
          <div className="mt-1 flex gap-4 px-1 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded bg-chart-1" /> Train
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded border-t-2 border-dashed border-chart-2" /> Eval
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function fileIcon(name: string) {
  if (/\.(json|jsonl)$/i.test(name)) return FileJson;
  if (/\.(safetensors|bin|pt|gguf)$/i.test(name)) return Package;
  if (/\.(zip|tar|gz)$/i.test(name)) return FileArchive;
  return FileText;
}

function Outputs({ workloadId, expected, done }: { workloadId: bigint; expected: string[]; done: boolean }) {
  const api = useApi();
  const rows = useShared("myArtifacts").byWorkload.get(workloadId) ?? NONE;
  const files = useMemo(() => rows.filter((a) => !a.name.startsWith("agent-")), [rows]);

  async function download(key: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/v1/files?key=${encodeURIComponent(key)}`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast.error("Download failed", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <section className="rounded-xl border bg-card">
      <h3 className="flex items-center border-b px-4 py-2.5 text-[13px] font-medium">
        Outputs
        {files.length > 0 && <span className="ml-1.5 text-[11px] text-muted-foreground">{files.length}</span>}
      </h3>
      {files.length ? (
        <ul className="divide-y">
          {files.map((a) => {
            const Icon = fileIcon(a.name);
            return (
              <li key={String(a.id)}>
                <button type="button" onClick={() => void download(a.storageKey)} className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{a.name}</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {bytes(a.sizeBytes)} · {clock(a.createdAt)}
                    </span>
                  </span>
                  <Download className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="px-4 py-3 text-[12.5px] text-muted-foreground">
          {done ? (
            "This run didn’t produce any files."
          ) : (
            <>
              <p>Saved here as they’re written:</p>
              <ul className="mt-2 space-y-1.5">
                {expected.map((e) => (
                  <li key={e} className="flex items-center gap-2 text-foreground/80">
                    <span className="size-1.5 rounded-full border border-muted-foreground/50" />
                    {e}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Spec({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate", mono && "text-[11.5px]")}>{value}</dd>
    </div>
  );
}

function JobState({ w }: { w: Workload }) {
  const now = useNow(1000, BILLABLE.has(w.status));
  if (w.status === "planned") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-6 py-12">
          <div className="eyebrow mb-3">Awaiting your approval</div>
          <PlanCard workloadId={w.id} />
          <p className="mt-4 text-center text-[12px] text-muted-foreground">Nothing is billed until you approve.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Preparing your job</h2>
          <span className="text-[11.5px] text-muted-foreground tabular">{w.startedAt && now ? duration(now - ms(w.startedAt)) : ""}</span>
        </div>
        <p className="mb-6 text-[13px] leading-5 text-muted-foreground">Reserving the GPU, installing the training stack and downloading your data. You can close this tab.</p>
        <div className="progress-indeterminate mb-6 h-0.5 rounded-full bg-muted" />
        <BootProgress w={w} />
        <div className="mt-10 border-t pt-5">
          <div className="eyebrow mb-3">Activity</div>
          <EventFeed workloadId={w.id} limit={8} />
        </div>
      </div>
    </div>
  );
}
