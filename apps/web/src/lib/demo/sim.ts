/**
 * DEMO BRANCH ONLY. Makes the dummy account feel alive: training streams logs
 * and loss, costs tick, a desktop boots, the desktop agent works (driving the
 * real local demo container when it's running), and chat replies arrive with
 * live tool calls and streamed text.
 */
import type { Workload } from "@anywhere/stdb";
import { BILLABLE } from "../workloads";
import { C, OFFERS, TRAIN_TOTAL, TRAIN_START_STEP, W, logLine, lossAt, planDoc, seed } from "./seed";
import { init, insert, nextId, OWNER, patch, rows, ts, update } from "./store";

const AGENT_URL = process.env.NEXT_PUBLIC_DEMO_AGENT_URL ?? "http://localhost:6090";
const SPEED = 30; // cost accrues 30× real time so the meters visibly move

let started = false;
let trainStep = TRAIN_START_STEP;
const boot = new Map<bigint, number>(); // workload → ms when its boot sequence began
const runs = new Map<bigint, { runId: bigint; seen: number; script: string; local?: string[]; next?: number; viaContainer: boolean }>();
let idleSince = Date.now();

export function startDemo() {
  if (started) return;
  started = true;
  init(seed);
  boot.set(W.jupyter, Date.now());
  setInterval(tick, 1000);
}

const now = () => Date.now();
const wl = (id: bigint) => rows("myWorkloads").find((w) => w.id === id);

function setWorkload(id: bigint, changes: Partial<Workload>) {
  patch("myWorkloads", (w) => w.id === id, { ...changes, updatedAt: ts(now()) });
}

function event(wid: bigint, message: string, level = "info") {
  insert("myEvents", { id: nextId(), workloadId: wid, owner: OWNER, level, message, createdAt: ts(now()) });
}

export function message(conversationId: bigint, role: string, kind: string, body: string, workloadId = 0n) {
  const id = nextId();
  insert("myMessages", { id, conversationId, owner: OWNER, role, kind, body, workloadId, channel: "web", createdAt: ts(now()) });
  patch("myConversations", (c) => c.id === conversationId, { updatedAt: ts(now()) });
  return id;
}

/* ── Tick ────────────────────────────────────────────────────────────── */

function tick() {
  const t = now();
  // Spend accrues on everything that's billing.
  for (const w of rows("myWorkloads")) {
    if (BILLABLE.has(w.status) && w.startedAt) {
      const add = (w.hourlyCents / 3600) * SPEED;
      const accrued = Math.round(w.accruedCents + add + Math.random() * 0.3);
      patch("myWorkloads", (x) => x.id === w.id, { accruedCents: Math.max(accrued, w.accruedCents), lastActiveAt: ts(t) });
    }
  }
  update("platform", (p) => p.map((r) => ({ ...r, globalSpentCents: r.globalSpentCents + (Math.random() < 0.5 ? 1 : 0), updatedAt: ts(t) })));

  trainingTick();
  bootTick();
  agentTick();
}

function trainingTick() {
  const w = wl(W.train);
  if (!w || w.status !== "running") return;
  trainStep += 2;
  if (trainStep > TRAIN_TOTAL) {
    setWorkload(W.train, { status: "succeeded", statusDetail: "Finished · eval loss 0.66" });
    event(W.train, "Uploaded adapter, evaluation report and samples", "success");
    message(C.train, "assistant", "status", "Llama 3.1 8B: support-ticket LoRA finished. Your adapter and samples are ready to download.", W.train);
    return;
  }
  const at = ts(now());
  insert("myLogs", { id: nextId(), workloadId: W.train, owner: OWNER, text: logLine(trainStep, TRAIN_TOTAL), createdAt: at });
  update("myMetrics", (m) => [
    ...m,
    { id: nextId(), workloadId: W.train, owner: OWNER, name: "loss", step: trainStep, value: lossAt(trainStep), createdAt: at },
    { id: nextId(), workloadId: W.train, owner: OWNER, name: "learning_rate", step: trainStep, value: 2e-4 * (0.5 * (1 + Math.cos((Math.PI * trainStep) / TRAIN_TOTAL))), createdAt: at },
    { id: nextId(), workloadId: W.train, owner: OWNER, name: "tokens_per_sec", step: trainStep, value: 3050 + Math.sin(trainStep * 0.2) * 140, createdAt: at },
    ...(trainStep % 50 === 0 ? [{ id: nextId(), workloadId: W.train, owner: OWNER, name: "eval_loss", step: trainStep, value: lossAt(trainStep) + 0.09, createdAt: at }] : []),
  ]);
  const epoch = Math.min(3, Math.floor((trainStep / TRAIN_TOTAL) * 3) + 1);
  if (w.statusDetail !== `Training · epoch ${epoch} of 3`) setWorkload(W.train, { statusDetail: `Training · epoch ${epoch} of 3` });
  if (trainStep % 200 === 0) event(W.train, `Checkpoint saved at step ${trainStep}`);
}

const BOOT: [number, string, string, string][] = [
  [3_000, "provisioning", "Reserving an L4 on NVIDIA Brev", "Instance created on GCP (g2-standard-4, L4)"],
  [14_000, "configuring", "Installing the desktop and apps", "Machine reachable over SSH; configuring the environment"],
  [30_000, "running", "Ready", "Desktop ready"],
];

function bootTick() {
  for (const [id, began] of boot) {
    const w = wl(id);
    if (!w) continue;
    const elapsed = now() - began;
    for (const [after, status, detail, ev] of BOOT) {
      if (elapsed >= after && phaseIndex(w.status) < phaseIndex(status)) {
        setWorkload(id, { status, statusDetail: detail, ...(status === "provisioning" ? { startedAt: ts(now()) } : {}) });
        event(id, ev, status === "running" ? "success" : "info");
        if (status === "running") {
          message(w.conversationId || C.status, "assistant", "status", `Your ${w.title} is ready.`, id);
          boot.delete(id);
        }
        break;
      }
    }
  }
}

const ORDER = ["planned", "approved", "provisioning", "configuring", "running"];
const phaseIndex = (s: string) => ORDER.indexOf(s);

/* ── Desktop agent ───────────────────────────────────────────────────── */

const LOCAL_SCRIPTS: Record<string, string[]> = {
  blender: [
    "Looked at the screen",
    "Opened Blender from the applications menu",
    "Dismissed the splash screen",
    "Selected the default cube",
    "Deleted the default cube",
    "Added a cone for the tree crown",
    "Scaled the crown up",
    "Moved the crown up",
    "Added a cylinder for the trunk",
    "Made the trunk thinner",
    "Orbited the view to check the shape",
    "Saved the project to ~/Projects/tree.blend",
  ],
  terminal: ["Opened a terminal", "Checked the system", "Ran a Python check", "Listed the home folder"],
};

const AMBIENT_GOALS = [
  { goal: "Model a simple low-poly tree", script: "blender" },
  { goal: "Check the machine from a terminal", script: "terminal" },
];
let ambient = 0;

export async function startAgentRun(workloadId: bigint, goal: string) {
  const w = wl(workloadId);
  if (!w || w.status !== "running" || runs.has(workloadId)) return null;
  const script = /blender|model|tree|cube|scene|island|3d/i.test(goal) || w.id === W.blender ? "blender" : "terminal";
  const runId = nextId();
  insert("myAgentRuns", { id: runId, workloadId, owner: OWNER, goal, status: "running", result: "", stepCount: 0, startedAt: ts(now()), endedAt: undefined });
  setWorkload(workloadId, { controller: "agent" });
  let viaContainer = false;
  try {
    const res = await fetch(`${AGENT_URL}/run?script=${script}`, { signal: AbortSignal.timeout(1500) });
    viaContainer = res.ok;
  } catch {
    viaContainer = false;
  }
  runs.set(workloadId, { runId, seen: 0, script, viaContainer, local: LOCAL_SCRIPTS[script], next: now() + 1500 });
  event(workloadId, `Agent started: ${goal}`);
  return runId;
}

function addStep(workloadId: bigint, runId: bigint, summary: string) {
  const run = rows("myAgentRuns").find((r) => r.id === runId);
  if (!run) return;
  const seq = run.stepCount + 1;
  insert("myAgentSteps", {
    id: nextId(),
    runId,
    workloadId,
    owner: OWNER,
    seq,
    kind: summary.startsWith("Looked") ? "observe" : "act",
    summary,
    detail: "",
    screenshotKey: "",
    createdAt: ts(now()),
  });
  patch("myAgentRuns", (r) => r.id === runId, { stepCount: seq });
}

function finishRun(workloadId: bigint, status: "done" | "paused", result: string) {
  const r = runs.get(workloadId);
  if (!r) return;
  runs.delete(workloadId);
  patch("myAgentRuns", (x) => x.id === r.runId, { status, result, endedAt: status === "paused" ? undefined : ts(now()) });
  idleSince = now();
  if (status === "done") {
    const w = wl(workloadId);
    event(workloadId, "Agent finished", "success");
    if (w) message(w.conversationId, "assistant", "agent", result, workloadId);
  }
}

let polling = false;
async function agentTick() {
  for (const [wid, r] of runs) {
    const w = wl(wid);
    if (!w || w.controller !== "agent") {
      finishRun(wid, "paused", "You took over. Hand control back to continue.");
      continue;
    }
    if (r.viaContainer) {
      if (polling) continue;
      polling = true;
      try {
        const s = (await (await fetch(`${AGENT_URL}/status`, { signal: AbortSignal.timeout(1500) })).json()) as { steps: string[]; done: boolean };
        for (const summary of s.steps.slice(r.seen)) addStep(wid, r.runId, summary);
        r.seen = s.steps.length;
        if (s.done && r.seen > 0) finishRun(wid, "done", resultFor(r.script));
      } catch {
        r.viaContainer = false;
      } finally {
        polling = false;
      }
    } else if (r.local && now() >= (r.next ?? 0)) {
      const summary = r.local[r.seen];
      if (summary) {
        addStep(wid, r.runId, summary);
        r.seen += 1;
        r.next = now() + 2200 + Math.random() * 1200;
      } else finishRun(wid, "done", resultFor(r.script));
    }
  }
  // Keep the flagship desktop busy so the stream always shows the agent working.
  const b = wl(W.blender);
  if (b?.status === "running" && b.controller === "agent" && !runs.has(W.blender) && now() - idleSince > 12_000) {
    const g = AMBIENT_GOALS[ambient++ % AMBIENT_GOALS.length];
    void startAgentRun(W.blender, g.goal);
  }
}

function resultFor(script: string) {
  return script === "blender"
    ? "Done. I deleted the default cube, built a low-poly tree from a cone crown and a cylinder trunk, checked it from a few angles, and saved it as **~/Projects/tree.blend**."
    : "Done. The machine is healthy: Linux on a GPU instance, Python 3 working, and your home folder is in place.";
}

/* ── Actions from the UI ─────────────────────────────────────────────── */

export function workloadAction(id: bigint, action: string) {
  const w = wl(id);
  if (!w) throw new Error("Workload not found");
  switch (action) {
    case "approve":
      setWorkload(id, { status: "approved", statusDetail: "Approved" });
      event(id, `Plan approved, up to $${(w.estHighCents / 100).toFixed(2)}`);
      if (w.kind === "desktop") boot.set(id, now());
      else {
        boot.set(id, now());
        setTimeout(() => setWorkload(id, { statusDetail: "Training · epoch 1 of 3" }), 31_000);
      }
      return;
    case "cancel":
      setWorkload(id, { status: "cancelled", statusDetail: "Cancelled" });
      boot.delete(id);
      return;
    case "stop":
      setWorkload(id, { status: "stopping", statusDetail: "Saving ~/Projects, then stopping" });
      event(id, "Saving project files before stopping");
      finishRun(id, "paused", "Stopped with the machine.");
      setTimeout(() => {
        setWorkload(id, { status: "stopped", statusDetail: "Stopped, files saved" });
        event(id, "Stopped. Billing paused.");
        message(w.conversationId || C.status, "assistant", "status", `${w.title} stopped. Your files are saved, resume anytime.`, id);
      }, 4000);
      return;
    case "resume":
      setWorkload(id, { status: "approved", statusDetail: "Resuming" });
      boot.set(id, now());
      return;
    case "save":
      setWorkload(id, { status: "saving", statusDetail: "Saving ~/Projects" });
      setTimeout(() => {
        setWorkload(id, { status: "running", statusDetail: "Ready" });
        patch("myProjects", (p) => p.id === (w.projectId || w.id), { lastSavedAt: ts(now()) });
        event(id, "Saved ~/Projects to storage");
      }, 2500);
      return;
    case "delete":
      setWorkload(id, { status: "terminated", statusDetail: "Deleted" });
      return;
  }
}

export function takeOver(id: bigint) {
  setWorkload(id, { controller: "user" });
  finishRun(id, "paused", "You took over. Hand control back to continue.");
}

export function handBack(id: bigint) {
  setWorkload(id, { controller: "agent" });
  idleSince = 0;
}

/* ── Chat ────────────────────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let call = 50_000;

async function tool(cid: bigint, name: string, args: Record<string, unknown>, run: () => unknown | Promise<unknown>, wid = 0n, delay = 900) {
  const id = ++call;
  message(cid, "assistant", "tool_call", JSON.stringify({ call_id: id, name, args }), wid);
  const started = now();
  await sleep(delay);
  const out = await run();
  message(cid, "assistant", "tool_result", JSON.stringify({ call_id: id, name, ok: true, output: typeof out === "string" ? out : JSON.stringify(out), ms: now() - started }), wid);
  return out;
}

async function say(cid: bigint, text: string) {
  await sleep(500);
  const id = message(cid, "assistant", "text", "");
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i += 2) {
    const body = words.slice(0, i + 2).join("");
    patch("myMessages", (m) => m.id === id, { body });
    await sleep(18 + Math.random() * 22);
  }
}

export async function respond(cid: bigint, text: string, focus: bigint | null) {
  const t = text.toLowerCase();
  const w = focus ? wl(focus) : undefined;
  await sleep(700);

  if (w && w.kind === "desktop" && !/\?$/.test(t.trim()) && !/^(what|how|is|are|why)\b/.test(t)) {
    if (w.status !== "running") return say(cid, `This desktop isn’t running right now (${w.status}). Resume it and I’ll take it from there.`);
    const runId = await tool(cid, "operate_desktop", { workload_id: Number(w.id), goal: text }, async () => ({ ok: true, run_id: Number(await startAgentRun(w.id, text)), workload_id: Number(w.id) }), w.id, 600);
    if (!runId) return;
    return say(cid, "On it, you can watch me work in the desktop. Press **Take over** any time to drive yourself.");
  }

  if (w || /train|progress|loss|how.?s it|going|done yet/.test(t)) {
    const target = w ?? wl(W.train)!;
    await tool(cid, "inspect_workload", { workload_id: Number(target.id) }, () => ({ ok: true, status: target.status }), target.id);
    if (target.kind === "batch" && target.status === "running") {
      const pct = Math.round((trainStep / TRAIN_TOTAL) * 100);
      const left = Math.round(((TRAIN_TOTAL - trainStep) / 2) * 3.4 / 60);
      return say(cid, `Training is **${pct}%** through, step **${trainStep.toLocaleString()} of ${TRAIN_TOTAL.toLocaleString()}**. Loss is **${lossAt(trainStep).toFixed(3)}** (it started at 2.93) and eval loss is tracking just above it, so it isn’t overfitting. Roughly **${left} minutes** left, **$${(target.accruedCents / 100).toFixed(2)}** spent so far.`);
    }
    if (target.kind === "desktop") {
      const r = rows("myAgentRuns").filter((x) => x.workloadId === target.id).at(-1);
      return say(cid, `${target.title} is **${target.status}** on an NVIDIA ${target.gpuName}, **$${(target.accruedCents / 100).toFixed(2)}** so far.${r ? ` The last agent task was “${r.goal}”, ${r.status === "running" ? "still in progress" : r.result.replace(/\*\*/g, "")}` : ""}`);
    }
    return say(cid, `${target.title} is **${target.status}**. ${target.statusDetail}`);
  }

  if (/running|cost|spend|spent|machines/.test(t)) {
    const live = rows("myWorkloads").filter((x) => BILLABLE.has(x.status));
    await tool(cid, "list_workloads", {}, () => live.map((x) => ({ workload_id: Number(x.id), status: x.status })));
    const table = live.map((x) => `| ${x.title} | ${x.gpuName} | $${(x.accruedCents / 100).toFixed(2)} | $${(x.hourlyCents / 100).toFixed(2)}/hr |`).join("\n");
    const rate = live.reduce((s, x) => s + x.hourlyCents, 0);
    return say(cid, `${live.length} machine${live.length === 1 ? " is" : "s are"} running:\n\n| Machine | GPU | Spent | Rate |\n|---|---|---|---|\n${table}\n\nTogether that’s **$${(rate / 100).toFixed(2)}/hr**.`);
  }

  if (/^(yes|yep|approve|go|do it|ok)/.test(t.trim())) {
    const planned = rows("myWorkloads").filter((x) => x.status === "planned").at(-1);
    if (planned) {
      await tool(cid, "approve_workload", { workload_id: Number(planned.id) }, () => (workloadAction(planned.id, "approve"), "Approved. Provisioning has started."), planned.id);
      return say(cid, "Approved, provisioning now. It usually takes 5–10 minutes; I’ll tell you when it’s ready.");
    }
  }

  if (/blender|unity|desktop|3d|vs ?code|jupyter|linux|box|fine.?tune|train|lora|model/.test(t)) {
    const batch = /fine.?tune|train|lora|model/.test(t) && !/blender|desktop/.test(t);
    const app = /jupyter/.test(t) ? "jupyter" : /vs ?code/.test(t) ? "vscode" : /linux|box/.test(t) ? "terminal" : "blender";
    await tool(cid, "list_workloads", {}, () => [], 0n, 500);
    const id = nextId();
    const title = batch ? "Llama 3.1 8B: LoRA fine-tune" : `${{ blender: "Blender", jupyter: "JupyterLab", vscode: "VS Code", terminal: "Linux" }[app]} desktop`;
    const plan = batch
      ? planDoc({ title, kind: "batch", summary: "LoRA fine-tune of Llama 3.1 8B on your dataset", offer: OFFERS.a10, hours: [1.8, 2.4], outputs: ["LoRA adapter (safetensors)", "Evaluation report"], method: "lora", alternatives: [OFFERS.l40s] })
      : planDoc({ title, kind: "desktop", app, summary: `A GPU desktop with ${title.replace(" desktop", "")}`, offer: app === "terminal" ? OFFERS.t4 : OFFERS.l4, hours: [2, 3], confidence: "high", outputs: ["A live desktop in your browser", "Project files saved to your Anywhere storage"], alternatives: [OFFERS.t4, OFFERS.a10] });
    await tool(cid, "propose_workload", { kind: batch ? "fine_tune" : "desktop", summary: plan.intent.summary, application: batch ? null : app }, () => {
      const o = plan.selected.offer;
      const e = plan.selected.estimate;
      insert("myWorkloads", {
        id, owner: OWNER, conversationId: cid, projectId: 0n, kind: batch ? "batch" : "desktop", title, summary: plan.intent.summary,
        status: "planned", statusDetail: "Waiting for approval", planJson: JSON.stringify(plan), instanceType: o.type, gpuName: o.gpu, provider: o.provider,
        hourlyCents: Math.round(o.price_per_hour * 100), estLowCents: e.cost_low_cents, estHighCents: e.cost_high_cents, accruedCents: 0, stoppable: o.stoppable,
        controller: "agent", createdAt: ts(now()), updatedAt: ts(now()), startedAt: undefined, lastActiveAt: undefined,
      });
      message(cid, "assistant", "plan", title, id);
      return { ok: true, workload_id: Number(id), allowed: true, blockers: [] };
    }, id, 1100);
    const e = plan.selected.estimate;
    return say(cid, `Here’s the plan: **${plan.selected.offer.label}** with an NVIDIA ${plan.selected.offer.gpu} (${plan.selected.offer.vram_gb} GB), about **$${(e.cost_low_cents / 100).toFixed(2)}–${(e.cost_high_cents / 100).toFixed(2)}** for ${e.hours_low}–${e.hours_high} hours. Approve it and I’ll set everything up.`);
  }

  return say(cid, "I can set up GPU desktops (Blender, VS Code, JupyterLab, Linux), fine-tune language models on your data, operate a running desktop for you, and keep an eye on cost. What would you like to do?");
}
