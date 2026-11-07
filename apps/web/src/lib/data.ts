"use client";

import { useEffect, useMemo, useState } from "react";
import { tables, useTable } from "./stdb";
import { byRecent } from "./workloads";

export function useAccount() {
  const [rows, ready] = useTable(tables.myAccount);
  return { account: rows[0] ?? null, ready };
}

export function usePlatform() {
  const [rows, ready] = useTable(tables.platform);
  const p = rows[0] ?? null;
  const integrations = useMemo<Record<string, boolean>>(() => {
    try {
      return p ? JSON.parse(p.integrationsJson) : {};
    } catch {
      return {};
    }
  }, [p]);
  return { platform: p, integrations, ready };
}

export function useWorkloads() {
  const [rows, ready] = useTable(tables.myWorkloads);
  const workloads = useMemo(() => [...rows].filter((w) => w.status !== "terminated").sort(byRecent), [rows]);
  return { workloads, all: rows, ready };
}

export function useWorkload(id: bigint | null) {
  const { all, ready } = useWorkloads();
  return { workload: id == null ? null : (all.find((w) => w.id === id) ?? null), ready };
}

export function useConversations() {
  const [rows, ready] = useTable(tables.myConversations);
  return { conversations: useMemo(() => [...rows].sort(byRecent), [rows]), ready };
}

export function useMessages(conversationId: bigint | null) {
  const [rows, ready] = useTable(tables.myMessages);
  const messages = useMemo(
    () =>
      conversationId == null
        ? []
        : rows
            .filter((m) => m.conversationId === conversationId)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [rows, conversationId],
  );
  return { messages, ready };
}

export function useProjects() {
  const [rows, ready] = useTable(tables.myProjects);
  return { projects: useMemo(() => [...rows].sort(byRecent), [rows]), ready };
}

export function useForWorkload<T extends { workloadId: bigint }>(rows: readonly T[], id: bigint) {
  return useMemo(() => rows.filter((r) => r.workloadId === id), [rows, id]);
}

/** Month-to-date spend across the user's workloads, in cents. */
export function useMonthSpend() {
  const { all } = useWorkloads();
  const now = useNow(60_000);
  return useMemo(() => {
    if (!now) return 0;
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return all
      .filter((w) => Number((w.startedAt ?? w.createdAt).toMillis()) >= start)
      .reduce((sum, w) => sum + w.accruedCents, 0);
  }, [all, now]);
}

/**
 * A ticking clock that starts at 0 on the server (prerender must stay
 * deterministic) and begins counting once mounted.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
