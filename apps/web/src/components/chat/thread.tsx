"use client";

import type { Message } from "@anywhere/stdb";
import { ArrowDown } from "lucide-react";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentBusy, toItems, type ChatItem } from "@/lib/chat";
import { useNow, useWorkloads } from "@/lib/data";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { href } from "@/lib/workloads";
import { Markdown } from "./markdown";
import { PlanCard, PlanRow } from "./plan-card";
import { ToolRun } from "./tool-run";

export type Pending = { id: string; text: string };

export function Thread({
  messages,
  pending,
  compact,
  className,
}: {
  messages: readonly Message[];
  pending: Pending[];
  compact?: boolean;
  className?: string;
}) {
  const items = useMemo(() => toItems(messages), [messages]);
  const now = useNow(1000);
  const busy = pending.length > 0 || agentBusy(items, now);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [items, pending.length, busy]);

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
        <div className={cn("mx-auto flex w-full flex-col", compact ? "gap-4 px-4 py-5" : "max-w-3xl gap-6 px-4 pt-8 pb-12 sm:px-6")}>
          {items.map((item) => (
            <Item key={item.key} item={item} compact={compact} />
          ))}
          {pending.map((p) => (
            <UserBubble key={p.id} text={p.text} compact={compact} />
          ))}
          {busy && <span className="shimmer-text w-fit text-[15px]">Thinking</span>}
        </div>
      </div>
      {!atBottom && (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Scroll to latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-sm"
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

function Item({ item, compact }: { item: ChatItem; compact?: boolean }) {
  switch (item.type) {
    case "user":
      return <UserBubble text={item.m.body} channel={item.m.channel} time={clock(item.m.createdAt)} compact={compact} />;
    case "tools":
      return <ToolRun calls={item.calls} />;
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
      return <StatusLine m={item.m} />;
    case "error":
      return (
        <Markdown text={item.m.body} className={cn("text-destructive", compact && "text-sm leading-6")} />
      );
    case "agent":
      return (
        <div>
          <div className="mb-1 text-sm text-muted-foreground">Desktop task finished</div>
          <Markdown text={item.m.body} className={compact ? "text-sm leading-6" : undefined} />
        </div>
      );
    default:
      return <Markdown text={item.m.body} className={compact ? "text-sm leading-6" : undefined} />;
  }
}

function UserBubble({ text, channel, time, compact }: { text: string; channel?: string; time?: string; compact?: boolean }) {
  const [main, ...attachments] = text.split(/\n\n(?=\[Attached dataset)/);
  return (
    <div className="group flex flex-col items-end gap-1">
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap sm:max-w-[70%]",
          compact ? "text-sm leading-6" : "text-[15px] leading-7",
        )}
      >
        {main}
      </div>
      {attachments.map((a) => (
        <div key={a} className="max-w-[85%] truncate rounded-xl border px-3 py-1.5 text-xs text-muted-foreground">
          {a.replace(/^\[|\]$/g, "")}
        </div>
      ))}
      {(time || channel === "imessage") && (
        <div className="flex items-center gap-1 px-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {channel === "imessage" && "Sent from iMessage · "}
          {time}
        </div>
      )}
    </div>
  );
}

function StatusLine({ m }: { m: Message }) {
  const { all } = useWorkloads();
  const w = all.find((x) => x.id === m.workloadId);
  return (
    <div className="flex items-baseline gap-3 text-sm text-muted-foreground">
      <span className="min-w-0 flex-1">{m.body}</span>
      {w && (
        <Link href={href(w)} className="shrink-0 text-foreground/80 underline-offset-4 hover:text-foreground hover:underline">
          Open
        </Link>
      )}
    </div>
  );
}
