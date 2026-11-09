/**
 * Workload lifecycle. This table is the single authority on which status
 * changes are legal; the control plane mirrors it in
 * services/control/src/anywhere/lifecycle.py (a test keeps them in sync).
 *
 *   planned ─► approved ─► provisioning ─► configuring ─► running
 *                                                          │  ▲
 *                                                  saving ◄┘  │
 *   running ─► stopping ─► stopped ─► provisioning (resume)   │
 *   provisioning/configuring ─► stopping  (a resume that failed goes back to sleep)
 *   running ─► succeeded                       saving ────────┘
 *   any active ─► failed ─► terminated
 */

export const WORKLOAD_STATUSES = [
  "planned",
  "approved",
  "provisioning",
  "configuring",
  "running",
  "saving",
  "stopping",
  "stopped",
  "succeeded",
  "failed",
  "cancelled",
  "terminated",
] as const;

export type WorkloadStatus = (typeof WORKLOAD_STATUSES)[number];

// prettier-ignore
export const TRANSITIONS: Record<WorkloadStatus, readonly WorkloadStatus[]> = {
  planned:      ["approved", "cancelled"],
  approved:     ["provisioning", "cancelled", "failed"],
  provisioning: ["configuring", "stopping", "failed", "cancelled"],
  configuring:  ["running", "stopping", "failed", "cancelled"],
  running:      ["saving", "stopping", "succeeded", "failed"],
  saving:       ["running", "stopping", "failed"],
  stopping:     ["stopped", "terminated", "failed"],
  stopped:      ["provisioning", "terminated"],
  failed:       ["terminated"],
  succeeded:    ["terminated"],
  cancelled:    [],
  terminated:   [],
};

/** Statuses during which compute may be billing. */
export const BILLABLE: readonly WorkloadStatus[] = [
  "provisioning",
  "configuring",
  "running",
  "saving",
  "stopping",
];

export function isWorkloadStatus(value: string): value is WorkloadStatus {
  return (WORKLOAD_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: string, to: string): boolean {
  if (!isWorkloadStatus(from) || !isWorkloadStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/* ── Account policy ────────────────────────────────────────────────────── */

/** Hard ceiling on any user's monthly cap, in cents. Protects shared credits. */
export const PLATFORM_MAX_MONTHLY_CAP_CENTS = 5000;
export const PREFERENCES = ["cheapest", "balanced", "fastest"] as const;

export function validatePreferences(input: {
  preference: string;
  monthlyCapCents: number;
  approvalThresholdCents: number;
}): string | null {
  if (!(PREFERENCES as readonly string[]).includes(input.preference)) {
    return `Unknown preference "${input.preference}"`;
  }
  if (input.monthlyCapCents < 100 || input.monthlyCapCents > PLATFORM_MAX_MONTHLY_CAP_CENTS) {
    return `Monthly cap must be between $1 and $${PLATFORM_MAX_MONTHLY_CAP_CENTS / 100}`;
  }
  if (input.approvalThresholdCents > input.monthlyCapCents) {
    return "Auto-approve threshold cannot exceed the monthly cap";
  }
  return null;
}

export const CONTROLLERS = ["agent", "user"] as const;

/* ── Write coalescing ──────────────────────────────────────────────────── */

/** Every workload row write fans out to each subscribed browser, so activity
 *  "touches" closer together than this are coalesced into one. */
export const TOUCH_INTERVAL_MICROS = 30_000_000n;

/**
 * What a `record_usage` call should change, or `null` when it changes nothing.
 * Spend is monotonic (a stale writer can never lower it), and a touch only
 * moves `lastActiveAt` when the previous one is at least TOUCH_INTERVAL old.
 */
export function usageUpdate(
  current: { accruedCents: number; lastActiveAtMicros?: bigint },
  accruedCents: number,
  touch: boolean,
  nowMicros: bigint,
): { accruedCents: number; touch: boolean } | null {
  const next = accruedCents > current.accruedCents ? accruedCents : current.accruedCents;
  const last = current.lastActiveAtMicros;
  const doTouch = touch && (last === undefined || nowMicros - last >= TOUCH_INTERVAL_MICROS);
  if (next === current.accruedCents && !doTouch) return null;
  return { accruedCents: next, touch: doTouch };
}

/** Conversation `updatedAt` only orders the sidebar; bumps closer together than
 *  this (tool calls, results, status lines in one turn) are skipped. */
export const CONVERSATION_BUMP_MICROS = 10_000_000n;

export function shouldBumpConversation(updatedAtMicros: bigint, nowMicros: bigint): boolean {
  return nowMicros - updatedAtMicros >= CONVERSATION_BUMP_MICROS;
}

/** GPU readings kept per workload and series in what browsers download: an hour at the 10 s default. */
export const GPU_POINTS_PER_SERIES = 360;

/**
 * Trim GPU telemetry (`gpu.*` metric points) to the newest `cap` readings per
 * workload and series, keeping training metrics (loss, progress) whole. Rows must be
 * in insertion (id) order; the result keeps that order.
 */
export function newestTelemetry<T extends { id: bigint; workloadId: bigint; name: string }>(
  rows: T[],
  cap: number = GPU_POINTS_PER_SERIES,
): T[] {
  const counts = new Map<string, number>();
  const keep = new Array<boolean>(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.name.startsWith("gpu.")) {
      keep[i] = true;
      continue;
    }
    const key = `${r.workloadId}:${r.name}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    keep[i] = n < cap;
  }
  return rows.filter((_, i) => keep[i]);
}
