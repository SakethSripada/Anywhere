"use client";

import type { Workload } from "@anywhere/stdb";
import { MoreHorizontal, PanelRightClose } from "lucide-react";
import Link from "next/link";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { AgentOrb, type OrbState } from "@/components/bui/orb";
import { SuggestionChip } from "@/components/bui/tool-chips";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentState } from "@/lib/agent";
import { ApiError, useApi } from "@/lib/api";
import { toItems, useAgentBusy } from "@/lib/chat";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "../chat/composer";
import { Thread } from "../chat/thread";
import { appKey } from "../app/app-logo";

export type AgentPanelHandle = { focus(text?: string): void };

function suggestions(w: Workload, working: boolean): string[] {
  const running = w.status === "running";
  if (w.kind === "desktop") {
    if (w.status === "provisioning" || w.status === "configuring") return ["How long until it’s ready?"];
    if (!running) return ["Why isn’t this running?", "What did you do last time?"];
    if (working) return ["What are you doing?", "Save when you’re done"];
    return ["Model a low-poly tree in Blender", "What’s on screen?", "Save my project"];
  }
  const render = appKey(w) === "blender";
  if (w.status === "succeeded") return render ? ["Where are my frames?", "How long did each frame take?"] : ["Summarize the results", "How do I use the adapter?"];
  if (w.status === "failed") return ["Why did this fail?", "Retry on a bigger GPU"];
  return [render ? "How’s the render going?" : "How’s training going?", "Any errors in the logs?", "When will it finish?"];
}

const STATUS: Record<OrbState, string> = {
  working: "Driving the desktop",
  thinking: "Thinking",
  paused: "Paused, you have control",
  ready: "Ready",
  offline: "Machine isn’t running",
};

/** While the machine boots it isn't broken, just not ready yet. */
function statusText(state: OrbState, status: string) {
  if (state === "offline" && (status === "provisioning" || status === "configuring")) return "Waiting for the machine";
  return STATUS[state];
}

/**
 * The agent beside one machine: a single stream of the conversation, every
 * tool call, every desktop action and every machine event — then the prompt.
 */
/** What survives the panel being unmounted while collapsed: its conversation and
 *  any unsent text. Owned by the page so reopening the panel restores both. */
export type AgentPanelMemory = { cid: bigint | null; draft: string };

export const AgentPanel = forwardRef<
  AgentPanelHandle,
  { w: Workload; onCollapse?: () => void; memory?: MutableRefObject<AgentPanelMemory> }
>(function AgentPanel({ w, onCollapse, memory }, ref) {
  const api = useApi();
  const linked = w.conversationId > 0n ? w.conversationId : null;
  const [cid, setCid] = useState<bigint | null>(() => memory?.current.cid ?? linked);
  // Follow the workload when its linked conversation changes (or appears).
  const [seenLinked, setSeenLinked] = useState(linked);
  if (linked !== seenLinked) {
    setSeenLinked(linked);
    if (linked != null) setCid(linked);
  }
  const { messages, pending, send } = useChat(cid, { workloadId: w.id });
  const composer = useRef<ComposerHandle>(null);
  const agent = useAgentState(w);
  const items = useMemo(() => toItems(messages), [messages]);
  const thinking = useAgentBusy(items) || pending.length > 0;

  useEffect(() => {
    if (memory) memory.current.cid = cid;
  }, [cid, memory]);
  // Restore an unsent draft on mount; save it when the panel is unmounted. A layout
  // cleanup runs before the composer's own, while its handle is still attached.
  useLayoutEffect(() => {
    const store = memory?.current;
    const box = composer.current;
    if (store?.draft) box?.fill(store.draft);
    return () => {
      if (store) store.draft = box?.value() ?? "";
    };
  }, [memory]);

  useImperativeHandle(ref, () => ({
    focus: (text) => requestAnimationFrame(() => (text ? composer.current?.fill(text) : composer.current?.focus())),
  }));

  async function submit(text: string) {
    const id = await send(text);
    if (cid == null) setCid(BigInt(id));
  }

  async function stopAgent() {
    try {
      await api.post(`/v1/workloads/${w.id}/agent/stop`);
    } catch (err) {
      toast.error("Couldn’t stop the agent", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const state: OrbState = agent.working ? "working" : thinking ? "thinking" : agent.control === "paused" ? "paused" : w.status === "running" ? "ready" : "offline";
  const empty = messages.length === 0 && pending.length === 0 && agent.runs.length === 0;
  const busy = agent.working || thinking;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line pr-2.5 pl-5">
        <AgentOrb state={state} size={18} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink">Agent</span>
          <span className={cn("truncate text-[12px]", state === "working" || state === "thinking" ? "bui-shimmer" : "text-ink-3")}>{statusText(state, w.status)}</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" aria-label="Agent options" className="grid size-7 place-items-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2" />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {cid != null && <DropdownMenuItem render={<Link href={`/c/${cid}`} />}>Open full conversation</DropdownMenuItem>}
            <DropdownMenuItem disabled={!agent.working} onClick={() => void stopAgent()}>
              Stop the agent
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" aria-label="Hide agent" onClick={onCollapse} className="grid size-7 place-items-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2" />}
            >
              <PanelRightClose className="size-4" />
            </TooltipTrigger>
            <TooltipContent>
              Hide <span className="ml-1 opacity-60">⌘.</span>
            </TooltipContent>
          </Tooltip>
        )}
      </header>

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end px-5 pb-4" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <AgentOrb state={state} size={32} />
          <p className="mt-4 text-[13px] leading-[1.6] text-ink-2">{w.kind === "desktop" ? "No messages yet. Tell the agent what to do on this desktop." : "No messages yet. Ask about this job’s progress, logs or outputs."}</p>
        </div>
      ) : (
        <Thread messages={messages} pending={pending} busy={thinking} compact focus={w} className="min-h-0" />
      )}

      <div className="shrink-0 px-4 pt-2 pb-4">
        {!busy && (
          <div className="-mx-4 mb-2.5 flex gap-1.5 overflow-x-auto px-4 py-0.5 [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none]">
            {suggestions(w, agent.working).map((p) => (
              <SuggestionChip key={p} onClick={() => composer.current?.fill(p)}>
                {p}
              </SuggestionChip>
            ))}
          </div>
        )}
        <Composer
          ref={composer}
          compact
          allowAttachments={false}
          busy={agent.working}
          onStop={() => void stopAgent()}
          onSubmit={(t) => submit(t)}
          context={w.title}
          placeholder={w.kind === "desktop" ? (agent.working ? "Steer the agent…" : "Tell the agent what to do…") : "Ask about this job…"}
        />
      </div>
    </aside>
  );
});
