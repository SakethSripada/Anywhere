import { ScheduleAt, Timestamp } from "spacetimedb";
import { CaseConversionPolicy, schema, SenderError, t, table } from "spacetimedb/server";
import { canTransition, CONTROLLERS, shouldBumpConversation, usageUpdate, validatePreferences } from "./lifecycle";

/*
 * Anywhere's system of record.
 *
 * Every table is private. Browsers read their own rows through per-sender
 * views (`my_*`); the control plane and messaging bridge authenticate as
 * allowlisted worker identities and read through `worker_*` views. Users may
 * only call reducers that touch their own preferences or hand control of a
 * desktop back and forth; everything that spends money or mutates compute
 * state is performed by a worker after the control plane validates it.
 */

/* ── Tables ────────────────────────────────────────────────────────────── */

const worker = table(
  { name: "worker" },
  { identity: t.identity().primaryKey(), label: t.string() },
);

const account = table(
  { name: "account" },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    activated: t.bool(),
    preference: t.string(),
    monthlyCapCents: t.u32(),
    approvalThresholdCents: t.u32(),
    createdAt: t.timestamp(),
  },
);

const conversation = table(
  { name: "conversation" },
  {
    id: t.u64().primaryKey(),
    owner: t.identity().index("btree"),
    title: t.string(),
    channel: t.string(),
    archived: t.bool(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const message = table(
  { name: "message" },
  {
    id: t.u64().primaryKey().autoInc(),
    conversationId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    role: t.string(),
    kind: t.string(),
    body: t.string(),
    workloadId: t.u64(),
    channel: t.string(),
    createdAt: t.timestamp(),
  },
);

const workload = table(
  { name: "workload" },
  {
    id: t.u64().primaryKey(),
    owner: t.identity().index("btree"),
    conversationId: t.u64(),
    projectId: t.u64(),
    kind: t.string(),
    title: t.string(),
    summary: t.string(),
    status: t.string(),
    statusDetail: t.string(),
    planJson: t.string(),
    instanceType: t.string(),
    gpuName: t.string(),
    provider: t.string(),
    hourlyCents: t.u32(),
    estLowCents: t.u32(),
    estHighCents: t.u32(),
    accruedCents: t.u32(),
    stoppable: t.bool(),
    controller: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    startedAt: t.timestamp().optional(),
    lastActiveAt: t.timestamp().optional(),
  },
);

const workloadEvent = table(
  { name: "workload_event" },
  {
    id: t.u64().primaryKey().autoInc(),
    workloadId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    level: t.string(),
    message: t.string(),
    createdAt: t.timestamp(),
  },
);

const logChunk = table(
  { name: "log_chunk" },
  {
    id: t.u64().primaryKey().autoInc(),
    workloadId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    text: t.string(),
    createdAt: t.timestamp(),
  },
);

const metricPoint = table(
  { name: "metric_point" },
  {
    id: t.u64().primaryKey().autoInc(),
    workloadId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    name: t.string(),
    step: t.u32(),
    value: t.f64(),
    createdAt: t.timestamp(),
  },
);

const agentRun = table(
  { name: "agent_run" },
  {
    id: t.u64().primaryKey(),
    workloadId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    goal: t.string(),
    status: t.string(),
    result: t.string(),
    stepCount: t.u32(),
    startedAt: t.timestamp(),
    endedAt: t.timestamp().optional(),
  },
);

const agentStep = table(
  { name: "agent_step" },
  {
    id: t.u64().primaryKey().autoInc(),
    runId: t.u64().index("btree"),
    workloadId: t.u64(),
    owner: t.identity().index("btree"),
    seq: t.u32(),
    kind: t.string(),
    summary: t.string(),
    detail: t.string(),
    screenshotKey: t.string(),
    createdAt: t.timestamp(),
  },
);

const project = table(
  { name: "project" },
  {
    id: t.u64().primaryKey(),
    owner: t.identity().index("btree"),
    name: t.string(),
    app: t.string(),
    storagePrefix: t.string(),
    sizeBytes: t.u64(),
    lastSavedAt: t.timestamp().optional(),
    createdAt: t.timestamp(),
  },
);

const artifact = table(
  { name: "artifact" },
  {
    id: t.u64().primaryKey(),
    workloadId: t.u64().index("btree"),
    owner: t.identity().index("btree"),
    name: t.string(),
    storageKey: t.string(),
    contentType: t.string(),
    sizeBytes: t.u64(),
    createdAt: t.timestamp(),
  },
);

const linkedHandle = table(
  { name: "linked_handle" },
  {
    handle: t.string().primaryKey(),
    owner: t.identity().index("btree"),
    channel: t.string(),
    linkedAt: t.timestamp(),
  },
);

const linkCode = table(
  { name: "link_code" },
  {
    owner: t.identity().primaryKey(),
    code: t.string().unique(),
    handle: t.string(),
    expiresAt: t.timestamp(),
  },
);

const notification = table(
  { name: "notification" },
  {
    id: t.u64().primaryKey(),
    owner: t.identity().index("btree"),
    channel: t.string(),
    handle: t.string(),
    body: t.string(),
    status: t.string().index("btree"),
    attempts: t.u32(),
    createdAt: t.timestamp(),
    sentAt: t.timestamp().optional(),
  },
);

/** Platform-wide guardrail state, written by the control plane, readable by anyone. */
const platform = table(
  { name: "platform", public: true },
  {
    id: t.u32().primaryKey(),
    provisioningMode: t.string(),
    globalBudgetCents: t.u32(),
    globalSpentCents: t.u32(),
    activeInstances: t.u32(),
    maxConcurrentInstances: t.u32(),
    integrationsJson: t.string(),
    updatedAt: t.timestamp(),
  },
);

const maintenance = table(
  { name: "maintenance" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);

const spacetimedb = schema({
  worker,
  account,
  conversation,
  message,
  workload,
  workloadEvent,
  logChunk,
  metricPoint,
  agentRun,
  agentStep,
  project,
  artifact,
  linkedHandle,
  linkCode,
  notification,
  platform,
  maintenance,
},
  // Keep canonical (SQL) names identical to the declared ones so the control
  // plane, which reads rows over the HTTP SQL API, sees the same field names.
  { CASE_CONVERSION_POLICY: CaseConversionPolicy.None },
);
export default spacetimedb;

/* ── Guards ────────────────────────────────────────────────────────────── */

type Ctx = Parameters<Parameters<typeof spacetimedb.reducer>[1]>[0];

type WorkerLookup = {
  db: { worker: { identity: { find(identity: Ctx["sender"]): unknown } } };
  sender: Ctx["sender"];
};

function isWorker(ctx: WorkerLookup): boolean {
  return ctx.db.worker.identity.find(ctx.sender) != null;
}

function requireWorker(ctx: Ctx) {
  if (!isWorker(ctx)) throw new SenderError("This action is reserved for Anywhere services");
}

function requireText(value: string, field: string, max: number) {
  if (!value.trim()) throw new SenderError(`${field} must not be empty`);
  if (value.length > max) throw new SenderError(`${field} exceeds ${max} characters`);
}

const MINUTE_MICROS = 60_000_000n;
const DAY_MICROS = 24n * 60n * MINUTE_MICROS;

/* ── Lifecycle ─────────────────────────────────────────────────────────── */

export const init = spacetimedb.init((ctx) => {
  // The publisher is trusted as a worker so the first deploy can bootstrap others.
  ctx.db.worker.insert({ identity: ctx.sender, label: "owner" });
  ctx.db.maintenance.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(60n * MINUTE_MICROS),
  });
});

export const onConnect = spacetimedb.clientConnected((_ctx) => {});
export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {});

/** Workloads in these states do no more work, so their bulky telemetry can age out. */
const SETTLED_FOR_RETENTION = new Set(["stopped", "succeeded", "failed", "cancelled", "terminated"]);
const TELEMETRY_RETENTION_MICROS = 14n * DAY_MICROS;
const NOTIFICATION_RETENTION_MICROS = 7n * DAY_MICROS;

/**
 * Hourly: expire link codes and age out telemetry.
 *
 * Instead of scanning the high-volume tables (log_chunk, metric_point,
 * agent_step), walk the small workload table and delete through the
 * workloadId / runId indexes. Telemetry of a workload that settled more than
 * 14 days ago is removed (its events, runs and artifacts are kept); delivered
 * or failed notifications are removed after 7 days.
 */
export const runMaintenance = spacetimedb.reducer(
  { name: "run_maintenance", onSchedule: maintenance },
  { arg: maintenance.rowType },
  (ctx) => {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const code of [...ctx.db.linkCode.iter()]) {
      if (code.expiresAt.microsSinceUnixEpoch < now) ctx.db.linkCode.owner.delete(code.owner);
    }

    const telemetryCutoff = now - TELEMETRY_RETENTION_MICROS;
    for (const w of ctx.db.workload.iter()) {
      if (!SETTLED_FOR_RETENTION.has(w.status) || w.updatedAt.microsSinceUnixEpoch >= telemetryCutoff) continue;
      for (const row of [...ctx.db.logChunk.workloadId.filter(w.id)]) ctx.db.logChunk.id.delete(row.id);
      for (const row of [...ctx.db.metricPoint.workloadId.filter(w.id)]) ctx.db.metricPoint.id.delete(row.id);
      for (const run of ctx.db.agentRun.workloadId.filter(w.id)) {
        for (const step of [...ctx.db.agentStep.runId.filter(run.id)]) ctx.db.agentStep.id.delete(step.id);
      }
    }

    const notificationCutoff = now - NOTIFICATION_RETENTION_MICROS;
    for (const status of ["sent", "failed"]) {
      for (const n of [...ctx.db.notification.status.filter(status)]) {
        if (n.createdAt.microsSinceUnixEpoch < notificationCutoff) ctx.db.notification.id.delete(n.id);
      }
    }
  },
);

/* ── User reducers ─────────────────────────────────────────────────────── */

export const register = spacetimedb.reducer(
  { name: "register" },
  { displayName: t.string() },
  (ctx, { displayName }) => {
    requireText(displayName, "Name", 64);
    const existing = ctx.db.account.identity.find(ctx.sender);
    if (existing) {
      ctx.db.account.identity.update({ ...existing, displayName: displayName.trim() });
      return;
    }
    ctx.db.account.insert({
      identity: ctx.sender,
      displayName: displayName.trim(),
      activated: false,
      preference: "balanced",
      monthlyCapCents: 2000,
      approvalThresholdCents: 0,
      createdAt: ctx.timestamp,
    });
  },
);

export const updatePreferences = spacetimedb.reducer(
  { name: "update_preferences" },
  { preference: t.string(), monthlyCapCents: t.u32(), approvalThresholdCents: t.u32() },
  (ctx, args) => {
    const acct = ctx.db.account.identity.find(ctx.sender);
    if (!acct) throw new SenderError("Create an account first");
    const problem = validatePreferences(args);
    if (problem) throw new SenderError(problem);
    ctx.db.account.identity.update({ ...acct, ...args });
  },
);

/** Hand a running desktop between the agent and the human. */
export const setController = spacetimedb.reducer(
  { name: "set_controller" },
  { workloadId: t.u64(), controller: t.string() },
  (ctx, { workloadId, controller }) => {
    if (!(CONTROLLERS as readonly string[]).includes(controller)) {
      throw new SenderError("Unknown controller");
    }
    const row = ctx.db.workload.id.find(workloadId);
    if (!row) throw new SenderError("Workload not found");
    if (!row.owner.isEqual(ctx.sender) && !isWorker(ctx)) throw new SenderError("Not your workload");
    if (row.kind !== "desktop") throw new SenderError("Only desktops can change hands");
    ctx.db.workload.id.update({ ...row, controller, updatedAt: ctx.timestamp, lastActiveAt: ctx.timestamp });
  },
);

export const renameConversation = spacetimedb.reducer(
  { name: "rename_conversation" },
  { id: t.u64(), title: t.string() },
  (ctx, { id, title }) => {
    requireText(title, "Title", 120);
    const row = ctx.db.conversation.id.find(id);
    if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError("Conversation not found");
    ctx.db.conversation.id.update({ ...row, title: title.trim(), updatedAt: ctx.timestamp });
  },
);

export const archiveConversation = spacetimedb.reducer(
  { name: "archive_conversation" },
  { id: t.u64() },
  (ctx, { id }) => {
    const row = ctx.db.conversation.id.find(id);
    if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError("Conversation not found");
    ctx.db.conversation.id.update({ ...row, archived: true, updatedAt: ctx.timestamp });
  },
);

export const unlinkHandle = spacetimedb.reducer(
  { name: "unlink_handle" },
  { handle: t.string() },
  (ctx, { handle }) => {
    const row = ctx.db.linkedHandle.handle.find(handle);
    if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError("Handle not linked");
    ctx.db.linkedHandle.handle.delete(handle);
  },
);

/* ── Worker reducers ───────────────────────────────────────────────────── */

export const activateAccount = spacetimedb.reducer(
  { name: "activate_account" },
  { identity: t.identity(), activated: t.bool() },
  (ctx, { identity, activated }) => {
    requireWorker(ctx);
    const acct = ctx.db.account.identity.find(identity);
    if (!acct) throw new SenderError("Account not found");
    ctx.db.account.identity.update({ ...acct, activated });
  },
);

export const upsertConversation = spacetimedb.reducer(
  { name: "upsert_conversation" },
  { id: t.u64(), owner: t.identity(), title: t.string(), channel: t.string() },
  (ctx, { id, owner, title, channel }) => {
    requireWorker(ctx);
    const existing = ctx.db.conversation.id.find(id);
    if (existing) {
      if (!existing.owner.isEqual(owner)) throw new SenderError("Conversation owner mismatch");
      if (existing.title !== title) ctx.db.conversation.id.update({ ...existing, title, updatedAt: ctx.timestamp });
      return;
    }
    ctx.db.conversation.insert({
      id,
      owner,
      title,
      channel,
      archived: false,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  },
);

export const appendMessage = spacetimedb.reducer(
  { name: "append_message" },
  {
    conversationId: t.u64(),
    role: t.string(),
    kind: t.string(),
    body: t.string(),
    workloadId: t.u64(),
    channel: t.string(),
  },
  (ctx, args) => {
    requireWorker(ctx);
    const convo = ctx.db.conversation.id.find(args.conversationId);
    if (!convo) throw new SenderError("Conversation not found");
    ctx.db.message.insert({ id: 0n, owner: convo.owner, createdAt: ctx.timestamp, ...args });
    if (shouldBumpConversation(convo.updatedAt.microsSinceUnixEpoch, ctx.timestamp.microsSinceUnixEpoch)) {
      ctx.db.conversation.id.update({ ...convo, updatedAt: ctx.timestamp });
    }
  },
);

export const createWorkload = spacetimedb.reducer(
  { name: "create_workload" },
  {
    id: t.u64(),
    owner: t.identity(),
    conversationId: t.u64(),
    projectId: t.u64(),
    kind: t.string(),
    title: t.string(),
    summary: t.string(),
    planJson: t.string(),
    instanceType: t.string(),
    gpuName: t.string(),
    provider: t.string(),
    hourlyCents: t.u32(),
    estLowCents: t.u32(),
    estHighCents: t.u32(),
    stoppable: t.bool(),
  },
  (ctx, args) => {
    requireWorker(ctx);
    if (args.kind !== "desktop" && args.kind !== "batch") throw new SenderError("Unknown workload kind");
    if (ctx.db.workload.id.find(args.id)) throw new SenderError("Workload already exists");
    ctx.db.workload.insert({
      ...args,
      status: "planned",
      statusDetail: "Waiting for approval",
      accruedCents: 0,
      controller: "agent",
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      startedAt: undefined,
      lastActiveAt: undefined,
    });
  },
);

/** Re-label a workload's plan: a split render's first part takes its own frame range and share of the cost. */
export const updateWorkloadPlan = spacetimedb.reducer(
  { name: "update_workload_plan" },
  { id: t.u64(), title: t.string(), planJson: t.string(), estLowCents: t.u32(), estHighCents: t.u32() },
  (ctx, { id, title, planJson, estLowCents, estHighCents }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(id);
    if (!row) throw new SenderError("Workload not found");
    ctx.db.workload.id.update({ ...row, title, planJson, estLowCents, estHighCents, updatedAt: ctx.timestamp });
  },
);

export const transitionWorkload = spacetimedb.reducer(
  { name: "transition_workload" },
  { id: t.u64(), to: t.string(), detail: t.string() },
  (ctx, { id, to, detail }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(id);
    if (!row) throw new SenderError("Workload not found");
    if (row.status === to) {
      if (row.statusDetail !== detail) {
        ctx.db.workload.id.update({ ...row, statusDetail: detail, updatedAt: ctx.timestamp });
      }
      return;
    }
    if (!canTransition(row.status, to)) {
      throw new SenderError(`Illegal transition ${row.status} → ${to}`);
    }
    const startsBilling = to === "provisioning";
    ctx.db.workload.id.update({
      ...row,
      status: to,
      statusDetail: detail,
      updatedAt: ctx.timestamp,
      startedAt: startsBilling ? ctx.timestamp : row.startedAt,
      lastActiveAt: ctx.timestamp,
    });
  },
);

export const recordUsage = spacetimedb.reducer(
  { name: "record_usage" },
  { id: t.u64(), accruedCents: t.u32(), touch: t.bool() },
  (ctx, { id, accruedCents, touch }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(id);
    if (!row) throw new SenderError("Workload not found");
    // Spend is monotonic; a stale writer can never reduce what was billed. Calls
    // that change nothing are skipped so subscribers don't get no-op updates.
    const change = usageUpdate(
      { accruedCents: row.accruedCents, lastActiveAtMicros: row.lastActiveAt?.microsSinceUnixEpoch },
      accruedCents,
      touch,
      ctx.timestamp.microsSinceUnixEpoch,
    );
    if (!change) return;
    ctx.db.workload.id.update({
      ...row,
      accruedCents: change.accruedCents,
      lastActiveAt: change.touch ? ctx.timestamp : row.lastActiveAt,
    });
  },
);

export const addEvent = spacetimedb.reducer(
  { name: "add_event" },
  { workloadId: t.u64(), level: t.string(), message: t.string() },
  (ctx, { workloadId, level, message }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(workloadId);
    if (!row) throw new SenderError("Workload not found");
    ctx.db.workloadEvent.insert({ id: 0n, workloadId, owner: row.owner, level, message, createdAt: ctx.timestamp });
  },
);

export const appendLogs = spacetimedb.reducer(
  { name: "append_logs" },
  { workloadId: t.u64(), text: t.string() },
  (ctx, { workloadId, text }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(workloadId);
    if (!row) throw new SenderError("Workload not found");
    ctx.db.logChunk.insert({ id: 0n, workloadId, owner: row.owner, text: text.slice(0, 16_000), createdAt: ctx.timestamp });
  },
);

const MetricInput = t.object("MetricInput", { name: t.string(), step: t.u32(), value: t.f64() });

export const addMetrics = spacetimedb.reducer(
  { name: "add_metrics" },
  { workloadId: t.u64(), points: t.array(MetricInput) },
  (ctx, { workloadId, points }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(workloadId);
    if (!row) throw new SenderError("Workload not found");
    for (const p of points) {
      ctx.db.metricPoint.insert({ id: 0n, workloadId, owner: row.owner, createdAt: ctx.timestamp, ...p });
    }
  },
);

export const startAgentRun = spacetimedb.reducer(
  { name: "start_agent_run" },
  { id: t.u64(), workloadId: t.u64(), goal: t.string() },
  (ctx, { id, workloadId, goal }) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(workloadId);
    if (!row) throw new SenderError("Workload not found");
    ctx.db.agentRun.insert({
      id,
      workloadId,
      owner: row.owner,
      goal,
      status: "running",
      result: "",
      stepCount: 0,
      startedAt: ctx.timestamp,
      endedAt: undefined,
    });
  },
);

export const addAgentStep = spacetimedb.reducer(
  { name: "add_agent_step" },
  { runId: t.u64(), kind: t.string(), summary: t.string(), detail: t.string(), screenshotKey: t.string() },
  (ctx, { runId, kind, summary, detail, screenshotKey }) => {
    requireWorker(ctx);
    const run = ctx.db.agentRun.id.find(runId);
    if (!run) throw new SenderError("Agent run not found");
    const seq = run.stepCount + 1;
    ctx.db.agentStep.insert({
      id: 0n,
      runId,
      workloadId: run.workloadId,
      owner: run.owner,
      seq,
      kind,
      summary,
      detail: detail.slice(0, 4000),
      screenshotKey,
      createdAt: ctx.timestamp,
    });
    ctx.db.agentRun.id.update({ ...run, stepCount: seq });
  },
);

export const finishAgentRun = spacetimedb.reducer(
  { name: "finish_agent_run" },
  { id: t.u64(), status: t.string(), result: t.string() },
  (ctx, { id, status, result }) => {
    requireWorker(ctx);
    const run = ctx.db.agentRun.id.find(id);
    if (!run) throw new SenderError("Agent run not found");
    ctx.db.agentRun.id.update({ ...run, status, result, endedAt: status === "paused" ? undefined : ctx.timestamp });
  },
);

export const upsertProject = spacetimedb.reducer(
  { name: "upsert_project" },
  {
    id: t.u64(),
    owner: t.identity(),
    name: t.string(),
    app: t.string(),
    storagePrefix: t.string(),
    sizeBytes: t.u64(),
    saved: t.bool(),
  },
  (ctx, { saved, ...args }) => {
    requireWorker(ctx);
    const existing = ctx.db.project.id.find(args.id);
    const lastSavedAt = saved ? ctx.timestamp : existing?.lastSavedAt;
    if (existing) {
      ctx.db.project.id.update({ ...existing, ...args, lastSavedAt });
    } else {
      ctx.db.project.insert({ ...args, lastSavedAt, createdAt: ctx.timestamp });
    }
  },
);

export const addArtifact = spacetimedb.reducer(
  { name: "add_artifact" },
  {
    id: t.u64(),
    workloadId: t.u64(),
    name: t.string(),
    storageKey: t.string(),
    contentType: t.string(),
    sizeBytes: t.u64(),
  },
  (ctx, args) => {
    requireWorker(ctx);
    const row = ctx.db.workload.id.find(args.workloadId);
    if (!row) throw new SenderError("Workload not found");
    ctx.db.artifact.insert({ ...args, owner: row.owner, createdAt: ctx.timestamp });
  },
);

/** Issue a short-lived code the user texts to Anywhere to prove they own a handle. */
export const issueLinkCode = spacetimedb.reducer(
  { name: "issue_link_code" },
  { owner: t.identity(), handle: t.string() },
  (ctx, { owner, handle }) => {
    requireWorker(ctx);
    const code = String(100000 + Math.floor(ctx.random() * 900000));
    const expiresAt = ctx.timestamp.microsSinceUnixEpoch + 15n * MINUTE_MICROS;
    const existing = ctx.db.linkCode.owner.find(owner);
    if (existing) ctx.db.linkCode.owner.delete(owner);
    ctx.db.linkCode.insert({ owner, code, handle, expiresAt: new Timestamp(expiresAt) });
  },
);

export const linkHandle = spacetimedb.reducer(
  { name: "link_handle" },
  { handle: t.string(), code: t.string(), channel: t.string() },
  (ctx, { handle, code, channel }) => {
    requireWorker(ctx);
    const pending = ctx.db.linkCode.code.find(code);
    if (!pending) throw new SenderError("Unknown or expired code");
    if (pending.expiresAt.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
      ctx.db.linkCode.owner.delete(pending.owner);
      throw new SenderError("Code expired");
    }
    if (pending.handle && pending.handle !== handle) throw new SenderError("Code was issued for a different number");
    const existing = ctx.db.linkedHandle.handle.find(handle);
    if (existing) ctx.db.linkedHandle.handle.delete(handle);
    ctx.db.linkedHandle.insert({ handle, owner: pending.owner, channel, linkedAt: ctx.timestamp });
    ctx.db.linkCode.owner.delete(pending.owner);
  },
);

export const enqueueNotification = spacetimedb.reducer(
  { name: "enqueue_notification" },
  { id: t.u64(), owner: t.identity(), channel: t.string(), handle: t.string(), body: t.string() },
  (ctx, args) => {
    requireWorker(ctx);
    ctx.db.notification.insert({ ...args, status: "pending", attempts: 0, createdAt: ctx.timestamp, sentAt: undefined });
  },
);

export const markNotification = spacetimedb.reducer(
  { name: "mark_notification" },
  { id: t.u64(), status: t.string() },
  (ctx, { id, status }) => {
    requireWorker(ctx);
    const row = ctx.db.notification.id.find(id);
    if (!row) throw new SenderError("Notification not found");
    ctx.db.notification.id.update({
      ...row,
      status,
      attempts: row.attempts + 1,
      sentAt: status === "sent" ? ctx.timestamp : row.sentAt,
    });
  },
);

export const updatePlatform = spacetimedb.reducer(
  { name: "update_platform" },
  {
    provisioningMode: t.string(),
    globalBudgetCents: t.u32(),
    globalSpentCents: t.u32(),
    activeInstances: t.u32(),
    maxConcurrentInstances: t.u32(),
    integrationsJson: t.string(),
  },
  (ctx, args) => {
    requireWorker(ctx);
    const row = { id: 0, ...args, updatedAt: ctx.timestamp };
    const existing = ctx.db.platform.id.find(0);
    if (!existing) {
      ctx.db.platform.insert(row);
      return;
    }
    // The platform row is public: skip writes that change nothing.
    const same = (Object.keys(args) as (keyof typeof args)[]).every((k) => existing[k] === args[k]);
    if (!same) ctx.db.platform.id.update(row);
  },
);

/* ── Per-user views ────────────────────────────────────────────────────── */

export const myAccount = spacetimedb.view(
  { name: "my_account", public: true },
  account.rowType.optional(),
  (ctx) => ctx.db.account.identity.find(ctx.sender) ?? undefined,
);

export const myConversations = spacetimedb.view(
  { name: "my_conversations", public: true },
  t.array(conversation.rowType),
  (ctx) => [...ctx.db.conversation.owner.filter(ctx.sender)].filter((c) => !c.archived),
);

export const myMessages = spacetimedb.view(
  { name: "my_messages", public: true },
  t.array(message.rowType),
  (ctx) => [...ctx.db.message.owner.filter(ctx.sender)],
);

export const myWorkloads = spacetimedb.view(
  { name: "my_workloads", public: true },
  t.array(workload.rowType),
  (ctx) => [...ctx.db.workload.owner.filter(ctx.sender)],
);

export const myEvents = spacetimedb.view(
  { name: "my_events", public: true },
  t.array(workloadEvent.rowType),
  (ctx) => [...ctx.db.workloadEvent.owner.filter(ctx.sender)],
);

/** The log tail shows the last few thousand lines; older chunks only cost bandwidth. */
const LOG_VIEW_CHUNKS_PER_WORKLOAD = 300;

export const myLogs = spacetimedb.view(
  { name: "my_logs", public: true },
  t.array(logChunk.rowType),
  (ctx) => {
    // Newest chunks per workload only: a long training job appends a chunk every
    // 10 s, and without a cap every browser downloaded the whole history.
    const rows = [...ctx.db.logChunk.owner.filter(ctx.sender)].sort((a, b) => (a.id > b.id ? -1 : 1));
    const kept = new Map<bigint, number>();
    return rows
      .filter((r) => {
        const n = kept.get(r.workloadId) ?? 0;
        kept.set(r.workloadId, n + 1);
        return n < LOG_VIEW_CHUNKS_PER_WORKLOAD;
      })
      .reverse();
  },
);

export const myMetrics = spacetimedb.view(
  { name: "my_metrics", public: true },
  t.array(metricPoint.rowType),
  (ctx) => [...ctx.db.metricPoint.owner.filter(ctx.sender)],
);

export const myAgentRuns = spacetimedb.view(
  { name: "my_agent_runs", public: true },
  t.array(agentRun.rowType),
  (ctx) => [...ctx.db.agentRun.owner.filter(ctx.sender)],
);

export const myAgentSteps = spacetimedb.view(
  { name: "my_agent_steps", public: true },
  t.array(agentStep.rowType),
  (ctx) => [...ctx.db.agentStep.owner.filter(ctx.sender)],
);

export const myProjects = spacetimedb.view(
  { name: "my_projects", public: true },
  t.array(project.rowType),
  (ctx) => [...ctx.db.project.owner.filter(ctx.sender)],
);

export const myArtifacts = spacetimedb.view(
  { name: "my_artifacts", public: true },
  t.array(artifact.rowType),
  (ctx) => [...ctx.db.artifact.owner.filter(ctx.sender)],
);

export const myHandles = spacetimedb.view(
  { name: "my_handles", public: true },
  t.array(linkedHandle.rowType),
  (ctx) => [...ctx.db.linkedHandle.owner.filter(ctx.sender)],
);

export const myLinkCode = spacetimedb.view(
  { name: "my_link_code", public: true },
  linkCode.rowType.optional(),
  (ctx) => ctx.db.linkCode.owner.find(ctx.sender) ?? undefined,
);

/* ── Worker views ──────────────────────────────────────────────────────── */

export const workerWorkloads = spacetimedb.view(
  { name: "worker_workloads", public: true },
  t.array(workload.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.workload.iter()] : []),
);

export const workerConversations = spacetimedb.view(
  { name: "worker_conversations", public: true },
  t.array(conversation.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.conversation.iter()] : []),
);

export const workerAccounts = spacetimedb.view(
  { name: "worker_accounts", public: true },
  t.array(account.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.account.iter()] : []),
);

export const workerHandles = spacetimedb.view(
  { name: "worker_handles", public: true },
  t.array(linkedHandle.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.linkedHandle.iter()] : []),
);

export const workerOutbox = spacetimedb.view(
  { name: "worker_outbox", public: true },
  t.array(notification.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.notification.status.filter("pending")] : []),
);

/* Read-side for the agent's `inspect_workload` tool. */

export const workerEvents = spacetimedb.view(
  { name: "worker_events", public: true },
  t.array(workloadEvent.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.workloadEvent.iter()] : []),
);

export const workerLogs = spacetimedb.view(
  { name: "worker_logs", public: true },
  t.array(logChunk.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.logChunk.iter()] : []),
);

export const workerMetrics = spacetimedb.view(
  { name: "worker_metrics", public: true },
  t.array(metricPoint.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.metricPoint.iter()] : []),
);

export const workerArtifacts = spacetimedb.view(
  { name: "worker_artifacts", public: true },
  t.array(artifact.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.artifact.iter()] : []),
);

export const workerAgentRuns = spacetimedb.view(
  { name: "worker_agent_runs", public: true },
  t.array(agentRun.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.agentRun.iter()] : []),
);

export const workerAgentSteps = spacetimedb.view(
  { name: "worker_agent_steps", public: true },
  t.array(agentStep.rowType),
  (ctx) => (isWorker(ctx) ? [...ctx.db.agentStep.iter()] : []),
);
