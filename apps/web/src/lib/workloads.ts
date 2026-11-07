import type { Workload } from "@anywhere/stdb";
import { ms } from "./format";

export type Status =
  | "planned"
  | "approved"
  | "provisioning"
  | "configuring"
  | "running"
  | "saving"
  | "stopping"
  | "stopped"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "terminated";

export type Tone = "ok" | "busy" | "wait" | "bad" | "idle" | "accent";

export const STATUS: Record<Status, { label: string; tone: Tone; live?: boolean }> = {
  planned: { label: "Awaiting approval", tone: "wait" },
  approved: { label: "Queued", tone: "busy", live: true },
  provisioning: { label: "Provisioning", tone: "busy", live: true },
  configuring: { label: "Setting up", tone: "busy", live: true },
  running: { label: "Running", tone: "ok", live: true },
  saving: { label: "Saving", tone: "busy", live: true },
  stopping: { label: "Stopping", tone: "busy", live: true },
  stopped: { label: "Stopped", tone: "idle" },
  succeeded: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "idle" },
  terminated: { label: "Deleted", tone: "idle" },
};

export function statusMeta(status: string) {
  return STATUS[status as Status] ?? { label: status, tone: "idle" as Tone };
}

/** Statuses during which compute may exist and bill. Mirrors lifecycle.ts. */
export const BILLABLE = new Set<string>(["provisioning", "configuring", "running", "saving", "stopping"]);
export const ACTIVE = new Set<string>([...BILLABLE, "approved"]);
export const QUEUED = new Set<string>(["planned", "approved"]);
export const DONE = new Set<string>(["succeeded", "stopped", "cancelled", "terminated"]);

/** Ordered setup milestones shown while a machine comes up. */
export const BOOT_STEPS: { status: Status; label: string; hint: string }[] = [
  { status: "approved", label: "Approved", hint: "Budget checks passed" },
  { status: "provisioning", label: "Provisioning GPU", hint: "Reserving a machine on NVIDIA Brev" },
  { status: "configuring", label: "Configuring environment", hint: "Drivers, desktop and apps" },
  { status: "running", label: "Ready", hint: "Streaming to your browser" },
];

/** Spend including the current billing interval, estimated between server ticks. */
export function liveCents(w: Workload, now = Date.now()): number {
  if (!BILLABLE.has(w.status) || !w.startedAt) return w.accruedCents;
  const since = ms(w.lastActiveAt ?? w.updatedAt);
  // The guard ticks every ~30 s; never extrapolate further than a minute past it.
  const extra = Math.min(Math.max(0, now - since), 60_000) * (w.hourlyCents / 3_600_000);
  return Math.max(w.accruedCents, Math.round(w.accruedCents + extra));
}

export function href(w: Pick<Workload, "id">): string {
  return `/w/${w.id}`;
}

export function byRecent<T extends { updatedAt?: { toMillis(): bigint }; createdAt: { toMillis(): bigint } }>(
  a: T,
  b: T,
): number {
  const bt = Number((b.updatedAt ?? b.createdAt).toMillis());
  const at = Number((a.updatedAt ?? a.createdAt).toMillis());
  return bt - at;
}
