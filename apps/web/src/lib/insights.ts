"use client";

import { useMemo } from "react";
import { useNow } from "./data";
import { ms } from "./format";
import { NONE, useShared } from "./tables";

/* ── GPU telemetry ─────────────────────────────────────────────────────────
 * The control plane samples `nvidia-smi` on running machines and stores each
 * reading as `gpu.*` metric points whose step is seconds since billing began. */

export type GpuPoint = { t: number; v: number };
export type GpuSeries = { util: GpuPoint[]; mem: GpuPoint[]; temp: GpuPoint[]; power: GpuPoint[]; memTotal: number | null };

const KEYS = { "gpu.util_pct": "util", "gpu.mem_used_gb": "mem", "gpu.temp_c": "temp", "gpu.power_w": "power" } as const;

export function useGpuTelemetry(workloadId: bigint): GpuSeries {
  // The shared subscription, already grouped by machine: no second subscription,
  // and no scan of every machine's readings on each new one.
  const rows = useShared("myMetrics").byWorkload.get(workloadId) ?? NONE;
  return useMemo(() => {
    const out: GpuSeries = { util: [], mem: [], temp: [], power: [], memTotal: null };
    for (const r of rows) {
      if (!Number.isFinite(r.value)) continue;
      if (r.name === "gpu.mem_total_gb") out.memTotal = r.value;
      const key = KEYS[r.name as keyof typeof KEYS];
      if (key) out[key].push({ t: r.step, v: r.value });
    }
    for (const k of ["util", "mem", "temp", "power"] as const) out[k].sort((a, b) => a.t - b.t);
    return out;
  }, [rows]);
}

/* ── Boot timeline ─────────────────────────────────────────────────────────
 * Built from the milestone events the supervisor writes (keep these strings in
 * sync with BOOT_* in services/control/src/anywhere/supervisor.py). */

const BOOT_START = ["Machine requested", "Restarting the machine"];
const BOOT_END = ["Desktop is live", "Blender is open", "Training started", "Rendering started"];

const FRIENDLY: [RegExp, string][] = [
  [/^Machine requested/, "Brev boots a new GPU machine"],
  [/^Restarting the machine/, "Brev restarts the machine"],
  [/^Checking the GPU/, "Checking the GPU"],
  [/^Fetching the desktop image/, "Downloading the desktop image"],
  [/^Starting the desktop$/, "Starting the desktop"],
  [/^Installing Blender/, "Installing Blender"],
  [/^Desktop environment installed/, "Finishing the install"],
  [/^Starting the desktop session/, "Starting the desktop session"],
  [/^Restoring your saved project/, "Restoring your project files"],
  [/^Desktop is live/, "Opening the app"],
];

export type BootStage = { label: string; start: number; end: number; open: boolean };
export type Boot = { kind: "cold" | "resume"; startedAt: number; stages: BootStage[]; total: number; done: boolean };

const friendly = (m: string) => FRIENDLY.find(([re]) => re.test(m))?.[1] ?? m;

/** The machine's latest boot. Its clock ticks only while a stage is still running. */
export function useBootTimeline(workloadId: bigint): Boot | null {
  const rows = useShared("myEvents").byWorkload.get(workloadId) ?? NONE;
  const events = useMemo(
    () =>
      rows
        .map((e) => ({ id: e.id, level: e.level, message: e.message, at: ms(e.createdAt) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [rows],
  );
  const settled = useMemo(() => bootFrom(events, 0), [events]);
  const now = useNow(1000, !!settled && !settled.done);
  return useMemo(() => (settled && !settled.done ? bootFrom(events, now) : settled), [settled, events, now]);
}

type Ev = { level: string; message: string; at: number };

/** The most recent boot: from its start milestone to the moment the work was ready. */
export function bootFrom(events: Ev[], now: number): Boot | null {
  let s = -1;
  events.forEach((e, i) => {
    if (BOOT_START.some((p) => e.message.startsWith(p))) s = i;
  });
  if (s < 0) return null;
  const slice: Ev[] = [];
  let end: Ev | null = null;
  for (let i = s; i < events.length; i++) {
    const e = events[i];
    if (BOOT_END.some((p) => e.message.startsWith(p))) {
      end = e;
      // The app opening right after the desktop goes live is still part of the boot.
      const next = events[i + 1];
      if (e.message.startsWith("Desktop is live") && next?.message.startsWith("Blender is open") && next.at - e.at < 60_000) {
        slice.push(e);
        end = next;
      }
      break;
    }
    if (e.level === "error") break;
    slice.push(e);
  }
  if (!slice.length) return null;
  const t0 = slice[0].at;
  const finish = end ? end.at : now || slice.at(-1)!.at;
  const stages = slice.map((e, i) => {
    const stop = i + 1 < slice.length ? slice[i + 1].at : finish;
    return { label: friendly(e.message), start: e.at - t0, end: Math.max(stop, e.at) - t0, open: !end && i === slice.length - 1 };
  });
  return {
    kind: slice[0].message.startsWith("Restarting") ? "resume" : "cold",
    startedAt: t0,
    stages,
    total: finish - t0,
    done: !!end,
  };
}

/** "6m 52s", "45s", "1h 02m". */
export function elapsed(msTotal: number): string {
  if (!Number.isFinite(msTotal) || msTotal < 0) return "-";
  const s = Math.round(msTotal / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Elapsed seconds as a clock, for time axes: "4:05", "1:02:10". */
export function clockSeconds(t: number): string {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
