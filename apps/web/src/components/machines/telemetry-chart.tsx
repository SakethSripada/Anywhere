"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clockSeconds, type GpuPoint } from "@/lib/insights";

const PAD = { top: 10, right: 10, bottom: 22, left: 38 };
const HEIGHT = 150; // includes the x-axis band, so the card never scrolls

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= v) ?? 10 * mag);
}

/**
 * One GPU measure over elapsed time: a 2px line over a faint wash, solid
 * hairline gridlines, and a crosshair tooltip that snaps to the nearest reading.
 * Single series, so no legend: the panel title names it.
 */
export function TelemetryChart({
  points,
  label,
  format,
  max,
}: {
  points: GpuPoint[];
  label: string;
  format: (v: number) => string;
  /** Fixed top of the scale (100 for a percentage, total VRAM); otherwise derived from the data. */
  max?: number;
}) {
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
    if (points.length < 2 || width < 120) return null;
    const t0 = points[0].t;
    const t1 = points.at(-1)!.t;
    const top = max ?? niceMax(Math.max(...points.map((p) => p.v)) * 1.1);
    const iw = width - PAD.left - PAD.right;
    const ih = HEIGHT - PAD.top - PAD.bottom;
    const sx = (t: number) => PAD.left + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw);
    const sy = (v: number) => PAD.top + (1 - Math.min(v, top) / top) * ih;
    const line = points.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join("");
    const area = `${line}L${sx(t1).toFixed(1)},${PAD.top + ih}L${sx(t0).toFixed(1)},${PAD.top + ih}Z`;
    const yTicks = [0, top / 2, top];
    const xCount = Math.max(2, Math.min(5, Math.floor(iw / 90)));
    const xTicks = Array.from({ length: xCount }, (_, i) => t0 + ((t1 - t0) * i) / (xCount - 1));
    return { sx, sy, line, area, yTicks, xTicks, ih };
  }, [points, width, max]);

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geo.sx(p.t) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  const hp = hover != null ? points[hover] : null;
  const last = points.at(-1);

  return (
    <div ref={wrap} className="relative w-full" style={{ height: HEIGHT }}>
      {!geo && (
        <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
          {points.length ? "Collecting readings…" : "No readings yet"}
        </div>
      )}
      {geo && (
        <svg width={width} height={HEIGHT} className="block overflow-visible" role="img" aria-label={`${label} over time`}>
          {geo.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.left - 6} y={geo.sy(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10.5px] tabular">
                {format(t)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t, i) => (
            <text
              key={`x${i}`}
              x={geo.sx(t)}
              y={HEIGHT - 5}
              textAnchor={i === 0 ? "start" : i === geo.xTicks.length - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[10.5px] tabular"
            >
              {clockSeconds(t)}
            </text>
          ))}
          <path d={geo.area} fill="var(--chart-1)" fillOpacity={0.1} />
          <path d={geo.line} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {last && hover == null && (
            <circle cx={geo.sx(last.t)} cy={geo.sy(last.v)} r={4} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={geo.sx(hp.t)} x2={geo.sx(hp.t)} y1={PAD.top} y2={PAD.top + geo.ih} stroke="var(--muted-foreground)" strokeOpacity={0.4} />
              <circle cx={geo.sx(hp.t)} cy={geo.sy(hp.v)} r={4.5} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
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
          className="pointer-events-none absolute top-0 z-10 rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max(geo.sx(hp.t) + 10, PAD.left), width - 120) }}
        >
          <div className="font-medium tabular">{format(hp.v)}</div>
          <div className="text-muted-foreground tabular">at {clockSeconds(hp.t)}</div>
        </div>
      )}
    </div>
  );
}
