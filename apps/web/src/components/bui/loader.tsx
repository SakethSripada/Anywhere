"use client";

/*
 * Pixel-grid loader + shimmering status line.
 * Adapted from Beautiful UI "Loading State" (beautifului.dev, MIT © 2026 Shane Levine).
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3),
    c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  drive: { delays: chevron, dur: 650, round: false },
  dots: { delays: chevron, dur: 650, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
} as const;

export type LoaderVariant = keyof typeof PATTERNS;

export function LoaderGrid({ variant = "orbit", className, tone = "bg-ink" }: { variant?: LoaderVariant; className?: string; tone?: string }) {
  const { delays, dur, round } = PATTERNS[variant];
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]", className)}>
      {delays.map((delay, i) => (
        <span
          key={i}
          className={cn("size-[4px]", tone, round ? "rounded-full" : "rounded-[1px]")}
          style={{ opacity: delay === null ? 0.07 : 0.15, animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite` }}
        />
      ))}
    </span>
  );
}

/** Elapsed time since `since` (epoch ms), ticking every 100ms. */
export function useElapsed(since: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 100);
    return () => clearInterval(t);
  }, []);
  if (!now || !since) return "";
  const total = Math.max(0, (now - since) / 1000);
  if (total < 60) return `${total.toFixed(1)}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${Math.floor(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

export function LoadingStatus({ label, since, variant = "drive", className }: { label: string; since?: number; variant?: LoaderVariant; className?: string }) {
  const elapsed = useElapsed(since ?? 0);
  return (
    <div role="status" className={cn("flex w-fit items-center gap-2.5", className)}>
      <LoaderGrid variant={variant} />
      <span className="bui-shimmer text-[13px] font-medium">{label}</span>
      {since ? <span className="text-[12px] text-ink-3 tabular-nums">{elapsed}</span> : null}
    </div>
  );
}
