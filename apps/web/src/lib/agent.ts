"use client";

import type { AgentRun, AgentStep, Workload } from "@anywhere/stdb";
import { useMemo } from "react";
import { NONE, useShared } from "./tables";

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
  const runs = useShared("myAgentRuns");
  const steps = useShared("myAgentSteps");
  const mine = runs.byWorkload.get(w.id) ?? NONE;
  const run: AgentRun | undefined = mine[0];
  const runSteps = (run && steps.byRun.get(run.id)) || NONE;
  const last = runSteps.at(-1);
  const lastAct = useMemo(() => [...runSteps].reverse().find((s) => s.kind === "act"), [runSteps]);
  const working = w.controller === "agent" && run?.status === "running";
  const control: Control = working ? "agent" : run?.status === "paused" ? "paused" : "user";
  return { runs: mine, run, steps: runSteps, last, lastAct, working, control };
}

/** Every step for a workload, newest run first, for the timeline. */
export function useAllSteps(workloadId: bigint) {
  return useShared("myAgentSteps").byWorkload.get(workloadId) ?? NONE;
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
