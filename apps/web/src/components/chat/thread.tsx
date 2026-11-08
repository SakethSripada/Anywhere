"use client";

import type { Message, Workload } from "@anywhere/stdb";
import { ArrowDown } from "lucide-react";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoadingStatus } from "@/components/bui/loader";
import { agentBusy, toItems, type ChatItem } from "@/lib/chat";
import { useNow, useWorkloads } from "@/lib/data";
import { clock, ms } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";
import { href } from "@/lib/workloads";
import { Markdown } from "./markdown";
import { PlanCard, PlanRow } from "./plan-card";
import { RunTrace, ToolRun } from "./tool-run";

export type Pending = { id: string; text: string };

type EventItem = { kind: "event"; at: number; key: string; level: string; text: string; time: string };
type StreamItem =
  | { kind: "chat"; at: number; item: ChatItem }
  | { kind: "run"; at: number; key: string; runId: bigint }
  | EventItem
  | { kind: "events"; at: number; key: string; events: EventItem[] };

const routine = (e: StreamItem): e is EventItem => e.kind === "event" && (e.level === "info" || e.level === "success");

/**
 * Fold runs of routine machine events ("Fetching the desktop image", ...) into
 * one collapsible line, so the conversation isn't buried under setup steps.
 * Warnings and errors always stay on their own line.
 */
function foldEvents(items: StreamItem[]): StreamItem[] {
  const out: StreamItem[] = [];
  let run: EventItem[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "events", at: run[0].at, key: `g${run[0].key}`, events: run });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (routine(it)) run.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

/**
 * One continuous stream, the way Codex and Claude show an agent: what you
 * said, what it said, every tool it called and — when focused on a machine —
 * every desktop run and machine event, in the order they happened.
 */
export function Thread({
  messages,
  pending,
  compact,
  focus,
  className,
}: {
  messages: readonly Message[];
  pending: Pending[];
  compact?: boolean;
  /** stream this machine's agent runs and events in as well */
  focus?: Workload;
  className?: string;
}) {
  const items = useMemo(() => toItems(messages), [messages]);
  const now = useNow(1000);
  const [runs] = useTable(tables.myAgentRuns);
  const [events] = useTable(tables.myEvents);

  const stream = useMemo<StreamItem[]>(() => {
    const out: StreamItem[] = items.map((item) => ({ kind: "chat", at: itemTime(item), item }));
    if (focus) {
      // Runs started from a tool call already render inside that call.
      const linked = new Set<string>();
      for (const it of items) if (it.type === "tools") for (const c of it.calls) if (c.result) linked.add(String(safeRunId(c.result.output)));
      for (const r of runs) if (r.workloadId === focus.id && !linked.has(String(r.id))) out.push({ kind: "run", at: ms(r.startedAt), key: `r${r.id}`, runId: r.id });
      for (const e of events)
        // Runs already narrate themselves; skip their start/finish events.
        if (e.workloadId === focus.id && !/^agent (started|finished|stopped|paused|resumed)/i.test(e.message)) out.push({ kind: "event", at: ms(e.createdAt), key: `e${e.id}`, level: e.level, text: e.message, time: clock(e.createdAt) });
    }
    return foldEvents(out.sort((a, b) => a.at - b.at));
  }, [items, runs, events, focus]);

  const busy = pending.length > 0 || agentBusy(items, now);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [stream, pending.length, busy]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          stick.current = bottom;
          setAtBottom(bottom);
        }}
        className="h-full overflow-y-auto"
      >
        <div className={cn("mx-auto flex w-full flex-col", compact ? "gap-5 px-5 pt-5 pb-6" : "max-w-3xl gap-6 px-4 pt-10 pb-14 sm:px-6")}>
          {stream.map((s) =>
            s.kind === "chat" ? (
              <Item key={s.item.key} item={s.item} compact={compact} focused={!!focus} />
            ) : s.kind === "run" && focus ? (
              <RunTrace key={s.key} workload={focus} runId={s.runId} linkMachines={false} />
            ) : s.kind === "event" ? (
              <EventLine key={s.key} level={s.level} text={s.text} time={s.time} />
            ) : s.kind === "events" ? (
              <EventGroup key={s.key} events={s.events} />
            ) : null,
          )}
          {pending.map((p) => (
            <UserBubble key={p.id} text={p.text} compact={compact} />
          ))}
          {busy && <LoadingStatus label="Thinking" since={lastUser ? ms(lastUser.createdAt) : undefined} className="py-1" />}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          aria-label="Scroll to latest"
          className="absolute bottom-3 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full bg-card text-ink-2 shadow-btn transition-colors hover:text-ink"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function safeRunId(output: string): string | null {
  try {
    const v = JSON.parse(output);
    return v?.run_id != null ? String(v.run_id) : null;
  } catch {
    return null;
  }
}

function itemTime(item: ChatItem): number {
  if (item.type === "tools") return ms(item.calls[0].startedAt);
  return ms(item.m.createdAt);
}

const prose = (compact?: boolean) => (compact ? "text-[13.5px] leading-[1.7] text-ink" : undefined);

function Item({ item, compact, focused }: { item: ChatItem; compact?: boolean; focused: boolean }) {
  switch (item.type) {
    case "user":
      return <UserBubble text={item.m.body} channel={item.m.channel} time={clock(item.m.createdAt)} compact={compact} />;
    case "tools":
      return <ToolRun calls={item.calls} linkMachines={!focused} />;
    case "plan":
      return compact ? (
        <PlanRow workloadId={item.m.workloadId} />
      ) : (
        <>
          <div className="xl:hidden">
            <PlanCard workloadId={item.m.workloadId} />
          </div>
          <div className="hidden max-w-md xl:block">
            <PlanRow workloadId={item.m.workloadId} />
          </div>
        </>
      );
    case "status":
      return <StatusLine m={item.m} focused={focused} />;
    case "error":
      return <Markdown text={item.m.body} className={cn("text-red", prose(compact))} />;
    case "agent":
      return <Markdown text={item.m.body} className={prose(compact)} />;
    default:
      return <Markdown text={item.m.body} className={prose(compact)} />;
  }
}

function UserBubble({ text, channel, time, compact }: { text: string; channel?: string; time?: string; compact?: boolean }) {
  const [main, ...attachments] = text.split(/\n\n(?=\[Attached dataset)/);
  return (
    <div className="group flex flex-col items-end gap-1 pl-12" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className={cn("rounded-xl bg-field text-ink whitespace-pre-wrap", compact ? "px-3.5 py-2 text-[13.5px] leading-[1.5]" : "px-4 py-2.5 text-[15px] leading-7")}>{main}</div>
      {attachments.map((a) => (
        <div key={a} className="max-w-[85%] truncate rounded-chip px-2 py-1 text-[11.5px] text-ink-2 shadow-hairline">
          {a.replace(/^\[|\]$/g, "")}
        </div>
      ))}
      {(time || channel === "imessage") && (
        <div className="px-1 text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
          {channel === "imessage" && "via iMessage · "}
          {time}
        </div>
      )}
    </div>
  );
}

function StatusLine({ m, focused }: { m: Message; focused: boolean }) {
  const { all } = useWorkloads();
  const w = all.find((x) => x.id === m.workloadId);
  return (
    <div className="flex items-baseline gap-2 text-[12.5px] text-ink-2">
      <span className="size-1.5 shrink-0 -translate-y-px rounded-full bg-green" />
      <span className="min-w-0 flex-1">{m.body}</span>
      {w && !focused && (
        <Link href={href(w)} className="shrink-0 text-ink-3 underline decoration-transparent underline-offset-2 transition-colors hover:text-ink hover:decoration-current">
          Open
        </Link>
      )}
    </div>
  );
}

function EventGroup({ events }: { events: EventItem[] }) {
  const [open, setOpen] = useState(false);
  const last = events.at(-1)!;
  const took = last.at - events[0].at;
  const span = took >= 60_000 ? `${Math.round(took / 60_000)} min` : `${Math.max(1, Math.round(took / 1000))}s`;
  return (
    <div className="text-[12px] text-ink-3" style={{ animation: "fade-in 300ms ease-out both" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 text-left transition-colors hover:text-ink-2"
      >
        <span className="size-1.5 shrink-0 -translate-y-px rounded-full bg-line-strong" />
        <span className="min-w-0 flex-1 truncate">
          Machine setup · {events.length} steps over {span} · <span className="text-ink-2">{last.text}</span>
        </span>
        <span className="shrink-0 text-[11px]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 border-l pl-3">
          {events.map((e) => (
            <EventLine key={e.key} level={e.level} text={e.text} time={e.time} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventLine({ level, text, time }: { level: string; text: string; time: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px] text-ink-3" style={{ animation: "fade-in 300ms ease-out both" }}>
      <span className={cn("size-1.5 shrink-0 -translate-y-px rounded-full", level === "error" ? "bg-red" : level.startsWith("warn") ? "bg-warning" : level === "success" ? "bg-green" : "bg-line-strong")} />
      <span className={cn("min-w-0 flex-1", level === "error" && "text-red")}>{text}</span>
      <span className="shrink-0 text-[11px] tabular-nums">{time}</span>
    </div>
  );
}
