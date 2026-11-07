// Client bindings for the `anywhere` SpacetimeDB module.
//
// Hand-written in the same shape `spacetime generate --lang typescript` emits,
// so `pnpm --filter @anywhere/spacetime-module generate` can overwrite this
// directory without changing any import site. Keep the column order of every
// row identical to spacetime/module/src/index.ts: rows are decoded positionally.
//
// Exposed: the public `platform` table, every `my_*` / `worker_*` view, and all
// callable reducers. Private tables and the scheduled `run_maintenance` reducer
// are intentionally absent.

/* eslint-disable */
import {
  DbConnectionBuilder as __DbConnectionBuilder,
  DbConnectionImpl as __DbConnectionImpl,
  SubscriptionBuilderImpl as __SubscriptionBuilderImpl,
  convertToAccessorMap as __convertToAccessorMap,
  makeQueryBuilder as __makeQueryBuilder,
  procedures as __procedures,
  reducerSchema as __reducerSchema,
  reducers as __reducers,
  schema as __schema,
  t as __t,
  table as __table,
  type DbConnectionConfig as __DbConnectionConfig,
  type ErrorContextInterface as __ErrorContextInterface,
  type EventContextInterface as __EventContextInterface,
  type Infer as __Infer,
  type QueryBuilder as __QueryBuilder,
  type ReducerEventContextInterface as __ReducerEventContextInterface,
  type RemoteModule as __RemoteModule,
  type SubscriptionEventContextInterface as __SubscriptionEventContextInterface,
  type SubscriptionHandleImpl as __SubscriptionHandleImpl,
} from "spacetimedb";

/* ── Row types ─────────────────────────────────────────────────────────── */

export const AccountRow = __t.row({
  identity: __t.identity(),
  displayName: __t.string(),
  activated: __t.bool(),
  preference: __t.string(),
  monthlyCapCents: __t.u32(),
  approvalThresholdCents: __t.u32(),
  createdAt: __t.timestamp(),
});

export const ConversationRow = __t.row({
  id: __t.u64(),
  owner: __t.identity(),
  title: __t.string(),
  channel: __t.string(),
  archived: __t.bool(),
  createdAt: __t.timestamp(),
  updatedAt: __t.timestamp(),
});

export const MessageRow = __t.row({
  id: __t.u64(),
  conversationId: __t.u64(),
  owner: __t.identity(),
  role: __t.string(),
  kind: __t.string(),
  body: __t.string(),
  workloadId: __t.u64(),
  channel: __t.string(),
  createdAt: __t.timestamp(),
});

export const WorkloadRow = __t.row({
  id: __t.u64(),
  owner: __t.identity(),
  conversationId: __t.u64(),
  projectId: __t.u64(),
  kind: __t.string(),
  title: __t.string(),
  summary: __t.string(),
  status: __t.string(),
  statusDetail: __t.string(),
  planJson: __t.string(),
  instanceType: __t.string(),
  gpuName: __t.string(),
  provider: __t.string(),
  hourlyCents: __t.u32(),
  estLowCents: __t.u32(),
  estHighCents: __t.u32(),
  accruedCents: __t.u32(),
  stoppable: __t.bool(),
  controller: __t.string(),
  createdAt: __t.timestamp(),
  updatedAt: __t.timestamp(),
  startedAt: __t.option(__t.timestamp()),
  lastActiveAt: __t.option(__t.timestamp()),
});

export const WorkloadEventRow = __t.row({
  id: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  level: __t.string(),
  message: __t.string(),
  createdAt: __t.timestamp(),
});

export const LogChunkRow = __t.row({
  id: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  text: __t.string(),
  createdAt: __t.timestamp(),
});

export const MetricPointRow = __t.row({
  id: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  name: __t.string(),
  step: __t.u32(),
  value: __t.f64(),
  createdAt: __t.timestamp(),
});

export const AgentRunRow = __t.row({
  id: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  goal: __t.string(),
  status: __t.string(),
  result: __t.string(),
  stepCount: __t.u32(),
  startedAt: __t.timestamp(),
  endedAt: __t.option(__t.timestamp()),
});

export const AgentStepRow = __t.row({
  id: __t.u64(),
  runId: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  seq: __t.u32(),
  kind: __t.string(),
  summary: __t.string(),
  detail: __t.string(),
  screenshotKey: __t.string(),
  createdAt: __t.timestamp(),
});

export const ProjectRow = __t.row({
  id: __t.u64(),
  owner: __t.identity(),
  name: __t.string(),
  app: __t.string(),
  storagePrefix: __t.string(),
  sizeBytes: __t.u64(),
  lastSavedAt: __t.option(__t.timestamp()),
  createdAt: __t.timestamp(),
});

export const ArtifactRow = __t.row({
  id: __t.u64(),
  workloadId: __t.u64(),
  owner: __t.identity(),
  name: __t.string(),
  storageKey: __t.string(),
  contentType: __t.string(),
  sizeBytes: __t.u64(),
  createdAt: __t.timestamp(),
});

export const LinkedHandleRow = __t.row({
  handle: __t.string(),
  owner: __t.identity(),
  channel: __t.string(),
  linkedAt: __t.timestamp(),
});

export const LinkCodeRow = __t.row({
  owner: __t.identity(),
  code: __t.string(),
  handle: __t.string(),
  expiresAt: __t.timestamp(),
});

export const NotificationRow = __t.row({
  id: __t.u64(),
  owner: __t.identity(),
  channel: __t.string(),
  handle: __t.string(),
  body: __t.string(),
  status: __t.string(),
  attempts: __t.u32(),
  createdAt: __t.timestamp(),
  sentAt: __t.option(__t.timestamp()),
});

export const PlatformRow = __t.row({
  id: __t.u32().primaryKey(),
  provisioningMode: __t.string(),
  globalBudgetCents: __t.u32(),
  globalSpentCents: __t.u32(),
  activeInstances: __t.u32(),
  maxConcurrentInstances: __t.u32(),
  integrationsJson: __t.string(),
  updatedAt: __t.timestamp(),
});

export const MetricInput = __t.object("MetricInput", {
  name: __t.string(),
  step: __t.u32(),
  value: __t.f64(),
});

export type Account = __Infer<typeof AccountRow>;
export type Conversation = __Infer<typeof ConversationRow>;
export type Message = __Infer<typeof MessageRow>;
export type Workload = __Infer<typeof WorkloadRow>;
export type WorkloadEvent = __Infer<typeof WorkloadEventRow>;
export type LogChunk = __Infer<typeof LogChunkRow>;
export type MetricPoint = __Infer<typeof MetricPointRow>;
export type AgentRun = __Infer<typeof AgentRunRow>;
export type AgentStep = __Infer<typeof AgentStepRow>;
export type Project = __Infer<typeof ProjectRow>;
export type Artifact = __Infer<typeof ArtifactRow>;
export type LinkedHandle = __Infer<typeof LinkedHandleRow>;
export type LinkCode = __Infer<typeof LinkCodeRow>;
export type Notification = __Infer<typeof NotificationRow>;
export type Platform = __Infer<typeof PlatformRow>;

/* ── Tables & views ────────────────────────────────────────────────────── */

const tablesSchema = __schema({
  platform: __table({ name: "platform", indexes: [], constraints: [] }, PlatformRow),

  myAccount: __table({ name: "my_account", indexes: [], constraints: [] }, AccountRow),
  myConversations: __table({ name: "my_conversations", indexes: [], constraints: [] }, ConversationRow),
  myMessages: __table({ name: "my_messages", indexes: [], constraints: [] }, MessageRow),
  myWorkloads: __table({ name: "my_workloads", indexes: [], constraints: [] }, WorkloadRow),
  myEvents: __table({ name: "my_events", indexes: [], constraints: [] }, WorkloadEventRow),
  myLogs: __table({ name: "my_logs", indexes: [], constraints: [] }, LogChunkRow),
  myMetrics: __table({ name: "my_metrics", indexes: [], constraints: [] }, MetricPointRow),
  myAgentRuns: __table({ name: "my_agent_runs", indexes: [], constraints: [] }, AgentRunRow),
  myAgentSteps: __table({ name: "my_agent_steps", indexes: [], constraints: [] }, AgentStepRow),
  myProjects: __table({ name: "my_projects", indexes: [], constraints: [] }, ProjectRow),
  myArtifacts: __table({ name: "my_artifacts", indexes: [], constraints: [] }, ArtifactRow),
  myHandles: __table({ name: "my_handles", indexes: [], constraints: [] }, LinkedHandleRow),
  myLinkCode: __table({ name: "my_link_code", indexes: [], constraints: [] }, LinkCodeRow),

  workerWorkloads: __table({ name: "worker_workloads", indexes: [], constraints: [] }, WorkloadRow),
  workerAccounts: __table({ name: "worker_accounts", indexes: [], constraints: [] }, AccountRow),
  workerHandles: __table({ name: "worker_handles", indexes: [], constraints: [] }, LinkedHandleRow),
  workerOutbox: __table({ name: "worker_outbox", indexes: [], constraints: [] }, NotificationRow),
});

/* ── Reducers ──────────────────────────────────────────────────────────── */

const reducersSchema = __reducers(
  // User-callable
  __reducerSchema("register", { displayName: __t.string() }),
  __reducerSchema("update_preferences", {
    preference: __t.string(),
    monthlyCapCents: __t.u32(),
    approvalThresholdCents: __t.u32(),
  }),
  __reducerSchema("set_controller", { workloadId: __t.u64(), controller: __t.string() }),
  __reducerSchema("rename_conversation", { id: __t.u64(), title: __t.string() }),
  __reducerSchema("archive_conversation", { id: __t.u64() }),
  __reducerSchema("unlink_handle", { handle: __t.string() }),

  // Worker-only (rejected for ordinary identities)
  __reducerSchema("activate_account", { identity: __t.identity(), activated: __t.bool() }),
  __reducerSchema("upsert_conversation", {
    id: __t.u64(),
    owner: __t.identity(),
    title: __t.string(),
    channel: __t.string(),
  }),
  __reducerSchema("append_message", {
    conversationId: __t.u64(),
    role: __t.string(),
    kind: __t.string(),
    body: __t.string(),
    workloadId: __t.u64(),
    channel: __t.string(),
  }),
  __reducerSchema("create_workload", {
    id: __t.u64(),
    owner: __t.identity(),
    conversationId: __t.u64(),
    projectId: __t.u64(),
    kind: __t.string(),
    title: __t.string(),
    summary: __t.string(),
    planJson: __t.string(),
    instanceType: __t.string(),
    gpuName: __t.string(),
    provider: __t.string(),
    hourlyCents: __t.u32(),
    estLowCents: __t.u32(),
    estHighCents: __t.u32(),
    stoppable: __t.bool(),
  }),
  __reducerSchema("transition_workload", { id: __t.u64(), to: __t.string(), detail: __t.string() }),
  __reducerSchema("record_usage", { id: __t.u64(), accruedCents: __t.u32(), touch: __t.bool() }),
  __reducerSchema("add_event", { workloadId: __t.u64(), level: __t.string(), message: __t.string() }),
  __reducerSchema("append_logs", { workloadId: __t.u64(), text: __t.string() }),
  __reducerSchema("add_metrics", { workloadId: __t.u64(), points: __t.array(MetricInput) }),
  __reducerSchema("start_agent_run", { id: __t.u64(), workloadId: __t.u64(), goal: __t.string() }),
  __reducerSchema("add_agent_step", {
    runId: __t.u64(),
    kind: __t.string(),
    summary: __t.string(),
    detail: __t.string(),
    screenshotKey: __t.string(),
  }),
  __reducerSchema("finish_agent_run", { id: __t.u64(), status: __t.string(), result: __t.string() }),
  __reducerSchema("upsert_project", {
    id: __t.u64(),
    owner: __t.identity(),
    name: __t.string(),
    app: __t.string(),
    storagePrefix: __t.string(),
    sizeBytes: __t.u64(),
    saved: __t.bool(),
  }),
  __reducerSchema("add_artifact", {
    id: __t.u64(),
    workloadId: __t.u64(),
    name: __t.string(),
    storageKey: __t.string(),
    contentType: __t.string(),
    sizeBytes: __t.u64(),
  }),
  __reducerSchema("issue_link_code", { owner: __t.identity(), handle: __t.string() }),
  __reducerSchema("link_handle", { handle: __t.string(), code: __t.string(), channel: __t.string() }),
  __reducerSchema("enqueue_notification", {
    id: __t.u64(),
    owner: __t.identity(),
    channel: __t.string(),
    handle: __t.string(),
    body: __t.string(),
  }),
  __reducerSchema("mark_notification", { id: __t.u64(), status: __t.string() }),
  __reducerSchema("update_platform", {
    provisioningMode: __t.string(),
    globalBudgetCents: __t.u32(),
    globalSpentCents: __t.u32(),
    activeInstances: __t.u32(),
    maxConcurrentInstances: __t.u32(),
    integrationsJson: __t.string(),
  }),
);

const proceduresSchema = __procedures();

/* ── Remote module ─────────────────────────────────────────────────────── */

const REMOTE_MODULE = {
  versionInfo: { cliVersion: "2.14.1" as const },
  tables: tablesSchema.schemaType.tables,
  reducers: reducersSchema.reducersType.reducers,
  ...proceduresSchema,
} satisfies __RemoteModule<
  typeof tablesSchema.schemaType,
  typeof reducersSchema.reducersType,
  typeof proceduresSchema
>;

/** Every table and view, each doubling as a query builder for `useTable`. */
export const tables: __QueryBuilder<typeof tablesSchema.schemaType> = __makeQueryBuilder(tablesSchema.schemaType);

/** Reducer definitions keyed by camelCase accessor, for `useReducer`. */
export const reducers = __convertToAccessorMap(reducersSchema.reducersType.reducers);

export type EventContext = __EventContextInterface<typeof REMOTE_MODULE>;
export type ReducerEventContext = __ReducerEventContextInterface<typeof REMOTE_MODULE>;
export type SubscriptionEventContext = __SubscriptionEventContextInterface<typeof REMOTE_MODULE>;
export type ErrorContext = __ErrorContextInterface<typeof REMOTE_MODULE>;
export type SubscriptionHandle = __SubscriptionHandleImpl<typeof REMOTE_MODULE>;

export class SubscriptionBuilder extends __SubscriptionBuilderImpl<typeof REMOTE_MODULE> {}

export class DbConnectionBuilder extends __DbConnectionBuilder<DbConnection> {}

export class DbConnection extends __DbConnectionImpl<typeof REMOTE_MODULE> {
  static builder = (): DbConnectionBuilder =>
    new DbConnectionBuilder(
      REMOTE_MODULE,
      (config: __DbConnectionConfig<typeof REMOTE_MODULE>) => new DbConnection(config),
    );

  override subscriptionBuilder = (): SubscriptionBuilder => new SubscriptionBuilder(this);
}
