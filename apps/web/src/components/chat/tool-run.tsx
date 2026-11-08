"use client";

import type { AgentStep, Workload } from "@anywhere/stdb";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DetailLines, ToolGroup, ToolRow, type ToolIconName } from "@/components/bui/tool-chips";
import { Trace, type TraceRow } from "@/components/bui/trace";
import { useElapsed } from "@/components/bui/loader";
import { ACTION_VERB, parseDetail } from "@/lib/agent";
import { useApi } from "@/lib/api";
import { parseOutput, type ToolCall } from "@/lib/chat";
import { useWorkloads } from "@/lib/data";
import { duration, ms } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";

/*
 * Agent tool activity, Codex/Claude style: quiet rows of verb + object chip,
 * each expandable to what went in and came out. Desktop runs render as a live
 * trace of every action the agent takes.
 */

type Labels = { running: string; done: string; failed: string; icon: ToolIconName };

const LABELS: Record<string, Labels> = {
  propose_workload: { running: "Planning compute", done: "Planned compute", failed: "Couldn’t plan", icon: "plan" },
  approve_workload: { running: "Approving", done: "Approved", failed: "Couldn’t approve", icon: "check" },
  list_workloads: { running: "Checking machines", done: "Checked machines", failed: "Couldn’t list machines", icon: "search" },
  inspect_workload: { running: "Inspecting", done: "Inspected", failed: "Couldn’t inspect", icon: "read" },
  stop_workload: { running: "Stopping", done: "Stopped", failed: "Couldn’t stop", icon: "stop" },
  resume_desktop: { running: "Resuming", done: "Resumed", failed: "Couldn’t resume", icon: "play" },
  save_project: { running: "Saving", done: "Saved", failed: "Couldn’t save", icon: "save" },
  delete_workload: { running: "Deleting", done: "Deleted", failed: "Couldn’t delete", icon: "trash" },
  operate_desktop: { running: "Working in the desktop", done: "Worked in the desktop", failed: "Desktop task stopped", icon: "cursor" },
};

export function useRun(runId: bigint | null) {
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const run = runId == null ? undefined : runs.find((r) => r.id === runId);
  const list = useMemo(() => (runId == null ? [] : steps.filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq)), [steps, runId]);
  return { run, steps: list };
}

export function ToolRun({ calls, linkMachines = true }: { calls: ToolCall[]; linkMachines?: boolean }) {
  // Desktop runs are their own block; everything else groups into chips.
  const runs = calls.filter((c) => c.name === "operate_desktop");
  const rest = calls.filter((c) => c.name !== "operate_desktop");
  return (
    <>
      {rest.length === 1 && <ToolCallRow call={rest[0]} linkMachines={linkMachines} />}
      {rest.length > 1 && (
        <ToolGroup header={rest.some((c) => !c.result) ? `Running ${rest.length} tools` : `${rest.length} tool calls`} running={rest.some((c) => !c.result)}>
          {rest.map((c) => (
            <ToolCallRow key={c.callId} call={c} linkMachines={linkMachines} />
          ))}
        </ToolGroup>
      )}
      {runs.map((c) => (
        <DesktopCall key={c.callId} call={c} linkMachines={linkMachines} />
      ))}
    </>
  );
}

function ToolCallRow({ call, linkMachines }: { call: ToolCall; linkMachines: boolean }) {
  const { all } = useWorkloads();
  const l = LABELS[call.name] ?? { running: call.name, done: call.name, failed: call.name, icon: "run" as const };
  const output = call.result ? parseOutput(call.result.output) : null;
  const state = !call.result ? "running" : call.result.ok ? "done" : "failed";
  const workload = all.find((w) => w.id === call.workloadId);
  const object = objectFor(call, workload?.title);
  const message = typeof output?.message === "string" ? output.message : null;
  const args = Object.entries(call.args).filter(([, v]) => v !== null && v !== undefined && v !== "");

  const detail = call.result ? (
    <div className="flex flex-col gap-1.5 py-0.5">
      {message ? (
        <DetailLines lines={[{ text: message, tone: call.result.ok ? undefined : "del" }]} />
      ) : (
        <DetailLines mono lines={[...args.slice(0, 4).map(([k, v]) => ({ text: `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`, tone: "muted" as const })), { text: `✓ ${(call.result.ms / 1000).toFixed(1)}s` }]} />
      )}
      {linkMachines && workload && call.name !== "list_workloads" && (
        <Link href={`/w/${workload.id}`} className="w-fit text-[11.5px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors hover:text-ink-2 hover:decoration-current">
          Open {workload.title}
        </Link>
      )}
    </div>
  ) : undefined;

  return <ToolRow icon={l.icon} label={l[state]} chip={object} state={state} detail={detail} />;
}

function DesktopCall({ call, linkMachines }: { call: ToolCall; linkMachines: boolean }) {
  const { all } = useWorkloads();
  const output = call.result ? parseOutput(call.result.output) : null;
  const runId = output?.run_id != null ? BigInt(String(output.run_id)) : null;
  const workload = all.find((w) => w.id === call.workloadId);
  if (runId == null || !workload) return <ToolCallRow call={call} linkMachines={linkMachines} />;
  return <RunTrace workload={workload} runId={runId} goal={String(call.args.goal ?? "")} linkMachines={linkMachines} />;
}

/** A desktop agent run, streamed as a trace: every action, live. */
export function RunTrace({ workload, runId, goal, linkMachines = true }: { workload: Workload; runId: bigint; goal?: string; linkMachines?: boolean }) {
  const { run, steps } = useRun(runId);
  const working = run?.status === "running" && workload.controller === "agent";
  const elapsed = useElapsed(working && run ? ms(run.startedAt) : 0);
  const rows = useMemo(() => toRows(steps, working), [steps, working]);
  const acts = steps.filter((s) => s.kind === "act").length;
  const shot = useLatestShot(steps);
  if (!run) return null;

  const took = run.endedAt ? duration(ms(run.endedAt) - ms(run.startedAt)) : null;
  const done =
    run.status === "paused"
      ? "Paused, you took over"
      : run.status === "failed"
        ? `Stopped after ${acts} action${acts === 1 ? "" : "s"}`
        : `Worked${took ? ` for ${took}` : ""} · ${acts} action${acts === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col gap-1">
      <Trace
        working={working}
        active={goal || run.goal || "Working in the desktop"}
        done={done}
        meta={working ? elapsed : undefined}
        rows={rows}
        footer={
          <div className="flex flex-col gap-2 pt-1 pb-1">
            {shot && (
              <a href={shot} target="_blank" rel="noreferrer" className="block w-full max-w-72 overflow-hidden rounded-card shadow-hairline">
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived URL */}
                <img src={shot} alt="What the agent saw last" className="aspect-video w-full object-cover" />
              </a>
            )}
            {run.result && run.status !== "running" && <p className={run.status === "done" ? "text-[12.5px] text-ink-2" : "text-[12.5px] text-red"}>{run.result}</p>}
            {linkMachines && (
              <Link href={`/w/${workload.id}`} className="w-fit text-[12px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors hover:text-ink-2 hover:decoration-current">
                {working ? "Watch live" : "Open desktop"}
              </Link>
            )}
          </div>
        }
      />
    </div>
  );
}

function toRows(steps: AgentStep[], working: boolean): TraceRow[] {
  const rows: TraceRow[] = [];
  const lastAct = [...steps].reverse().find((s) => s.kind === "act");
  for (const s of steps) {
    if (s.kind === "observe") {
      // One "looked at the screen" between actions is enough.
      if (rows.at(-1)?.key.startsWith("o")) continue;
      rows.push({ key: `o${s.id}`, primary: "Looked at the screen", state: "note" });
      continue;
    }
    const d = parseDetail(s);
    const verb = d?.action ? ACTION_VERB[d.action] : undefined;
    const lines: { text: string; tone?: "add" | "del" | "muted" }[] = [];
    if (d?.thought) lines.push({ text: d.thought, tone: "muted" });
    if (d?.command) lines.push({ text: `$ ${d.command}` });
    if (d?.text && d.action === "type") lines.push({ text: `“${d.text}”` });
    if (d?.outcome && d.outcome !== "ok") lines.push({ text: d.outcome, tone: d.outcome.startsWith("error") ? "del" : undefined });
    rows.push({
      key: `s${s.id}`,
      primary: s.summary,
      secondary: verb && s.kind === "act" ? verb : undefined,
      state: s.kind === "error" ? "error" : working && s.id === lastAct?.id ? "active" : "done",
      detail: lines.length ? <DetailLines lines={lines} mono={!!d?.command} /> : undefined,
    });
  }
  return rows;
}

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

function objectFor(call: ToolCall, title?: string): string | undefined {
  const a = call.args;
  if (call.name === "propose_workload") return String(a.summary ?? a.kind ?? "") || undefined;
  if (call.name === "list_workloads") return undefined;
  return title ?? (a.workload_id ? `#${a.workload_id}` : undefined);
}
