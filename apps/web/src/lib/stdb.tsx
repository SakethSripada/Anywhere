"use client";

/* DEMO BRANCH ONLY: serves the in-memory demo store instead of SpacetimeDB. */
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { startDemo } from "./demo/sim";
import { OWNER, patch, rows, subscribe, type Rows, type Table } from "./demo/store";

const noop = () => () => {};

export function StdbProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const isClient = useSyncExternalStore(noop, () => true, () => false);
  if (!isClient) return fallback;
  startDemo();
  return <>{children}</>;
}

export type Session = { ready: boolean; identity: string | null; token: string | null; error: string | null };

export function useSession(): Session {
  return useMemo(() => ({ ready: true, identity: OWNER.toHexString(), token: "demo", error: null }), []);
}

export const tables = Object.fromEntries(
  ["platform", "myAccount", "myConversations", "myMessages", "myWorkloads", "myEvents", "myLogs", "myMetrics", "myAgentRuns", "myAgentSteps", "myProjects", "myArtifacts", "myHandles", "myLinkCode"].map((k) => [k, k]),
) as { [K in Table]: K };

export function useTable<K extends Table>(table: K): [readonly Rows[K][], boolean] {
  const data = useSyncExternalStore(subscribe, () => rows(table), () => rows(table));
  return [data, true];
}

type Args = Record<string, unknown>;
export const reducers = {
  register: (a: Args) => patch("myAccount", () => true, { displayName: String(a.displayName) }),
  updatePreferences: (a: Args) =>
    patch("myAccount", () => true, { preference: String(a.preference), monthlyCapCents: Number(a.monthlyCapCents), approvalThresholdCents: Number(a.approvalThresholdCents) }),
  archiveConversation: (a: Args) => patch("myConversations", (c) => c.id === a.id, { archived: true }),
  unlinkHandle: (a: Args) => patch("myHandles", (h) => h.handle === a.handle, { handle: "" }),
  setController: (a: Args) => patch("myWorkloads", (w) => w.id === a.workloadId, { controller: String(a.controller) }),
  renameConversation: (a: Args) => patch("myConversations", (c) => c.id === a.id, { title: String(a.title) }),
};

export function useReducer<F extends (a: Args) => void>(fn: F) {
  return async (a: Parameters<F>[0]) => fn(a);
}
