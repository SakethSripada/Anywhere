"use client";

import type { AgentRun, AgentStep, Workload } from "@anywhere/stdb";
import { useMemo } from "react";
import { tables, useTable } from "./stdb";

/** What the operator recorded for one action (`agent_step.detail` for kind "act"). */
export type StepDetail = {
  thought?: string;
  action?: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  keys?: string[];
  dy?: number;
  command?: string;
  outcome?: string;
  /** Size of the screenshot the coordinates refer to, when the control plane sends it. */
  frame?: [number, number];
};

export function parseDetail(step: Pick<AgentStep, "detail">): StepDetail | null {
  if (!step.detail || step.detail[0] !== "{") return null;
  try {
    return JSON.parse(step.detail) as StepDetail;
  } catch {
    return null;
  }
}

/** Who holds the mouse right now, derived from the workload and its latest run. */
export type Control = "agent" | "paused" | "user";

export function useAgentState(w: Workload) {
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const mine = useMemo(
    () => runs.filter((r) => r.workloadId === w.id).sort((a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis())),
    [runs, w.id],
  );
  const run: AgentRun | undefined = mine[0];
  const runSteps = useMemo(() => (run ? steps.filter((s) => s.runId === run.id).sort((a, b) => a.seq - b.seq) : []), [steps, run]);
  const last = runSteps.at(-1);
  const lastAct = useMemo(() => [...runSteps].reverse().find((s) => s.kind === "act"), [runSteps]);
  const working = w.controller === "agent" && run?.status === "running";
  const control: Control = working ? "agent" : run?.status === "paused" ? "paused" : "user";
  return { runs: mine, run, steps: runSteps, last, lastAct, working, control };
}

/** Every step for a workload, newest run first, for the timeline. */
export function useAllSteps(workloadId: bigint) {
  const [steps] = useTable(tables.myAgentSteps);
  return useMemo(() => steps.filter((s) => s.workloadId === workloadId).sort((a, b) => (a.id < b.id ? -1 : 1)), [steps, workloadId]);
}

export const ACTION_VERB: Record<string, string> = {
  click: "Click",
  double_click: "Double-click",
  right_click: "Right-click",
  move: "Move",
  drag: "Drag",
  scroll: "Scroll",
  type: "Type",
  key: "Press",
  shell: "Run",
  wait: "Wait",
  done: "Done",
  fail: "Stop",
};
