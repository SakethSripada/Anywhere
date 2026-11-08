"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { useAccount, useMonthSpend, useNow, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { BILLABLE } from "@/lib/workloads";

/*
 * Live spend and what auto-stop saved. The meter counts from each machine's exact
 * billing start (the same numbers billing uses), so it ticks every tenth of a second
 * without guessing. Savings only count time the session limit wouldn't have cut anyway.
 */

type Running = { id: string; title: string; gpu: string; hourly_cents: number; segment_start: string | null; segment_base_cents: number };
type IdleStop = {
  id: string;
  title: string;
  gpu: string;
  hourly_cents: number;
  stopped_at: string;
  limit_at: string;
  resumed_at: string | null;
  saved_cents: number;
  counting: boolean;
};
type Costs = { now: string; running: Running[]; saved_cents: number; idle_minutes: number; session_hours: number; idle_stops: IdleStop[] };

function useCosts() {
  const api = useApi();
  const { workloads } = useWorkloads();
  // Refetch whenever something starts or stops billing, and when the tab comes back
  // into view. In between, the meter counts locally from each segment's exact start,
  // so polling the server would only return the numbers it already shows.
  const billing = workloads
    .filter((w) => BILLABLE.has(w.status))
    .map((w) => `${w.id}:${w.status}`)
    .join(",");
  const [data, setData] = useState<{ costs: Costs; skew: number } | null>(null);
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });
  useEffect(() => {
    if (!api.ready) return;
    let stop = false;
    const load = () =>
      apiRef.current
        .get<Costs>("/v1/costs")
        .then((costs) => !stop && setData({ costs, skew: Date.parse(costs.now) - Date.now() }))
        .catch(() => {});
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api.ready, billing]);
  return data;
}

function runningCents(r: Running, now: number) {
  if (!r.segment_start) return r.segment_base_cents;
  return r.segment_base_cents + (Math.max(0, now - Date.parse(r.segment_start)) / 3_600_000) * r.hourly_cents;
}

function savedCents(s: IdleStop, now: number) {
  const ends = [Date.parse(s.limit_at), now, ...(s.resumed_at ? [Date.parse(s.resumed_at)] : [])];
  return Math.max(0, ((Math.min(...ends) - Date.parse(s.stopped_at)) / 3_600_000) * s.hourly_cents);
}

const dollars = (c: number, digits = 4) => `$${(c / 100).toFixed(digits)}`;

/** A ticking number. Only this leaf re-renders on each tick, not the whole panel. */
function Live({ live, skew, children }: { live: boolean; skew: number; children: (now: number) => string }) {
  const now = useNow(250, live) + skew;
  return <>{children(now)}</>;
}

export function CostPanel() {
  const data = useCosts();
  const { account } = useAccount();
  const month = useMonthSpend();
  const running = data?.costs.running ?? [];
  const stops = data?.costs.idle_stops ?? [];
  const ticking = running.some((r) => r.segment_start) || stops.some((s) => s.counting);
  const skew = data?.skew ?? 0;
  const rate = running.reduce((s, r) => s + r.hourly_cents, 0);
  const spend = (now: number) => running.reduce((s, r) => s + runningCents(r, now), 0);
  const saved = (now: number) => stops.reduce((s, x) => s + savedCents(x, now), 0);

  return (
    <section className="rounded-lg border">
      <dl className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {rate > 0 && <span className="size-1.5 animate-pulse rounded-full bg-[var(--chart-1)]" aria-hidden />}
            Running now
          </dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular" aria-live="off">
            {data ? <Live live={ticking} skew={skew}>{(now) => dollars(spend(now))}</Live> : "…"}
          </dd>
          <dd className="truncate text-xs text-muted-foreground tabular">
            {rate > 0 ? `${cents(rate)}/hr · ${dollars(rate / 3600, 5)}/s · ${running.length} machine${running.length === 1 ? "" : "s"}` : "Nothing billing"}
          </dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-xs text-muted-foreground">This month</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular">{cents(month)}</dd>
          <dd className="truncate text-xs text-muted-foreground">of {cents(account?.monthlyCapCents ?? 0)} limit</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-xs text-muted-foreground">Saved by auto-stop</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular">{data ? (
              <Live live={ticking} skew={skew}>
                {(now) => {
                  const c = saved(now);
                  return dollars(c, c >= 100 ? 2 : 4);
                }}
              </Live>
            ) : (
              "…"
            )}</dd>
          <dd className="truncate text-xs text-muted-foreground">
            {stops.length
              ? `${stops.length} idle desktop${stops.length === 1 ? "" : "s"} stopped after ${data?.costs.idle_minutes} min`
              : `Idle desktops stop after ${data?.costs.idle_minutes ?? 20} min`}
          </dd>
        </div>
      </dl>

      {(running.length > 0 || stops.length > 0) && (
        <ul className="divide-y border-t text-[13px]">
          {running.map((r) => (
            <li key={`r${r.id}`} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">{r.gpu} · {cents(r.hourly_cents)}/hr</span>
              <span className="w-20 text-right font-medium tabular"><Live live={!!r.segment_start} skew={skew}>{(now) => dollars(runningCents(r, now))}</Live></span>
            </li>
          ))}
          {stops.slice(0, 5).map((s) => (
            <li key={`s${s.id}${s.stopped_at}`} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate">
                {s.title} <span className="text-muted-foreground">stopped idle at {new Date(s.stopped_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </span>
              <span className="hidden text-xs text-muted-foreground sm:inline">{s.counting ? "still saving" : s.resumed_at ? "until you resumed it" : "until the session limit"}</span>
              <span className="w-20 text-right tabular text-muted-foreground"><Live live={s.counting} skew={skew}>{(now) => `−${dollars(savedCents(s, now))}`}</Live></span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-4 py-2 text-[11.5px] text-muted-foreground">
        Savings count only the time a stopped desktop would have kept billing before the {data?.costs.session_hours ?? 1} h session limit stopped it anyway, or until you resumed it.
      </p>
    </section>
  );
}
