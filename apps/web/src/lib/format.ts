import type { Timestamp } from "spacetimedb";

export function cents(value: number | bigint, opts: { precise?: boolean } = {}): string {
  const n = Number(value) / 100;
  if (!opts.precise && n >= 100) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

export function centsRange(low: number, high: number): string {
  if (low === high) return cents(low);
  return `${cents(low)}–${cents(high).slice(1)}`;
}

export function perHour(centsPerHour: number): string {
  return `$${(centsPerHour / 100).toFixed(2)}/hr`;
}

export function toDate(ts: Timestamp | undefined | null): Date | null {
  return ts ? ts.toDate() : null;
}

export function ms(ts: Timestamp | undefined | null): number {
  return ts ? Number(ts.toMillis()) : 0;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

export function ago(ts: Timestamp | Date | number | undefined | null, now = Date.now()): string {
  if (ts == null) return "-";
  const t = typeof ts === "number" ? ts : ts instanceof Date ? ts.getTime() : Number(ts.toMillis());
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), "day");
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(ts: Timestamp | undefined | null): string {
  const d = toDate(ts);
  return d ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

export function duration(msTotal: number): string {
  if (!Number.isFinite(msTotal) || msTotal < 0) return "-";
  const m = Math.floor(msTotal / 60000);
  if (m < 1) return `${Math.max(1, Math.round(msTotal / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function hoursRange(low: number, high: number): string {
  const f = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${+h.toFixed(1)} h`);
  return low === high ? f(low) : `${f(low)} – ${f(high)}`;
}

export function bytes(n: number | bigint): string {
  let v = Number(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function compact(n: number): string {
  if (Math.abs(n) >= 1000) return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(1);
  return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 1 ? 3 : 2);
}
