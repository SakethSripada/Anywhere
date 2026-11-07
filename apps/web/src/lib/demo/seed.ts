/** DEMO BRANCH ONLY. Seed data: a realistic, busy Anywhere account. */
import type { Message, Workload } from "@anywhere/stdb";
import type { Offer, PlanDoc } from "../plan";
import { OWNER, ts, type Rows } from "./store";

const H = 3_600_000;
const M = 60_000;

/* ── Catalog ─────────────────────────────────────────────────────────── */

export const OFFERS: Record<string, Offer> = {
  t4: { type: "g4dn.xlarge", provider: "aws", gpu: "T4", vram_gb: 16, vcpus: 4, ram_gb: 16, price_per_hour: 0.6312, stoppable: true, label: "Starter GPU", price_source: "Brev catalog", price_as_of: "2026-11-07" },
  l4: { type: "g2-standard-4:nvidia-l4:1", provider: "gcp", gpu: "L4", vram_gb: 24, vcpus: 4, ram_gb: 16, price_per_hour: 0.8454, stoppable: true, label: "Creator", price_source: "Brev catalog", price_as_of: "2026-11-07" },
  a10: { type: "g5.2xlarge", provider: "aws", gpu: "A10G", vram_gb: 24, vcpus: 8, ram_gb: 32, price_per_hour: 1.2124, stoppable: true, label: "Pro", price_source: "Brev catalog", price_as_of: "2026-11-07" },
  l40s: { type: "g6e.xlarge", provider: "aws", gpu: "L40S", vram_gb: 48, vcpus: 4, ram_gb: 32, price_per_hour: 1.861, stoppable: true, label: "Studio", price_source: "Brev catalog", price_as_of: "2026-11-07" },
  a100: { type: "a2-highgpu-1g", provider: "gcp", gpu: "A100", vram_gb: 40, vcpus: 12, ram_gb: 85, price_per_hour: 3.673, stoppable: false, label: "Research", price_source: "Brev catalog", price_as_of: "2026-11-07" },
};

export function planDoc(o: {
  title: string;
  kind: "desktop" | "batch";
  summary: string;
  app?: string;
  offer: Offer;
  hours: [number, number];
  confidence?: "low" | "medium" | "high";
  outputs: string[];
  method?: string;
  dataset?: { name: string; rows: number };
  alternatives?: Offer[];
}): PlanDoc {
  const cost = (h: number, off: Offer) => Math.round(h * off.price_per_hour * 100);
  return {
    title: o.title,
    intent: { kind: o.kind, summary: o.summary, application: o.app ?? null },
    requirements: {
      min_vram_gb: o.offer.vram_gb,
      min_ram_gb: 16,
      min_vcpus: 4,
      needs_stoppable: o.kind === "desktop",
      mode: o.kind === "desktop" ? "interactive" : "batch",
      environment: o.kind === "desktop" ? `${o.app ?? "linux"}-desktop` : "pytorch-2.6-cuda-12.4",
      method: o.method ?? null,
      rationale:
        o.kind === "desktop"
          ? ["Interactive work needs a persistent desktop you can return to.", "Only stoppable machines qualify, so pausing keeps your disk.", `${o.offer.vram_gb} GB of video memory keeps typical scenes and tools comfortable.`]
          : [`${o.method?.toUpperCase() ?? "Training"} on this model fits in ${o.offer.vram_gb} GB with room for a reasonable batch size.`, "Batch jobs shut down automatically when they finish.", "bf16 support avoids slow fp32 fallbacks."],
    },
    selected: {
      offer: o.offer,
      estimate: {
        hours_low: o.hours[0],
        hours_high: o.hours[1],
        cost_low_cents: cost(o.hours[0], o.offer),
        cost_high_cents: cost(o.hours[1], o.offer),
        confidence: o.confidence ?? "medium",
        assumptions:
          o.kind === "desktop"
            ? [`About ${o.hours[1]} hours of active use.`, "Includes ~9 minutes of setup.", "Stopping when idle pauses billing."]
            : ["Throughput measured on similar models and sequence lengths.", "Includes ~6 minutes of setup and checkpoint upload.", "Early stopping could finish sooner."],
      },
    },
    alternatives: (o.alternatives ?? []).map((a) => ({
      offer: a,
      estimate: { hours_low: o.hours[0], hours_high: o.hours[1], cost_low_cents: cost(o.hours[0], a), cost_high_cents: cost(o.hours[1], a), confidence: "medium", assumptions: [] },
    })),
    outputs: o.outputs,
    warnings: [],
    policy: { blockers: [], notes: [] },
    inputs: o.dataset ? { dataset_name: o.dataset.name, dataset_rows: o.dataset.rows } : undefined,
  };
}

/* ── IDs ─────────────────────────────────────────────────────────────── */

export const W = {
  blender: 56340000000001n,
  train: 56340000000002n,
  vscode: 56340000000003n,
  mistral: 56340000000004n,
  jupyter: 56340000000005n,
  qwen: 56340000000006n,
  failed: 56340000000007n,
  phi: 56340000000008n,
  devbox: 56340000000009n,
  cancelled: 56340000000010n,
  sdxl: 56340000000011n,
};
export const C = {
  blender: 56341000000001n,
  train: 56341000000002n,
  qwen: 56341000000003n,
  imsg: 56341000000004n,
  status: 56341000000005n,
  mistral: 56341000000006n,
  devbox: 56341000000007n,
  sdxl: 56341000000008n,
};

/* ── Builders ────────────────────────────────────────────────────────── */

function workload(
  now: number,
  w: {
    id: bigint;
    conv: bigint;
    kind: "desktop" | "batch";
    title: string;
    summary: string;
    status: string;
    detail?: string;
    plan: PlanDoc;
    startedAgo?: number;
    accrued?: number;
    controller?: string;
    updatedAgo?: number;
    createdAgo: number;
    project?: bigint;
  },
): Workload {
  const o = w.plan.selected.offer;
  const e = w.plan.selected.estimate;
  return {
    id: w.id,
    owner: OWNER,
    conversationId: w.conv,
    projectId: w.project ?? 0n,
    kind: w.kind,
    title: w.title,
    summary: w.summary,
    status: w.status,
    statusDetail: w.detail ?? "",
    planJson: JSON.stringify(w.plan),
    instanceType: o.type,
    gpuName: o.gpu,
    provider: o.provider,
    hourlyCents: Math.round(o.price_per_hour * 100),
    estLowCents: e.cost_low_cents,
    estHighCents: e.cost_high_cents,
    accruedCents: w.accrued ?? 0,
    stoppable: o.stoppable,
    controller: w.controller ?? "agent",
    createdAt: ts(now - w.createdAgo),
    updatedAt: ts(now - (w.updatedAgo ?? 0)),
    startedAt: w.startedAgo != null ? ts(now - w.startedAgo) : undefined,
    lastActiveAt: ts(now - (w.updatedAgo ?? 0)),
  };
}

let msgId = 100n;
function chat(now: number, conv: bigint, startAgo: number, items: [string, string, string, bigint?][]): Message[] {
  return items.map(([role, kind, body, wid], i) => ({
    id: ++msgId,
    conversationId: conv,
    owner: OWNER,
    role,
    kind,
    body,
    workloadId: wid ?? 0n,
    channel: "web",
    createdAt: ts(now - startAgo + i * 4000),
  }));
}

let callId = 9000;
function tool(name: string, args: Record<string, unknown>, output: unknown, ms: number, wid?: bigint): [string, string, string, bigint?][] {
  const id = ++callId;
  return [
    ["assistant", "tool_call", JSON.stringify({ call_id: id, name, args }), wid],
    ["assistant", "tool_result", JSON.stringify({ call_id: id, name, ok: true, output: typeof output === "string" ? output : JSON.stringify(output), ms }), wid],
  ];
}

/* ── Training telemetry ──────────────────────────────────────────────── */

export function lossAt(step: number, seed = 0) {
  const noise = Math.sin(step * 0.37 + seed) * 0.035 + Math.sin(step * 1.7 + seed * 3) * 0.02;
  return 2.35 * Math.exp(-step / 260) + 0.58 + noise;
}

export function logLine(step: number, total: number, seed = 0) {
  const loss = lossAt(step, seed);
  const lr = 2e-4 * (0.5 * (1 + Math.cos((Math.PI * step) / total)));
  const tps = Math.round(3050 + Math.sin(step * 0.2) * 140);
  return `{'loss': ${loss.toFixed(4)}, 'grad_norm': ${(0.42 + Math.abs(Math.sin(step)) * 0.3).toFixed(3)}, 'learning_rate': ${lr.toExponential(3)}, 'epoch': ${((step / total) * 3).toFixed(2)}, 'step': ${step}, 'tokens_per_sec': ${tps}}\n`;
}

function trainingHistory(wid: bigint, upTo: number, total: number, now: number, seed: number, startedAgo: number) {
  const metrics: Rows["myMetrics"][] = [];
  const logs: Rows["myLogs"][] = [];
  let id = wid * 10_000n;
  const header =
    "Loading checkpoint shards: 100%|██████████| 4/4 [00:41<00:00, 10.3s/it]\n" +
    "trainable params: 41,943,040 || all params: 8,072,204,288 || trainable%: 0.5196\n" +
    `***** Running training *****\n  Num examples = 12,480\n  Num Epochs = 3\n  Total optimization steps = ${total}\n`;
  logs.push({ id: ++id, workloadId: wid, owner: OWNER, text: header, createdAt: ts(now - startedAgo) });
  for (let s = 5; s <= upTo; s += 5) {
    const at = now - startedAgo + (s / upTo) * (startedAgo - 60_000);
    metrics.push({ id: ++id, workloadId: wid, owner: OWNER, name: "loss", step: s, value: lossAt(s, seed), createdAt: ts(at) });
    metrics.push({ id: ++id, workloadId: wid, owner: OWNER, name: "learning_rate", step: s, value: 2e-4 * (0.5 * (1 + Math.cos((Math.PI * s) / total))), createdAt: ts(at) });
    metrics.push({ id: ++id, workloadId: wid, owner: OWNER, name: "tokens_per_sec", step: s, value: 3050 + Math.sin(s * 0.2) * 140, createdAt: ts(at) });
    if (s % 50 === 0) metrics.push({ id: ++id, workloadId: wid, owner: OWNER, name: "eval_loss", step: s, value: lossAt(s, seed) + 0.09, createdAt: ts(at) });
    if (s % 10 === 0) logs.push({ id: ++id, workloadId: wid, owner: OWNER, text: logLine(s, total, seed), createdAt: ts(at) });
  }
  return { metrics, logs };
}

/* ── Seed ────────────────────────────────────────────────────────────── */

export const TRAIN_TOTAL = 1170;
export const TRAIN_START_STEP = 620;

export function seed() {
  const now = Date.now();

  const plans = {
    blender: planDoc({ title: "Blender desktop", kind: "desktop", app: "blender", summary: "A GPU desktop with Blender for a low-poly island game scene.", offer: OFFERS.l4, hours: [3, 3.5], confidence: "high", outputs: ["A live desktop in your browser", "Project files saved to your Anywhere storage"], alternatives: [OFFERS.t4, OFFERS.a10] }),
    train: planDoc({ title: "Llama 3.1 8B: support-ticket LoRA", kind: "batch", summary: "Fine-tune Llama 3.1 8B with LoRA on 12,480 support tickets, then test it.", offer: OFFERS.a10, hours: [2, 2.6], outputs: ["LoRA adapter (safetensors)", "Evaluation report", "20 sample generations"], method: "lora", dataset: { name: "support_tickets.jsonl", rows: 12480 }, alternatives: [OFFERS.l40s, OFFERS.a100] }),
    vscode: planDoc({ title: "VS Code GPU workspace", kind: "desktop", app: "vscode", summary: "A Linux desktop with VS Code and CUDA for a few hours of dev work.", offer: OFFERS.t4, hours: [2, 4], outputs: ["A live desktop in your browser", "Project files saved to your Anywhere storage"] }),
    mistral: planDoc({ title: "Mistral 7B: legal clause QLoRA", kind: "batch", summary: "QLoRA fine-tune of Mistral 7B on 8,200 contract clauses.", offer: OFFERS.l4, hours: [3, 3.8], outputs: ["QLoRA adapter (safetensors)", "Evaluation report", "Sample generations"], method: "qlora", dataset: { name: "clauses_v2.csv", rows: 8200 } }),
    jupyter: planDoc({ title: "JupyterLab: embeddings exploration", kind: "desktop", app: "jupyter", summary: "A JupyterLab desktop with a GPU to explore sentence embeddings.", offer: OFFERS.l4, hours: [1.5, 2], outputs: ["A live desktop in your browser", "Notebooks saved to your Anywhere storage"] }),
    qwen: planDoc({ title: "Qwen 2.5 7B: text-to-SQL LoRA", kind: "batch", summary: "LoRA fine-tune of Qwen 2.5 7B on 5,600 text-to-SQL pairs.", offer: OFFERS.a10, hours: [1.4, 1.9], outputs: ["LoRA adapter (safetensors)", "Exact-match accuracy on a held-out set"], method: "lora", dataset: { name: "spider_subset.jsonl", rows: 5600 }, alternatives: [OFFERS.l4, OFFERS.l40s] }),
    failed: planDoc({ title: "Llama 3.1 8B: full fine-tune", kind: "batch", summary: "Full-parameter fine-tune of Llama 3.1 8B on product reviews.", offer: OFFERS.a10, hours: [4, 5], outputs: ["Fine-tuned model weights"], method: "full", dataset: { name: "reviews.jsonl", rows: 40100 } }),
    phi: planDoc({ title: "Phi-3 mini: tone classifier", kind: "batch", summary: "LoRA fine-tune of Phi-3 mini to classify support tone.", offer: OFFERS.t4, hours: [0.6, 0.9], confidence: "high", outputs: ["LoRA adapter (safetensors)", "Confusion matrix"], method: "lora", dataset: { name: "tone_labels.csv", rows: 3100 } }),
    devbox: planDoc({ title: "Ubuntu dev box", kind: "desktop", app: "terminal", summary: "A general Linux desktop with a GPU for experiments.", offer: OFFERS.t4, hours: [2, 3], outputs: ["A live desktop in your browser"] }),
    cancelled: planDoc({ title: "Blender: product turntable", kind: "desktop", app: "blender", summary: "Render a product turntable animation.", offer: OFFERS.l40s, hours: [2, 3], outputs: ["Rendered frames"] }),
    sdxl: planDoc({ title: "SDXL LoRA: brand illustrations", kind: "batch", summary: "Train an SDXL LoRA on 64 brand illustrations.", offer: OFFERS.l40s, hours: [1, 1.4], outputs: ["SDXL LoRA weights", "Sample grid"], method: "lora", dataset: { name: "brand_style.jsonl", rows: 64 } }),
  };

  const workloads: Workload[] = [
    workload(now, { id: W.blender, conv: C.blender, kind: "desktop", title: "Blender: low-poly island", summary: plans.blender.intent.summary, status: "running", detail: "Ready", plan: plans.blender, startedAgo: 48 * M, accrued: 68, createdAgo: 52 * M, project: 77001n }),
    workload(now, { id: W.train, conv: C.train, kind: "batch", title: "Llama 3.1 8B: support-ticket LoRA", summary: plans.train.intent.summary, status: "running", detail: "Training · epoch 2 of 3", plan: plans.train, startedAgo: 71 * M, accrued: 143, createdAgo: 75 * M }),
    workload(now, { id: W.devbox, conv: C.devbox, kind: "desktop", title: "Ubuntu dev box", summary: plans.devbox.intent.summary, status: "running", detail: "Ready", plan: plans.devbox, startedAgo: 19 * M, accrued: 20, controller: "user", createdAgo: 24 * M, project: 77004n }),
    workload(now, { id: W.jupyter, conv: C.status, kind: "desktop", title: "JupyterLab: embeddings", summary: plans.jupyter.intent.summary, status: "approved", detail: "Approved", plan: plans.jupyter, createdAgo: 1 * M, project: 77003n }),
    workload(now, { id: W.qwen, conv: C.qwen, kind: "batch", title: "Qwen 2.5 7B: text-to-SQL LoRA", summary: plans.qwen.intent.summary, status: "planned", detail: "Waiting for approval", plan: plans.qwen, createdAgo: 6 * M }),
    workload(now, { id: W.vscode, conv: C.status, kind: "desktop", title: "VS Code GPU workspace", summary: plans.vscode.intent.summary, status: "stopped", detail: "Stopped after 20 minutes idle, files saved", plan: plans.vscode, startedAgo: 26 * H, accrued: 187, updatedAgo: 23 * H, createdAgo: 26 * H, project: 77002n }),
    workload(now, { id: W.mistral, conv: C.mistral, kind: "batch", title: "Mistral 7B: legal clause QLoRA", summary: plans.mistral.intent.summary, status: "succeeded", detail: "Finished · eval loss 0.71", plan: plans.mistral, startedAgo: 2 * 24 * H, accrued: 284, updatedAgo: 2 * 24 * H - 3.4 * H, createdAgo: 2 * 24 * H + 10 * M }),
    workload(now, { id: W.phi, conv: C.status, kind: "batch", title: "Phi-3 mini: tone classifier", summary: plans.phi.intent.summary, status: "succeeded", detail: "Finished · 94.2% accuracy", plan: plans.phi, startedAgo: 4 * 24 * H, accrued: 47, updatedAgo: 4 * 24 * H - 44 * M, createdAgo: 4 * 24 * H + 5 * M }),
    workload(now, { id: W.sdxl, conv: C.sdxl, kind: "batch", title: "SDXL LoRA: brand illustrations", summary: plans.sdxl.intent.summary, status: "succeeded", detail: "Finished · 1,500 steps", plan: plans.sdxl, startedAgo: 3 * 24 * H, accrued: 173, updatedAgo: 3 * 24 * H - 1.2 * H, createdAgo: 3 * 24 * H + 3 * M }),
    workload(now, { id: W.failed, conv: C.status, kind: "batch", title: "Llama 3.1 8B: full fine-tune", summary: plans.failed.intent.summary, status: "failed", detail: "CUDA out of memory at step 1, full fine-tuning an 8B model needs more than 24 GB", plan: plans.failed, startedAgo: 5 * 24 * H, accrued: 19, updatedAgo: 5 * 24 * H - 12 * M, createdAgo: 5 * 24 * H + 2 * M }),
    workload(now, { id: W.cancelled, conv: C.status, kind: "desktop", title: "Blender: product turntable", summary: plans.cancelled.intent.summary, status: "cancelled", detail: "Cancelled before it started", plan: plans.cancelled, createdAgo: 6 * 24 * H, updatedAgo: 6 * 24 * H - 2 * M }),
  ];

  /* Conversations */
  const conversations: Rows["myConversations"][] = [
    { id: C.blender, owner: OWNER, title: "Low-poly island in Blender", channel: "web", archived: false, createdAt: ts(now - 52 * M), updatedAt: ts(now - 2 * M) },
    { id: C.train, owner: OWNER, title: "Fine-tune Llama on support tickets", channel: "web", archived: false, createdAt: ts(now - 75 * M), updatedAt: ts(now - 9 * M) },
    { id: C.qwen, owner: OWNER, title: "Text-to-SQL model", channel: "web", archived: false, createdAt: ts(now - 6 * M), updatedAt: ts(now - 5 * M) },
    { id: C.imsg, owner: OWNER, title: "Messages", channel: "imessage", archived: false, createdAt: ts(now - 30 * H), updatedAt: ts(now - 40 * M) },
    { id: C.devbox, owner: OWNER, title: "Quick GPU dev box", channel: "web", archived: false, createdAt: ts(now - 24 * M), updatedAt: ts(now - 18 * M) },
    { id: C.status, owner: OWNER, title: "What’s running and what it costs", channel: "web", archived: false, createdAt: ts(now - 26 * H), updatedAt: ts(now - 1 * M) },
    { id: C.mistral, owner: OWNER, title: "Legal clause model", channel: "web", archived: false, createdAt: ts(now - 2 * 24 * H), updatedAt: ts(now - 2 * 24 * H + 3.4 * H) },
    { id: C.sdxl, owner: OWNER, title: "SDXL style LoRA", channel: "web", archived: false, createdAt: ts(now - 3 * 24 * H), updatedAt: ts(now - 3 * 24 * H + 1.2 * H) },
  ];

  const messages: Message[] = [
    ...chat(now, C.blender, 52 * M, [
      ["user", "text", "I want to make a low-poly island scene for a little game. Set me up with Blender on a GPU."],
      ...tool("list_workloads", {}, [], 9),
      ...tool("propose_workload", { kind: "desktop", summary: "GPU desktop with Blender for a low-poly island scene", application: "blender", session_hours: 3 }, { ok: true, workload_id: Number(W.blender), allowed: true, blockers: [], auto_approved: false }, 31, W.blender),
      ["assistant", "plan", "Blender desktop", W.blender],
      ["assistant", "text", "Here’s the plan: a **Creator** machine with an NVIDIA L4 (24 GB) running Blender in a desktop you open from the browser, about **$2.54–2.96** for 3 hours. Your project saves to durable storage, so stopping never loses work.\n\nApprove it and I’ll set it up."],
      ["user", "text", "Approved, go."],
      ...tool("approve_workload", { workload_id: Number(W.blender) }, "Approved. Provisioning has started; progress updates will follow automatically.", 212, W.blender),
      ["assistant", "text", "Provisioning now. It usually takes 5–10 minutes, I’ll tell you when the desktop is ready."],
      ["assistant", "status", "Your Blender: low-poly island is ready.", W.blender],
      ["user", "text", "Can you block out the island and add a couple of trees?"],
      ...tool("operate_desktop", { workload_id: Number(W.blender), goal: "Block out a low-poly island and add two trees" }, { ok: true, run_id: 88000000000001, workload_id: Number(W.blender) }, 388, W.blender),
      ["assistant", "agent", "Done. I flattened a subdivided plane into an island shape, added a sand ring, and placed two low-poly trees (cone crown, cylinder trunk) near the north shore. The project is saved as **~/Projects/island.blend**.", W.blender],
      ["assistant", "text", "The island is blocked out with two trees. Want me to add water and a sky next, or would you like to take over from here?"],
    ]),
    ...chat(now, C.train, 75 * M, [
      ["user", "text", "Fine-tune Llama 3.1 8B on our support tickets so it drafts replies in our tone. Dataset attached.\n\n[Attached dataset: support_tickets.jsonl (upload id 4411), ~12,480 rows, messages format, 18.4 MB]"],
      ...tool("propose_workload", { kind: "fine_tune", summary: "LoRA fine-tune of Llama 3.1 8B on 12,480 support tickets", model_params_billions: 8, epochs: 3, dataset_upload_id: 4411 }, { ok: true, workload_id: Number(W.train), allowed: true, blockers: [], auto_approved: false }, 46, W.train),
      ["assistant", "plan", "Llama 3.1 8B: support-ticket LoRA", W.train],
      ["assistant", "text", "I’d use **LoRA** on an **A10G (24 GB)**: 3 epochs over 12,480 conversations, roughly **2–2.6 hours** and **$2.42–3.15**. You’ll get the adapter, an evaluation report and 20 sample replies.\n\nShall I start it?"],
      ["user", "text", "Yes"],
      ...tool("approve_workload", { workload_id: Number(W.train) }, "Approved. Provisioning has started; progress updates will follow automatically.", 198, W.train),
      ["assistant", "status", "Training started on a A10G. I’ll message you when it’s done.", W.train],
      ["user", "text", "How’s it going?"],
      ...tool("inspect_workload", { workload_id: Number(W.train) }, { ok: true, status: "running", latest_metrics: { loss: { step: 600, value: 0.66 } } }, 54, W.train),
      ["assistant", "text", "Going well, step **600 of 1,170** (epoch 2). Training loss is down from **2.93 → 0.66** and eval loss is tracking just above it, so it isn’t overfitting. About **55 minutes** left and **$1.43** spent so far."],
    ]),
    ...chat(now, C.qwen, 6 * M, [
      ["user", "text", "Train a text-to-SQL model on the Spider subset I uploaded. Cheapest option that’s still decent.\n\n[Attached dataset: spider_subset.jsonl (upload id 4520), ~5,600 rows, prompt_response format, 3.1 MB]"],
      ...tool("propose_workload", { kind: "fine_tune", summary: "LoRA fine-tune of Qwen 2.5 7B on 5,600 text-to-SQL pairs", model_params_billions: 7, preference: "cheapest", dataset_upload_id: 4520 }, { ok: true, workload_id: Number(W.qwen), allowed: true, blockers: [], auto_approved: false }, 39, W.qwen),
      ["assistant", "plan", "Qwen 2.5 7B: text-to-SQL LoRA", W.qwen],
      ["assistant", "text", "Qwen 2.5 7B is a strong base for SQL. LoRA on an **A10G** finishes in about **1.4–1.9 hours** for **$1.70–2.30**. The L4 is cheaper per hour but slower here, so it ends up costing about the same.\n\nApprove when you’re ready."],
    ]),
    ...chat(now, C.devbox, 24 * M, [
      ["user", "text", "Give me a plain Linux box with a GPU for an hour or two."],
      ...tool("propose_workload", { kind: "desktop", summary: "General Linux desktop with a GPU", application: "terminal", session_hours: 2 }, { ok: true, workload_id: Number(W.devbox), allowed: true, blockers: [], auto_approved: true }, 28, W.devbox),
      ["assistant", "text", "That fits under your auto-approve limit, so I started a **Starter GPU** (T4, 16 GB) at $0.63/hr. It’ll stop itself after 20 minutes idle."],
      ["assistant", "status", "Your Ubuntu dev box is ready.", W.devbox],
    ]),
    ...chat(now, C.status, 26 * H, [
      ["user", "text", "What’s running right now and what has it cost?"],
      ...tool("list_workloads", {}, [{ workload_id: Number(W.blender), status: "running" }, { workload_id: Number(W.train), status: "running" }], 11),
      ["assistant", "text", "Three machines are running:\n\n| Machine | GPU | Spent | Rate |\n|---|---|---|---|\n| Blender: low-poly island | L4 | $0.68 | $0.85/hr |\n| Llama 3.1 8B: support-ticket LoRA | A10G | $1.43 | $1.21/hr |\n| Ubuntu dev box | T4 | $0.20 | $0.63/hr |\n\nTogether that’s **$2.69/hr**. Your VS Code workspace is stopped, so it isn’t billing. You’ve spent **$9.41** of your **$50** cap this month."],
      ["user", "text", "Spin up a JupyterLab box so I can poke at embeddings."],
      ...tool("propose_workload", { kind: "desktop", summary: "JupyterLab desktop with a GPU for embeddings", application: "jupyter", session_hours: 2 }, { ok: true, workload_id: Number(W.jupyter), allowed: true, blockers: [], auto_approved: true }, 33, W.jupyter),
      ["assistant", "text", "Starting a **Creator** machine (L4) with JupyterLab: it was under your auto-approve limit. I’ll let you know when it’s ready."],
    ]),
    ...chat(now, C.mistral, 2 * 24 * H, [
      ["user", "text", "QLoRA Mistral 7B on the contract clauses CSV."],
      ...tool("propose_workload", { kind: "fine_tune", summary: "QLoRA fine-tune of Mistral 7B on 8,200 clauses", model_params_billions: 7 }, { ok: true, workload_id: Number(W.mistral) }, 41, W.mistral),
      ["assistant", "plan", "Mistral 7B: legal clause QLoRA", W.mistral],
      ["assistant", "status", "Mistral 7B: legal clause QLoRA finished. Your adapter and samples are ready to download.", W.mistral],
      ["assistant", "text", "Finished in **3h 24m** for **$2.84**. Final eval loss **0.71**. In the samples it now cites clause numbers and keeps defined terms capitalised. Grab the adapter from the job page."],
    ]),
    ...chat(now, C.sdxl, 3 * 24 * H, [
      ["user", "text", "Train an SDXL LoRA on our 64 brand illustrations."],
      ...tool("propose_workload", { kind: "fine_tune", summary: "SDXL LoRA on 64 illustrations" }, { ok: true, workload_id: Number(W.sdxl) }, 37, W.sdxl),
      ["assistant", "plan", "SDXL LoRA: brand illustrations", W.sdxl],
      ["assistant", "status", "SDXL LoRA: brand illustrations finished. Your adapter and samples are ready to download.", W.sdxl],
    ]),
  ];
  messages.push(
    ...chat(now, C.imsg, 30 * H, [
      ["user", "text", "is my llama job done yet"],
      ...tool("list_workloads", {}, [], 10),
      ["assistant", "text", "Not yet, it’s at step 600 of 1,170, about 55 minutes left. I’ll text you when it finishes."],
      ["user", "text", "stop the vscode one"],
      ...tool("stop_workload", { workload_id: Number(W.vscode) }, "Stopping. Files are saved first; resume any time.", 1420, W.vscode),
      ["assistant", "text", "Stopped your VS Code workspace. Files are saved and you can resume any time."],
    ]).map((m) => ({ ...m, channel: "imessage" })),
  );

  /* Telemetry */
  const train = trainingHistory(W.train, TRAIN_START_STEP, TRAIN_TOTAL, now, 0, 71 * M - 6 * M);
  const mistral = trainingHistory(W.mistral, 1530, 1530, now - 2 * 24 * H + 3.4 * H, 2, 3.3 * H);
  const phi = trainingHistory(W.phi, 390, 390, now - 4 * 24 * H + 44 * M, 5, 38 * M);
  const sdxl = trainingHistory(W.sdxl, 1500, 1500, now - 3 * 24 * H + 1.2 * H, 7, 1.1 * H);
  let eid = 500n;
  const ev = (wid: bigint, ago: number, message: string, level = "info"): Rows["myEvents"] => ({ id: ++eid, workloadId: wid, owner: OWNER, level, message, createdAt: ts(now - ago) });

  const events = [
    ev(W.blender, 52 * M, "Plan approved, up to $2.96"),
    ev(W.blender, 51 * M, "Instance anywhere-56340001 created on GCP (g2-standard-4, L4)"),
    ev(W.blender, 47 * M, "Desktop environment configured; Blender 4.5 installed"),
    ev(W.blender, 46 * M, "Restored project from storage (0 files)"),
    ev(W.blender, 30 * M, "Agent finished: block out island and add trees", "success"),
    ev(W.blender, 29 * M, "Saved ~/Projects to storage (14.2 MB)"),
    ev(W.train, 75 * M, "Plan approved, up to $3.15"),
    ev(W.train, 74 * M, "Instance anywhere-56340002 created on AWS (g5.2xlarge, A10G)"),
    ev(W.train, 68 * M, "Dataset support_tickets.jsonl downloaded (18.4 MB)"),
    ev(W.train, 65 * M, "Training started: LoRA r=16, 3 epochs, 1,170 steps"),
    ev(W.train, 22 * M, "Checkpoint saved at step 400"),
    ev(W.devbox, 23 * M, "Instance anywhere-56340009 created on AWS (g4dn.xlarge, T4)"),
    ev(W.devbox, 19 * M, "Desktop ready"),
    ev(W.vscode, 26 * H, "Instance created on AWS (g4dn.xlarge, T4)"),
    ev(W.vscode, 23 * H, "Idle for 20 minutes, saving and stopping", "warn"),
    ev(W.vscode, 23 * H - 60_000, "Stopped. Saved ~/Projects (212 MB)"),
    ev(W.mistral, 2 * 24 * H, "Training started: QLoRA r=16, 3 epochs"),
    ev(W.mistral, 2 * 24 * H - 3.3 * H, "Uploaded adapter and evaluation report", "success"),
    ev(W.failed, 5 * 24 * H, "Training started: full fine-tune, bf16"),
    ev(W.failed, 5 * 24 * H - 11 * M, "CUDA out of memory: tried to allocate 1.96 GiB", "error"),
    ev(W.failed, 5 * 24 * H - 12 * M, "Instance terminated; no further charges"),
    ev(W.jupyter, 60_000, "Plan auto-approved, under your $5 limit"),
  ];

  const failedLogs: Rows["myLogs"][] = [
    { id: 70001n, workloadId: W.failed, owner: OWNER, text: "Loading checkpoint shards: 100%|██████████| 4/4\n***** Running training *****\n  Num examples = 40,100\n", createdAt: ts(now - 5 * 24 * H) },
    { id: 70002n, workloadId: W.failed, owner: OWNER, text: "Traceback (most recent call last):\n  File \"/opt/anywhere/train.py\", line 211, in <module>\n    trainer.train()\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.96 GiB. GPU 0 has a total capacity of 22.07 GiB of which 1.12 GiB is free.\n", createdAt: ts(now - 5 * 24 * H + 60_000) },
  ];

  const artifacts: Rows["myArtifacts"][] = [
    { id: 60001n, workloadId: W.mistral, owner: OWNER, name: "adapter_model.safetensors", storageKey: "u/demo/w/4/adapter_model.safetensors", contentType: "application/octet-stream", sizeBytes: 83_886_080n, createdAt: ts(now - 2 * 24 * H + 3.4 * H) },
    { id: 60002n, workloadId: W.mistral, owner: OWNER, name: "eval_report.json", storageKey: "u/demo/w/4/eval_report.json", contentType: "application/json", sizeBytes: 18_420n, createdAt: ts(now - 2 * 24 * H + 3.4 * H) },
    { id: 60003n, workloadId: W.mistral, owner: OWNER, name: "samples.jsonl", storageKey: "u/demo/w/4/samples.jsonl", contentType: "application/jsonl", sizeBytes: 41_337n, createdAt: ts(now - 2 * 24 * H + 3.4 * H) },
    { id: 60004n, workloadId: W.phi, owner: OWNER, name: "adapter_model.safetensors", storageKey: "u/demo/w/8/adapter_model.safetensors", contentType: "application/octet-stream", sizeBytes: 25_165_824n, createdAt: ts(now - 4 * 24 * H + 44 * M) },
    { id: 60005n, workloadId: W.phi, owner: OWNER, name: "confusion_matrix.png", storageKey: "u/demo/w/8/confusion_matrix.png", contentType: "image/png", sizeBytes: 64_120n, createdAt: ts(now - 4 * 24 * H + 44 * M) },
    { id: 60006n, workloadId: W.sdxl, owner: OWNER, name: "brand_style_lora.safetensors", storageKey: "u/demo/w/11/brand_style_lora.safetensors", contentType: "application/octet-stream", sizeBytes: 228_589_568n, createdAt: ts(now - 3 * 24 * H + 1.2 * H) },
    { id: 60007n, workloadId: W.sdxl, owner: OWNER, name: "sample_grid.png", storageKey: "u/demo/w/11/sample_grid.png", contentType: "image/png", sizeBytes: 3_221_225n, createdAt: ts(now - 3 * 24 * H + 1.2 * H) },
    { id: 60008n, workloadId: W.train, owner: OWNER, name: "checkpoint-400/adapter_model.safetensors", storageKey: "u/demo/w/2/checkpoint-400.safetensors", contentType: "application/octet-stream", sizeBytes: 83_886_080n, createdAt: ts(now - 22 * M) },
  ];

  const projects: Rows["myProjects"][] = [
    { id: 77001n, owner: OWNER, name: "island", app: "Blender", storagePrefix: "u/demo/p/77001/", sizeBytes: 14_890_000n, lastSavedAt: ts(now - 29 * M), createdAt: ts(now - 52 * M) },
    { id: 77002n, owner: OWNER, name: "inference-server", app: "VS Code", storagePrefix: "u/demo/p/77002/", sizeBytes: 222_300_000n, lastSavedAt: ts(now - 23 * H), createdAt: ts(now - 26 * H) },
    { id: 77003n, owner: OWNER, name: "embeddings", app: "JupyterLab", storagePrefix: "u/demo/p/77003/", sizeBytes: 0n, lastSavedAt: undefined, createdAt: ts(now - 60_000) },
    { id: 77004n, owner: OWNER, name: "scratch", app: "Linux", storagePrefix: "u/demo/p/77004/", sizeBytes: 1_200_000n, lastSavedAt: ts(now - 10 * M), createdAt: ts(now - 24 * M) },
  ];

  const runs: Rows["myAgentRuns"][] = [
    { id: 88000000000001n, workloadId: W.blender, owner: OWNER, goal: "Block out a low-poly island and add two trees", status: "done", result: "Island blocked out with a sand ring and two trees; saved as ~/Projects/island.blend.", stepCount: 9, startedAt: ts(now - 36 * M), endedAt: ts(now - 30 * M) },
  ];
  const stepText = [
    ["observe", "Looked at the screen"],
    ["act", "Added a plane and subdivided it 4 times"],
    ["act", "Switched to proportional editing"],
    ["act", "Pulled the centre up into an island shape"],
    ["observe", "Looked at the screen"],
    ["act", "Added a sand-coloured ring around the shore"],
    ["act", "Added a cone and cylinder for the first tree"],
    ["act", "Duplicated the tree and moved it north"],
    ["done", "Saved ~/Projects/island.blend"],
  ];
  const steps: Rows["myAgentSteps"][] = stepText.map(([kind, summary], i) => ({
    id: BigInt(89000 + i),
    runId: runs[0].id,
    workloadId: W.blender,
    owner: OWNER,
    seq: i + 1,
    kind,
    summary,
    detail: "",
    screenshotKey: "",
    createdAt: ts(now - 36 * M + i * 40_000),
  }));

  return {
    platform: [
      { id: 0, provisioningMode: "live", globalBudgetCents: 5000, globalSpentCents: 1841, activeInstances: 3, maxConcurrentInstances: 4, integrationsJson: JSON.stringify({ spacetime: true, nemotron: true, brev: true, storage: true, photon: true }), updatedAt: ts(now) },
    ],
    myAccount: [{ identity: OWNER, displayName: "Saketh", activated: true, preference: "balanced", monthlyCapCents: 5000, approvalThresholdCents: 500, createdAt: ts(now - 9 * 24 * H) }],
    myConversations: conversations,
    myMessages: messages,
    myWorkloads: workloads,
    myEvents: events,
    myLogs: [...train.logs, ...mistral.logs, ...phi.logs, ...sdxl.logs, ...failedLogs],
    myMetrics: [...train.metrics, ...mistral.metrics, ...phi.metrics, ...sdxl.metrics],
    myAgentRuns: runs,
    myAgentSteps: steps,
    myProjects: projects,
    myArtifacts: artifacts,
    myHandles: [{ handle: "+14695550142", owner: OWNER, channel: "imessage", linkedAt: ts(now - 8 * 24 * H) }],
    myLinkCode: [],
  };
}
