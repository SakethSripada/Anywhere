"use client";

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
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Context, type ReactNode } from "react";
import { tables, useTable } from "./stdb";
import { byRecent } from "./workloads";

/*
 * One subscription per table for the whole app. Every `useTable` call opens
 * its own server subscription and listeners and copies the whole table on
 * each change, so per-row hooks (a tool call, a run trace, a machine card)
 * multiplied that work by the number of rows on screen. Here each table is
 * subscribed once, only while at least one mounted component reads it, and
 * shared through its own context (a change to one table re-renders only that
 * table's readers) together with indexes the readers need, built once per
 * change instead of once per reader.
 */

type Slice<T> = { rows: readonly T[]; ready: boolean };
type ByWorkload<T> = Slice<T> & { byWorkload: ReadonlyMap<bigint, readonly T[]> };

export type Slices = {
  myAccount: Slice<Account>;
  platform: Slice<Platform>;
  /** `active`: not terminated, most recent first. */
  myWorkloads: Slice<Workload> & { byId: ReadonlyMap<bigint, Workload>; active: readonly Workload[] };
  myConversations: Slice<Conversation>;
  myMessages: Slice<Message> & { byConversation: ReadonlyMap<bigint, readonly Message[]> };
  myProjects: Slice<Project>;
  /** `byWorkload`: newest first. */
  myAgentRuns: ByWorkload<AgentRun> & { byId: ReadonlyMap<bigint, AgentRun> };
  /** `byRun`: by seq; `byWorkload`: by id. */
  myAgentSteps: ByWorkload<AgentStep> & { byRun: ReadonlyMap<bigint, readonly AgentStep[]> };
  myEvents: ByWorkload<WorkloadEvent>;
  myMetrics: ByWorkload<MetricPoint>;
  myLogs: ByWorkload<LogChunk>;
  myArtifacts: ByWorkload<Artifact>;
  myHandles: Slice<LinkedHandle>;
  myLinkCode: Slice<LinkCode>;
};
export type TableName = keyof Slices;

const NAMES = [
  "myAccount",
  "platform",
  "myWorkloads",
  "myConversations",
  "myMessages",
  "myProjects",
  "myAgentRuns",
  "myAgentSteps",
  "myEvents",
  "myMetrics",
  "myLogs",
  "myArtifacts",
  "myHandles",
  "myLinkCode",
] as const satisfies readonly TableName[];

const EMPTY_MAP: ReadonlyMap<bigint, never> = new Map<bigint, never>();
const EMPTY = { rows: [], ready: false, active: [], byId: EMPTY_MAP, byWorkload: EMPTY_MAP, byRun: EMPTY_MAP, byConversation: EMPTY_MAP };
/** A shared empty list, so "no rows for this key" keeps a stable identity. */
export const NONE: readonly never[] = [];

const contexts = Object.fromEntries(NAMES.map((n) => [n, createContext<Slices[TableName]>(EMPTY)])) as unknown as {
  [K in TableName]: Context<Slices[K]>;
};
const Registry = createContext<((name: TableName) => () => void) | null>(null);

function group<T, K>(rows: readonly T[], key: (r: T) => K, sort?: (a: T, b: T) => number): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  if (sort) for (const list of out.values()) list.sort(sort);
  return out;
}

const byId = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const wid = (r: { workloadId: bigint }) => r.workloadId;

/** `useTable` gated on demand; `ready` stays false while nobody reads the table. */
function useRows<T>(rows: readonly T[], ready: boolean, enabled: boolean): Slice<T> {
  return useMemo(() => ({ rows, ready: enabled && ready }), [rows, ready, enabled]);
}

export function TablesProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Partial<Record<TableName, number>>>({});
  const register = useCallback((name: TableName) => {
    setCounts((c) => ({ ...c, [name]: (c[name] ?? 0) + 1 }));
    return () => setCounts((c) => ({ ...c, [name]: (c[name] ?? 1) - 1 }));
  }, []);
  const on = (n: TableName) => (counts[n] ?? 0) > 0;

  const [accountRows, accountReady] = useTable(tables.myAccount, { enabled: on("myAccount") });
  const [platformRows, platformReady] = useTable(tables.platform, { enabled: on("platform") });
  const [workloadRows, workloadReady] = useTable(tables.myWorkloads, { enabled: on("myWorkloads") });
  const [conversationRows, conversationReady] = useTable(tables.myConversations, { enabled: on("myConversations") });
  const [messageRows, messageReady] = useTable(tables.myMessages, { enabled: on("myMessages") });
  const [projectRows, projectReady] = useTable(tables.myProjects, { enabled: on("myProjects") });
  const [runRows, runReady] = useTable(tables.myAgentRuns, { enabled: on("myAgentRuns") });
  const [stepRows, stepReady] = useTable(tables.myAgentSteps, { enabled: on("myAgentSteps") });
  const [eventRows, eventReady] = useTable(tables.myEvents, { enabled: on("myEvents") });
  const [metricRows, metricReady] = useTable(tables.myMetrics, { enabled: on("myMetrics") });
  const [logRows, logReady] = useTable(tables.myLogs, { enabled: on("myLogs") });
  const [artifactRows, artifactReady] = useTable(tables.myArtifacts, { enabled: on("myArtifacts") });
  const [handleRows, handleReady] = useTable(tables.myHandles, { enabled: on("myHandles") });
  const [linkCodeRows, linkCodeReady] = useTable(tables.myLinkCode, { enabled: on("myLinkCode") });

  const account = useRows(accountRows, accountReady, on("myAccount"));
  const platform = useRows(platformRows, platformReady, on("platform"));
  const conversations = useRows(conversationRows, conversationReady, on("myConversations"));
  const projects = useRows(projectRows, projectReady, on("myProjects"));
  const handles = useRows(handleRows, handleReady, on("myHandles"));
  const linkCode = useRows(linkCodeRows, linkCodeReady, on("myLinkCode"));

  const workloadsBase = useRows(workloadRows, workloadReady, on("myWorkloads"));
  const workloads = useMemo(
    () => ({
      ...workloadsBase,
      byId: new Map(workloadsBase.rows.map((w) => [w.id, w])),
      active: workloadsBase.rows.filter((w) => w.status !== "terminated").sort(byRecent),
    }),
    [workloadsBase],
  );

  const messagesBase = useRows(messageRows, messageReady, on("myMessages"));
  const messages = useMemo(() => ({ ...messagesBase, byConversation: group(messagesBase.rows, (m) => m.conversationId, byId) }), [messagesBase]);

  const runsBase = useRows(runRows, runReady, on("myAgentRuns"));
  const runs = useMemo(
    () => ({
      ...runsBase,
      byId: new Map(runsBase.rows.map((r) => [r.id, r])),
      byWorkload: group(runsBase.rows, wid, (a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis())),
    }),
    [runsBase],
  );

  const stepsBase = useRows(stepRows, stepReady, on("myAgentSteps"));
  const steps = useMemo(
    () => ({ ...stepsBase, byRun: group(stepsBase.rows, (s) => s.runId, (a, b) => a.seq - b.seq), byWorkload: group(stepsBase.rows, wid, byId) }),
    [stepsBase],
  );

  const eventsBase = useRows(eventRows, eventReady, on("myEvents"));
  const events = useMemo(() => ({ ...eventsBase, byWorkload: group(eventsBase.rows, wid) }), [eventsBase]);
  const metricsBase = useRows(metricRows, metricReady, on("myMetrics"));
  const metrics = useMemo(() => ({ ...metricsBase, byWorkload: group(metricsBase.rows, wid) }), [metricsBase]);
  const logsBase = useRows(logRows, logReady, on("myLogs"));
  const logs = useMemo(() => ({ ...logsBase, byWorkload: group(logsBase.rows, wid) }), [logsBase]);
  const artifactsBase = useRows(artifactRows, artifactReady, on("myArtifacts"));
  const artifacts = useMemo(() => ({ ...artifactsBase, byWorkload: group(artifactsBase.rows, wid) }), [artifactsBase]);

  const C = contexts;
  return (
    <Registry.Provider value={register}>
      <C.myAccount.Provider value={account}>
        <C.platform.Provider value={platform}>
          <C.myWorkloads.Provider value={workloads}>
            <C.myConversations.Provider value={conversations}>
              <C.myMessages.Provider value={messages}>
                <C.myProjects.Provider value={projects}>
                  <C.myAgentRuns.Provider value={runs}>
                    <C.myAgentSteps.Provider value={steps}>
                      <C.myEvents.Provider value={events}>
                        <C.myMetrics.Provider value={metrics}>
                          <C.myLogs.Provider value={logs}>
                            <C.myArtifacts.Provider value={artifacts}>
                              <C.myHandles.Provider value={handles}>
                                <C.myLinkCode.Provider value={linkCode}>{children}</C.myLinkCode.Provider>
                              </C.myHandles.Provider>
                            </C.myArtifacts.Provider>
                          </C.myLogs.Provider>
                        </C.myMetrics.Provider>
                      </C.myEvents.Provider>
                    </C.myAgentSteps.Provider>
                  </C.myAgentRuns.Provider>
                </C.myProjects.Provider>
              </C.myMessages.Provider>
            </C.myConversations.Provider>
          </C.myWorkloads.Provider>
        </C.platform.Provider>
      </C.myAccount.Provider>
    </Registry.Provider>
  );
}

/**
 * Read a table from the shared subscription. The table is subscribed while at
 * least one reader is mounted; `name` must be a constant at each call site.
 * With `enabled` false this reader doesn't keep the table subscribed.
 */
export function useShared<K extends TableName>(name: K, enabled = true): Slices[K] {
  const register = useContext(Registry);
  if (!register) throw new Error("useShared must be used under <TablesProvider>");
  useEffect(() => (enabled ? register(name) : undefined), [register, name, enabled]);
  return useContext(contexts[name]);
}
