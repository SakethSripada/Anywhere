"use client";

import type { Workload } from "@anywhere/stdb";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, useApi } from "@/lib/api";
import { tables, useTable } from "@/lib/stdb";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "../chat/composer";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Thread } from "../chat/thread";
import { EventFeed } from "./shared";

const PROMPTS: Record<string, string[]> = {
  desktop: ["Open Blender and model a simple low-poly tree", "What’s on the screen right now?", "Save my project"],
  batch: ["How is training going?", "Any errors in the logs?", "What will I get when it finishes?"],
};

/** Chat with the agent about this machine. Continues the conversation that created it. */
export function AgentSidebar({ w }: { w: Workload }) {
  const [cid, setCid] = useState<bigint | null>(w.conversationId > 0n ? w.conversationId : null);
  const { messages, pending, send } = useChat(cid, { workloadId: w.id });
  const composer = useRef<ComposerHandle>(null);
  const live = w.status === "running" || w.status === "saving";
  const [tab, setTab] = useState<"agent" | "activity">("agent");

  async function submit(text: string) {
    const id = await send(text);
    if (cid == null) setCid(BigInt(id));
  }

  return (
    <aside className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-end border-b px-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "agent" | "activity")} className="gap-0">
          <TabsList variant="line" className="h-12 border-0">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "activity" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <EventFeed workloadId={w.id} />
        </div>
      )}

      {tab === "agent" && w.kind === "desktop" && <LiveRunBanner w={w} />}

      {tab !== "agent" ? null : messages.length === 0 && pending.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-4">
          <p className="mb-3 text-sm leading-6 text-muted-foreground">
            {w.kind === "desktop"
              ? "Ask the agent to work in this desktop — it clicks, types and checks its work while you watch. Or ask anything about it."
              : "Ask about progress, errors or results. The agent reads this job’s live metrics and logs."}
          </p>
          {(PROMPTS[w.kind] ?? []).map((p) => (
            <button
              key={p}
              type="button"
              disabled={w.kind === "desktop" && !live && p.startsWith("Open")}
              onClick={() => composer.current?.fill(p)}
              className="rounded-lg px-3 py-2 text-left text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {p}
            </button>
          ))}
        </div>
      ) : (
        <Thread messages={messages} pending={pending} compact />
      )}

      <div className={cn("shrink-0 p-3 pt-0", tab !== "agent" && "hidden")}>
        <Composer
          ref={composer}
          compact
          allowAttachments={false}
          onSubmit={(t) => submit(t)}
          placeholder={w.kind === "desktop" ? "Tell the agent what to do here…" : "Ask about this job…"}
        />
      </div>
    </aside>
  );
}

function LiveRunBanner({ w }: { w: Workload }) {
  const api = useApi();
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const run = useMemo(
    () => runs.filter((r) => r.workloadId === w.id && r.status === "running").sort((a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis()))[0],
    [runs, w.id],
  );
  const last = useMemo(() => (run ? steps.filter((s) => s.runId === run.id).sort((a, b) => b.seq - a.seq)[0] : undefined), [steps, run]);
  if (!run || w.controller !== "agent") return null;

  async function takeOver() {
    try {
      await api.post(`/v1/workloads/${w.id}/agent/stop`);
    } catch (err) {
      toast.error("Couldn’t take over", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{run.goal}</div>
        <div className="truncate text-xs">
          <span className="shimmer-text">Working</span>
          {last && <span className="text-muted-foreground"> · {last.summary}</span>}
        </div>
      </div>
      <Button size="xs" variant="outline" onClick={takeOver}>
        Take over
      </Button>
    </div>
  );
}
