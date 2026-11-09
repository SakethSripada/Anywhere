"use client";

import { useEffect, useMemo, useState } from "react";
import { NONE, useShared } from "./tables";
import { byRecent } from "./workloads";

export function useAccount() {
  const { rows, ready } = useShared("myAccount");
  return { account: rows[0] ?? null, ready };
}

export function usePlatform() {
  const { rows, ready } = useShared("platform");
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
  const { rows, ready, active, byId } = useShared("myWorkloads");
  return { workloads: active, all: rows, byId, ready };
}

export function useWorkload(id: bigint | null) {
  const { byId, ready } = useShared("myWorkloads");
  return { workload: id == null ? null : (byId.get(id) ?? null), ready };
}

export function useConversations() {
  const { rows, ready } = useShared("myConversations");
  return { conversations: useMemo(() => [...rows].sort(byRecent), [rows]), ready };
}

export function useMessages(conversationId: bigint | null) {
  // No conversation yet (the home composer only sends): don't hold the subscription.
  const { byConversation, ready } = useShared("myMessages", conversationId != null);
  const messages = conversationId == null ? NONE : (byConversation.get(conversationId) ?? NONE);
  return { messages, ready };
}

export function useProjects() {
  const { rows, ready } = useShared("myProjects");
  return { projects: useMemo(() => [...rows].sort(byRecent), [rows]), ready };
}

export function useForWorkload<T extends { workloadId: bigint }>(rows: readonly T[], id: bigint) {
  return useMemo(() => rows.filter((r) => r.workloadId === id), [rows, id]);
}

/**
 * Month-to-date spend across the user's workloads, in cents. Mirrors the
 * control plane's cap check (`_this_month` in core.py): a workload counts if it
 * was created or active this (UTC) month, with its whole accrual. `startedAt`
 * alone resets on every resume, so it miscounted machines spanning two months.
 */
export function useMonthSpend() {
  const { all } = useWorkloads();
  const now = useNow(60_000);
  return useMemo(() => {
    if (!now) return 0;
    const d = new Date(now);
    const start = BigInt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    return all
      .filter((w) => [w.createdAt, w.lastActiveAt, w.updatedAt, w.startedAt].some((at) => at != null && at.toMillis() >= start))
      .reduce((sum, w) => sum + w.accruedCents, 0);
  }, [all, now]);
}

/**
 * A ticking clock that starts at 0 on the server (prerender must stay
 * deterministic) and begins counting once mounted. With `live` false it reads
 * the time once (and again whenever `live` changes) but doesn't keep ticking.
 */
export function useNow(intervalMs = 1000, live = true): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = live ? setInterval(tick, intervalMs) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs, live]);
  return now;
}
