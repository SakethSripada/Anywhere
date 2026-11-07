"use client";

import type { AgentStep, Workload } from "@anywhere/stdb";
import { useMemo, useRef, useState, useEffect, type KeyboardEvent, type ReactNode } from "react";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow, useProjects } from "@/lib/data";
import { ago, bytes, clock } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";
import {
  IconAgent,
  IconAlert,
  IconArrowUp,
  IconCheck,
  IconCursor,
  IconEye,
  IconFolder,
  IconKeyboard,
  IconSave,
  IconStop,
  IconTerminal,
} from "../icons";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Badge } from "../ui/status";
import { toast } from "../ui/toast";

export function AgentPanel({ w }: { w: Workload }) {
  const api = useApi();
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const run = useMemo(
    () => runs.filter((r) => r.workloadId === w.id).sort((a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis()))[0],
    [runs, w.id],
  );
  const runSteps = useMemo(
    () => (run ? steps.filter((s) => s.runId === run.id).sort((a, b) => a.seq - b.seq) : []),
    [steps, run],
  );
  const live = w.status === "running" || w.status === "saving";
  const working = run?.status === "running" && w.controller === "agent";
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [runSteps.length]);

  async function start() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/v1/workloads/${w.id}/agent/run`, { goal: goal.trim() });
      setGoal("");
    } catch (err) {
      toast.error("The agent couldn't start", err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    try {
      await api.post(`/v1/workloads/${w.id}/agent/stop`);
    } catch (err) {
      toast.error("Couldn't stop the agent", err instanceof ApiError ? err.message : undefined);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void start();
    }
  }

  return (
    <aside className="flex min-h-0 w-full flex-col border-line lg:w-[340px] lg:shrink-0 lg:border-l">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <IconAgent size={15} className="text-accent" />
        <span className="text-sm font-medium text-fg">Agent</span>
        <RunBadge status={run?.status} paused={w.controller === "user" && run?.status === "running"} />
        {working && (
          <Button variant="ghost" size="xs" className="ml-auto" leading={<IconStop />} onClick={stop}>
            Stop
          </Button>
        )}
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!run ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <span className="mb-3 grid size-10 place-items-center rounded-xl bg-white/[0.04] text-fg-subtle">
              <IconAgent size={18} />
            </span>
            <p className="text-sm text-fg-muted">The agent can see and operate this desktop.</p>
            <p className="mt-1 text-xs text-fg-faint">
              Give it a goal — it clicks, types and checks its work, and you can take over at any moment.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-lg bg-canvas/50 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <div className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Goal</div>
              <p className="mt-1 text-sm text-fg-muted">{run.goal}</p>
            </div>
            <ol className="relative flex flex-col">
              {runSteps.map((s, i) => (
                <StepRow key={String(s.id)} s={s} last={i === runSteps.length - 1 && run.status !== "running"} />
              ))}
              {working && (
                <li className="flex items-center gap-3 py-1.5 pl-0.5 text-xs text-fg-subtle">
                  <Spinner size={14} className="text-accent" />
                  Working…
                </li>
              )}
            </ol>
            {run.result && run.status !== "running" && (
              <div
                className={cn(
                  "mt-3 rounded-lg px-3 py-2.5 text-sm",
                  run.status === "done" ? "bg-ok-soft text-fg-muted" : "bg-bad-soft text-fg-muted",
                )}
              >
                {run.result}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="rounded-xl bg-raised shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.2)]">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={2000}
            disabled={!live}
            placeholder={live ? "Ask the agent to do something here…" : "The desktop needs to be running"}
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-fg outline-none placeholder:text-fg-faint disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="pl-1 text-2xs text-fg-faint">Nemotron vision · Cua</span>
            <button
              type="button"
              aria-label="Start agent"
              onClick={() => void start()}
              disabled={!live || !goal.trim() || busy}
              className={cn(
                "grid size-7 place-items-center rounded-full outline-none transition-[background-color,transform] duration-150 focus-ring",
                live && goal.trim() ? "bg-fg text-fg-inverse hover:scale-105" : "bg-white/[0.06] text-fg-faint",
              )}
            >
              {busy ? <Spinner size={13} /> : <IconArrowUp size={14} />}
            </button>
          </div>
        </div>
      </div>

      <ProjectFiles w={w} />
    </aside>
  );
}

function RunBadge({ status, paused }: { status?: string; paused: boolean }) {
  if (!status) return <Badge>Idle</Badge>;
  if (paused || status === "paused") return <Badge tone="wait">Paused</Badge>;
  if (status === "running") return <Badge tone="busy">Working</Badge>;
  if (status === "done") return <Badge tone="ok">Done</Badge>;
  return <Badge tone="bad">Stopped</Badge>;
}

const ACT_ICON: Record<string, ReactNode> = {
  click: <IconCursor size={12} />,
  double_click: <IconCursor size={12} />,
  right_click: <IconCursor size={12} />,
  move: <IconCursor size={12} />,
  drag: <IconCursor size={12} />,
  scroll: <IconCursor size={12} />,
  type: <IconKeyboard size={12} />,
  key: <IconKeyboard size={12} />,
  shell: <IconTerminal size={12} />,
};

function StepRow({ s, last }: { s: AgentStep; last: boolean }) {
  const [open, setOpen] = useState(false);
  let detail: Record<string, unknown> | null = null;
  try {
    detail = s.kind === "act" && s.detail ? JSON.parse(s.detail) : null;
  } catch {
    detail = null;
  }
  const icon =
    s.kind === "observe" ? (
      <IconEye size={12} />
    ) : s.kind === "done" ? (
      <IconCheck size={12} />
    ) : s.kind === "error" ? (
      <IconAlert size={12} />
    ) : (
      (ACT_ICON[String(detail?.action)] ?? <IconCursor size={12} />)
    );
  const failed = typeof detail?.outcome === "string" && detail.outcome.startsWith("error");

  return (
    <li className="group relative flex gap-3 pb-1">
      {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[11px] w-px bg-line" />}
      <span
        className={cn(
          "relative z-[1] mt-0.5 grid size-[23px] shrink-0 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
          s.kind === "done" ? "bg-ok-soft text-ok" : s.kind === "error" || failed ? "bg-bad-soft text-bad" : "bg-surface text-fg-subtle",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pb-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={!detail?.thought && !s.detail}
          className="flex w-full items-baseline gap-2 text-left outline-none disabled:cursor-default"
        >
          <span className={cn("min-w-0 flex-1 text-sm", s.kind === "observe" ? "text-fg-subtle" : "text-fg-muted")}>{s.summary}</span>
          <span className="shrink-0 text-2xs text-fg-faint tabular">{clock(s.createdAt)}</span>
        </button>
        {open && (
          <div className="mt-1.5 animate-fade-in space-y-1 rounded-md bg-canvas/60 px-2.5 py-2 text-xs text-fg-subtle">
            {detail?.thought ? <p className="italic">{String(detail.thought)}</p> : null}
            {detail?.outcome ? <p className="font-mono text-2xs text-fg-faint">→ {String(detail.outcome)}</p> : null}
            {!detail && s.detail && <p>{s.detail}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

function ProjectFiles({ w }: { w: Workload }) {
  const api = useApi();
  const { projects } = useProjects();
  const now = useNow(30_000);
  // The supervisor keys a desktop's project by its own id until it is linked to an existing one.
  const project = projects.find((p) => p.id === (w.projectId || w.id));
  const [saving, setSaving] = useState(false);
  const canSave = w.status === "running";

  async function save() {
    setSaving(true);
    try {
      await api.post(`/v1/workloads/${w.id}/save`);
      toast.success("Saving your project", "Files are being copied to durable storage.");
    } catch (err) {
      toast.error("Couldn't save", err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle">
        <IconFolder size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-fg-muted">{project?.name ?? "Project files"}</div>
        <div className="truncate text-2xs text-fg-faint">
          {w.status === "saving"
            ? "Saving now…"
            : project?.lastSavedAt
              ? `Saved ${ago(project.lastSavedAt, now || undefined)}${project.sizeBytes > 0n ? ` · ${bytes(project.sizeBytes)}` : ""}`
              : "Files in ~/Projects are kept when you save"}
        </div>
      </div>
      <Button size="sm" variant="secondary" leading={<IconSave />} loading={saving || w.status === "saving"} disabled={!canSave} onClick={save}>
        Save
      </Button>
    </div>
  );
}
