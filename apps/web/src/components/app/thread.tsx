"use client";

import type { Message } from "@anywhere/stdb";
import Link from "next/link";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { useNow, useWorkloads } from "@/lib/data";
import { clock, ms } from "@/lib/format";
import { href, statusMeta } from "@/lib/workloads";
import { IconAgent, IconAlert, IconArrowRight, IconMessage, Mark } from "../icons";
import { Dot } from "../ui/status";
import { Markdown } from "./markdown";
import { PlanCard } from "./plan-card";

export type Pending = { id: string; text: string; at: number };

export function Thread({ messages, pending }: { messages: readonly Message[]; pending: Pending[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useNow(1000);
  const last = messages.at(-1);

  // The agent is working while the newest message is the user's (or an optimistic one).
  const lastAt = last ? ms(last.createdAt) : 0;
  const waiting = pending.length > 0 || (last?.role === "user" && now > 0 && now - lastAt < 180_000);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: messages.length > 0 ? "smooth" : "auto" });
  }, [messages.length, pending.length, waiting]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-8 pb-10 sm:px-6">
        {messages.map((m, i) => (
          <MessageView key={String(m.id)} m={m} prev={messages[i - 1]} />
        ))}
        {pending.map((p) => (
          <UserBubble key={p.id} text={p.text} faded />
        ))}
        {waiting && <Thinking />}
      </div>
    </div>
  );
}

function MessageView({ m, prev }: { m: Message; prev?: Message }) {
  if (m.role === "user") return <UserBubble text={m.body} channel={m.channel} time={clock(m.createdAt)} />;

  switch (m.kind) {
    case "plan":
      return (
        <AssistantRow showMark={prev?.role === "user"}>
          <PlanCard workloadId={m.workloadId} />
        </AssistantRow>
      );
    case "status":
      return <StatusLine m={m} />;
    case "error":
      return (
        <AssistantRow showMark={prev?.role === "user"}>
          <div className="flex gap-2.5 rounded-xl bg-bad-soft px-3.5 py-3 text-sm text-fg-muted shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-bad)_22%,transparent)]">
            <IconAlert size={15} className="mt-0.5 shrink-0 text-bad" />
            <div className="min-w-0">
              <Markdown text={m.body} />
            </div>
          </div>
        </AssistantRow>
      );
    case "agent":
      return (
        <AssistantRow showMark={prev?.role === "user"}>
          <div className="rounded-xl bg-raised/60 px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
              <IconAgent size={13} className="text-accent" />
              Agent report
              <WorkloadLink id={m.workloadId} />
            </div>
            <div className="text-base leading-relaxed text-fg-muted">
              <Markdown text={m.body} />
            </div>
          </div>
        </AssistantRow>
      );
    default:
      return (
        <AssistantRow showMark={prev?.role === "user" || prev?.kind === "status"}>
          <div className="text-base leading-[1.7] text-fg-muted">
            <Markdown text={m.body} />
          </div>
        </AssistantRow>
      );
  }
}

function UserBubble({ text, channel, time, faded }: { text: string; channel?: string; time?: string; faded?: boolean }) {
  const [main, ...attachments] = text.split(/\n\n(?=\[Attached dataset)/);
  return (
    <div className={cn("group flex animate-rise flex-col items-end gap-1", faded && "opacity-60")}>
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-overlay px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap text-fg shadow-[inset_0_1px_0_0_oklch(1_0_0/0.05)]">
        {main}
      </div>
      {attachments.map((a) => (
        <div key={a} className="max-w-[85%] truncate rounded-lg bg-white/[0.04] px-2.5 py-1 text-2xs text-fg-subtle">
          {a.replace(/^\[|\]$/g, "")}
        </div>
      ))}
      {(time || channel === "imessage") && (
        <div className="flex items-center gap-1.5 px-1 text-2xs text-fg-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {channel === "imessage" && (
            <>
              <IconMessage size={11} /> via iMessage ·
            </>
          )}
          {time}
        </div>
      )}
    </div>
  );
}

function AssistantRow({ children, showMark }: { children: React.ReactNode; showMark?: boolean }) {
  return (
    <div className="flex animate-rise gap-3">
      <div className="w-6 shrink-0 pt-0.5">
        {showMark && (
          <span className="grid size-6 place-items-center rounded-full bg-white/[0.05] text-fg">
            <Mark size={13} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function StatusLine({ m }: { m: Message }) {
  const { all } = useWorkloads();
  const w = all.find((x) => x.id === m.workloadId);
  const tone = w ? statusMeta(w.status).tone : "idle";
  return (
    <div className="flex animate-rise items-center gap-3 pl-9 text-sm">
      <Dot tone={tone} />
      <span className="min-w-0 flex-1 text-fg-subtle">{m.body}</span>
      {w && (
        <Link href={href(w)} className="group flex shrink-0 items-center gap-1 text-xs text-fg-faint transition-colors hover:text-fg-muted">
          Open
          <IconArrowRight size={12} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </Link>
      )}
      <span className="shrink-0 text-2xs text-fg-faint tabular">{clock(m.createdAt)}</span>
    </div>
  );
}

function WorkloadLink({ id }: { id: bigint }) {
  const { all } = useWorkloads();
  const w = all.find((x) => x.id === id);
  if (!w) return null;
  return (
    <Link href={href(w)} className="ml-auto text-fg-faint transition-colors hover:text-fg-muted">
      {w.title}
    </Link>
  );
}

function Thinking() {
  return (
    <AssistantRow showMark>
      <div className="flex h-6 items-center gap-2.5 text-sm">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-pulse rounded-full bg-fg-subtle"
              style={{ animationDelay: `${i * 160}ms`, animationDuration: "1.1s" }}
            />
          ))}
        </span>
        <span className="bg-[linear-gradient(90deg,var(--color-fg-faint),var(--color-fg-muted),var(--color-fg-faint))] bg-[length:200%_100%] bg-clip-text text-transparent [animation:shimmer_2.4s_linear_infinite]">
          Thinking
        </span>
      </div>
    </AssistantRow>
  );
}
