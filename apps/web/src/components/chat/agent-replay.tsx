"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * Replay of a desktop agent run: one frame per decision, the screenshot it saw,
 * where it clicked and why. Steps through on a timer like a timelapse, and can
 * export the same thing as an annotated GIF.
 */

type Frame = {
  url: string;
  caption: string;
  kind: string;
  thought?: string;
  point?: [number, number];
  point_to?: [number, number];
  size?: [number, number];
};

type Replay = { run_id: number; goal: string; status: string; result: string; seconds: number | null; frames: Frame[] };

const FRAME_MS = 1400;
const SPEEDS = [1, 2, 4] as const;

export function ReplayButton({ workloadId, runId, className }: { workloadId: bigint; runId: bigint; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("w-fit text-[12px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors hover:text-ink-2 hover:decoration-current", className)}
      >
        Replay
      </button>
      {open && <ReplayDialog workloadId={workloadId} runId={runId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ReplayDialog({ workloadId, runId, onClose }: { workloadId: bigint; runId: bigint; onClose: () => void }) {
  const api = useApi();
  const [data, setData] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    const ctl = new AbortController();
    api
      .get<Replay>(`/v1/workloads/${workloadId}/agent-runs/${runId}/replay`, { signal: ctl.signal })
      .then((r) => !ctl.signal.aborted && setData(r))
      .catch((err) => !ctl.signal.aborted && setError(err instanceof ApiError ? err.message : "Couldn't load the replay."));
    return () => ctl.abort();
  }, [api, workloadId, runId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 p-0 sm:max-w-4xl">
        <div className="px-5 pt-4 pr-12">
          <DialogTitle className="truncate text-[15px] font-semibold tracking-tight">{data?.goal || "Agent replay"}</DialogTitle>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {data ? `${data.frames.length} step${data.frames.length === 1 ? "" : "s"}${data.seconds ? ` over ${data.seconds < 90 ? `${Math.round(data.seconds)}s` : `${Math.round(data.seconds / 60)} min`}` : ""}` : "Loading the run…"}
          </p>
        </div>
        {error && <p className="px-5 pb-5 text-[13px] text-destructive">{error}</p>}
        {data && !data.frames.length && <p className="px-5 pb-5 text-[13px] text-muted-foreground">This run has no saved screenshots to replay.</p>}
        {data && data.frames.length > 0 && <Player data={data} workloadId={workloadId} runId={runId} />}
        {!data && !error && <div className="mx-5 mb-5 aspect-video animate-pulse rounded-lg bg-muted" />}
      </DialogContent>
    </Dialog>
  );
}

function Player({ data, workloadId, runId }: { data: Replay; workloadId: bigint; runId: bigint }) {
  const { frames } = data;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const last = frames.length - 1;
  const f = frames[i];

  // Advance on a timer; stop on the last frame rather than looping.
  useEffect(() => {
    if (!playing || i >= last) return;
    const t = setTimeout(() => {
      setI(i + 1);
      if (i + 1 >= last) setPlaying(false);
    }, FRAME_MS / speed);
    return () => clearTimeout(t);
  }, [playing, i, last, speed]);

  // Warm the next screenshot so steps don't flash.
  useEffect(() => {
    const next = frames[i + 1];
    if (next) new Image().src = next.url;
  }, [frames, i]);

  const step = useCallback(
    (d: number) => {
      setPlaying(false);
      setI((n) => Math.max(0, Math.min(last, n + d)));
    },
    [last],
  );
  const toggle = useCallback(() => {
    if (i >= last) {
      setI(0);
      setPlaying(true);
    } else setPlaying((p) => !p);
  }, [i, last]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === " " || e.key === "k") toggle();
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex flex-col gap-3 outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Replay player. Space plays or pauses, arrow keys step.">
      <div className="relative mx-5 overflow-hidden rounded-lg bg-black shadow-hairline">
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived URL */}
        <img src={f.url} alt={`Step ${i + 1}: ${f.caption}`} className="block h-auto max-h-[60vh] w-full object-contain" />
        <Marker frame={f} />
        <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-2 py-0.5 text-[11.5px] text-white tabular">
          {i + 1} / {frames.length}
        </span>
      </div>

      <div className="mx-5 min-h-[3.25rem]">
        <p className={cn("text-[13.5px] font-medium", f.kind === "error" && "text-destructive")}>{f.caption}</p>
        {f.thought && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{f.thought}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
        <Button size="sm" variant="ghost" onClick={() => step(-1)} disabled={i === 0} aria-label="Previous step">
          ‹
        </Button>
        <Button size="sm" onClick={toggle} className="w-16">
          {playing ? "Pause" : i >= last ? "Replay" : "Play"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => step(1)} disabled={i === last} aria-label="Next step">
          ›
        </Button>
        <input
          type="range"
          min={0}
          max={last}
          value={i}
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
          aria-label="Step"
          className="mx-2 h-1 min-w-24 flex-1 accent-[var(--chart-1)]"
        />
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={cn("rounded-[5px] px-2 text-[12px] tabular", speed === s ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {s}×
            </button>
          ))}
        </div>
        <Download workloadId={workloadId} runId={runId} />
      </div>
    </div>
  );
}

/** Where the agent clicked, in the screenshot's own pixel space, scaled onto the image. */
function Marker({ frame }: { frame: Frame }) {
  if (!frame.point) return null;
  const [w, h] = frame.size ?? [1280, 720];
  const at = (p: [number, number]) => ({ x: (p[0] / w) * 100, y: (p[1] / h) * 100 });
  const a = at(frame.point);
  const b = frame.point_to ? at(frame.point_to) : null;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {b && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgb(74 222 128)" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
      {b && <ellipse cx={b.x} cy={b.y} rx={(7 / w) * 100} ry={(7 / h) * 100} fill="rgb(74 222 128)" />}
      {[22, 10].map((r) => (
        <ellipse key={r} cx={a.x} cy={a.y} rx={(r / w) * 100} ry={(r / h) * 100} fill="none" stroke="rgb(74 222 128)" strokeWidth={r === 22 ? 3 : 2} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function Download({ workloadId, runId }: { workloadId: bigint; runId: bigint }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = useRef<HTMLAnchorElement>(null);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(`/v1/workloads/${workloadId}/agent-runs/${runId}/timelapse`);
      if (link.current) {
        link.current.href = url;
        link.current.click();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't make the timelapse.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void make()}>
        {busy ? "Making GIF…" : "Download timelapse"}
      </Button>
      <a ref={link} className="hidden" download>
        timelapse
      </a>
    </div>
  );
}
