/**
 * DEMO BRANCH ONLY. An in-memory stand-in for the SpacetimeDB views the app
 * subscribes to. Rows use the real row types (Timestamp, Identity) so every
 * component renders exactly as it would against the live database.
 */
import type {
  Account,
  AgentRun,
  AgentStep,
  Artifact,
  Conversation,
  LinkCode,
  LinkedHandle,
  LogChunk,
  Message,
  MetricPoint,
  Platform,
  Project,
  Workload,
  WorkloadEvent,
} from "@anywhere/stdb";
import { Identity, Timestamp } from "spacetimedb";

export type Rows = {
  platform: Platform;
  myAccount: Account;
  myConversations: Conversation;
  myMessages: Message;
  myWorkloads: Workload;
  myEvents: WorkloadEvent;
  myLogs: LogChunk;
  myMetrics: MetricPoint;
  myAgentRuns: AgentRun;
  myAgentSteps: AgentStep;
  myProjects: Project;
  myArtifacts: Artifact;
  myHandles: LinkedHandle;
  myLinkCode: LinkCode;
};
export type Table = keyof Rows;
type Db = { [K in Table]: Rows[K][] };

export const OWNER = new Identity("c0ffee" + "0".repeat(58));
export const ts = (ms: number) => new Timestamp(BigInt(Math.round(ms)) * 1000n);

let db: Db | null = null;
const listeners = new Set<() => void>();
let seq = 1_000_000n;

export const nextId = () => ++seq;

export function init(seed: () => Db) {
  if (!db) db = seed();
}

export function rows<K extends Table>(k: K): Rows[K][] {
  return (db?.[k] ?? []) as Rows[K][];
}

export function update<K extends Table>(k: K, fn: (rows: Rows[K][]) => Rows[K][]) {
  if (!db) return;
  (db as Db)[k] = fn(db[k]) as Db[K];
  listeners.forEach((l) => l());
}

export function insert<K extends Table>(k: K, row: Rows[K]) {
  update(k, (r) => [...r, row]);
}

export function patch<K extends Table>(k: K, match: (row: Rows[K]) => boolean, changes: Partial<Rows[K]>) {
  update(k, (r) => r.map((row) => (match(row) ? { ...row, ...changes } : row)));
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
