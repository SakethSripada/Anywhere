"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compact } from "@/lib/format";

type Point = { step: number; value: number };

const PAD = { top: 12, right: 12, bottom: 24, left: 44 };
const HEIGHT = 260;

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(12));
  return out;
}

/**
 * Single-series line chart for one training metric: a 2px line, a soft area,
 * recessive gridlines, and a crosshair tooltip that snaps to the nearest step.
 */
export function MetricChart({ points, label, compare, compareLabel }: { points: Point[]; label: string; compare?: Point[]; compareLabel?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (!points.length || width < 80) return null;
    const both = compare?.length ? [...points, ...compare] : points;
    const xs = both.map((p) => p.step);
    const ys = both.map((p) => p.value);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    const padY = (y1 - y0 || Math.abs(y1) || 1) * 0.08;
    y0 -= padY;
    y1 += padY;
    const iw = width - PAD.left - PAD.right;
    const ih = HEIGHT - PAD.top - PAD.bottom;
    const sx = (v: number) => PAD.left + (x1 === x0 ? iw / 2 : ((v - x0) / (x1 - x0)) * iw);
    const sy = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * ih;
    const line = points.map((p, i) => `${i ? "L" : "M"}${sx(p.step).toFixed(1)},${sy(p.value).toFixed(1)}`).join("");
    const area = `${line}L${sx(x1).toFixed(1)},${PAD.top + ih}L${sx(x0).toFixed(1)},${PAD.top + ih}Z`;
    const cline = compare?.length ? compare.map((p, i) => `${i ? "L" : "M"}${sx(p.step).toFixed(1)},${sy(p.value).toFixed(1)}`).join("") : null;
    return { sx, sy, line, cline, area, yTicks: niceTicks(y0, y1), xTicks: niceTicks(x0, x1, Math.max(2, Math.floor(iw / 90))), ih };
  }, [points, compare, width]);

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geo.sx(p.step) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  const hp = hover != null ? points[hover] : null;
  const latest = points.at(-1);

  return (
    <div ref={wrap} className="relative w-full" style={{ height: HEIGHT }}>
      {!points.length && (
        <div className="grid h-full place-items-center text-[13px] text-muted-foreground">No {label} data yet.</div>
      )}
      {geo && (
        <svg width={width} height={HEIGHT} className="block overflow-visible" role="img" aria-label={`${label} by training step`}>
          <defs>
            <linearGradient id={`area-${label}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)} stroke="var(--border)" strokeDasharray="2 4" />
              <text x={PAD.left - 8} y={geo.sy(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                {compact(t)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t) => (
            <text key={`x${t}`} x={geo.sx(t)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular">
              {compact(t)}
            </text>
          ))}
          <path d={geo.area} fill={`url(#area-${label})`} />
          <path d={geo.line} fill="none" stroke="var(--chart-1)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {geo.cline && <path d={geo.cline} fill="none" stroke="var(--chart-2)" strokeWidth={1.75} strokeDasharray="4 3" strokeLinejoin="round" />}
          {latest && hover == null && (
            <circle cx={geo.sx(latest.step)} cy={geo.sy(latest.value)} r={4} fill="var(--chart-1)" stroke="var(--background)" strokeWidth={2} />
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={geo.sx(hp.step)} x2={geo.sx(hp.step)} y1={PAD.top} y2={PAD.top + geo.ih} stroke="var(--border)" strokeDasharray="3 3" />
              <circle cx={geo.sx(hp.step)} cy={geo.sy(hp.value)} r={4.5} fill="var(--chart-1)" stroke="var(--background)" strokeWidth={2} />
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={Math.max(0, width - PAD.left - PAD.right)}
            height={geo.ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {geo && hp && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(Math.max(geo.sx(hp.step) + 10, PAD.left), width - 132),
          }}
        >
          <div className="text-muted-foreground">Step {hp.step.toLocaleString()}</div>
          <div className="tabular font-medium">
            {label} {compact(hp.value)}
          </div>
          {compare && nearest(compare, hp.step) && (
            <div className="tabular text-muted-foreground">
              {compareLabel} {compact(nearest(compare, hp.step)!.value)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function nearest(points: Point[], step: number): Point | null {
  let best: Point | null = null;
  for (const p of points) if (p.step <= step && (!best || p.step > best.step)) best = p;
  return best;
}
