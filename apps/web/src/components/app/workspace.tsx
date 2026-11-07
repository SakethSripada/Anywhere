"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { useApi } from "@/lib/api";
import { useConversations, useMessages } from "@/lib/data";
import { reducers, useReducer } from "@/lib/stdb";
import { IconAgent, IconArrowUpRight, IconCube, IconDesktop, IconMessage, IconMore, IconTerminal, IconWorkload } from "../icons";
import { IconButton } from "../ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "../ui/menu";
import { toast } from "../ui/toast";
import { Composer, type ComposerHandle } from "./composer";
import { ComputeRail } from "./compute-rail";
import { Thread, type Pending } from "./thread";

const SUGGESTIONS: { icon: ReactNode; title: string; prompt: string }[] = [
  {
    icon: <IconCube size={15} />,
    title: "Model a game scene in Blender",
    prompt: "I want to create a low-poly 3D game scene in Blender. Set up a GPU desktop for me.",
  },
  {
    icon: <IconWorkload size={15} />,
    title: "Fine-tune a 7B model",
    prompt: "Fine-tune a 7B language model on my dataset and give me the adapter to download.",
  },
  {
    icon: <IconTerminal size={15} />,
    title: "GPU dev environment",
    prompt: "Set up a Linux development desktop with a GPU I can use for a few hours.",
  },
  {
    icon: <IconDesktop size={15} />,
    title: "Check on my machines",
    prompt: "What's running right now, and what has it cost so far?",
  },
];

export function Workspace({ conversationId }: { conversationId?: string }) {
  const cid = conversationId && /^\d+$/.test(conversationId) ? BigInt(conversationId) : null;
  const { messages, ready } = useMessages(cid);
  const { conversations } = useConversations();
  const conversation = cid == null ? null : conversations.find((c) => c.id === cid);
  const api = useApi();
  const router = useRouter();
  const composer = useRef<ComposerHandle>(null);
  const archive = useReducer(reducers.archiveConversation);
  const [optimistic, setPending] = useState<Pending[]>([]);
  // Optimistic bubbles disappear once the real message arrives over the subscription.
  const pending = optimistic.filter((x) => !messages.some((m) => m.role === "user" && m.body.startsWith(x.text)));

  async function submit(text: string, uploadIds: number[]) {
    const id = crypto.randomUUID();
    setPending((p) => [...p, { id, text, at: Date.now() }]);
    try {
      const res = await api.post<{ conversation_id: number }>("/v1/chat", {
        text,
        conversation_id: cid == null ? null : Number(cid),
        upload_ids: uploadIds,
      });
      if (cid == null) router.push(`/c/${res.conversation_id}`);
    } catch (err) {
      setPending((p) => p.filter((x) => x.id !== id));
      throw err;
    }
  }

  const empty = cid == null || (ready && messages.length === 0 && pending.length === 0 && !conversation);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {empty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-12 sm:px-6">
            <div className="w-full max-w-2xl">
              <h1 className="animate-rise text-center text-2xl font-semibold tracking-tighter text-fg sm:text-[2.125rem] sm:leading-tight">
                What do you want to do?
              </h1>
              <p className="mx-auto mt-3 max-w-md animate-rise text-center text-md text-fg-subtle [animation-delay:40ms]">
                Describe the outcome. Anywhere picks the hardware, sets it up, and can operate it for you.
              </p>
              <div className="mt-8 animate-rise [animation-delay:80ms]">
                <Composer ref={composer} onSubmit={submit} autoFocus size="hero" />
              </div>
              <div className="mt-4 grid animate-rise grid-cols-1 gap-2 [animation-delay:120ms] sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    onClick={() => composer.current?.fill(s.prompt)}
                    className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none shadow-[inset_0_0_0_1px_var(--color-line)] transition-[background-color,box-shadow] duration-150 hover:bg-hover hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus-ring"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle transition-colors group-hover:text-accent">
                      {s.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-muted group-hover:text-fg">{s.title}</span>
                    <IconArrowUpRight size={14} className="shrink-0 text-fg-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
              <p className="mt-8 text-center text-xs text-fg-faint">
                You’ll always see a cost estimate before anything is billed.
              </p>
            </div>
          </div>
        ) : (
          <>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-5">
              <h1 className="min-w-0 truncate text-sm font-medium text-fg">{conversation?.title ?? "Conversation"}</h1>
              {conversation?.channel === "imessage" && (
                <span className="flex items-center gap-1 rounded-[5px] bg-white/[0.05] px-1.5 py-0.5 text-2xs text-fg-subtle">
                  <IconMessage size={11} /> iMessage
                </span>
              )}
              {conversation?.channel === "mcp" && (
                <span className="flex items-center gap-1 rounded-[5px] bg-white/[0.05] px-1.5 py-0.5 text-2xs text-fg-subtle">
                  <IconAgent size={11} /> Agent
                </span>
              )}
              {conversation && (
                <MenuRoot>
                  <MenuTrigger render={<IconButton label="Conversation options" size="sm" className="ml-auto" />}>
                    <IconMore />
                  </MenuTrigger>
                  <MenuContent align="end" width="w-48">
                    <MenuItem
                      tone="danger"
                      onClick={async () => {
                        try {
                          await archive({ id: conversation.id });
                          router.push("/");
                        } catch (err) {
                          toast.error("Couldn't archive", String((err as Error).message ?? err));
                        }
                      }}
                    >
                      Archive conversation
                    </MenuItem>
                  </MenuContent>
                </MenuRoot>
              )}
            </header>
            <Thread messages={messages} pending={pending} />
            <div className="shrink-0 px-4 pb-4 sm:px-6 sm:pb-5">
              <div className="mx-auto w-full max-w-3xl">
                <Composer ref={composer} onSubmit={submit} autoFocus placeholder="Reply to Anywhere…" />
              </div>
            </div>
          </>
        )}
      </div>
      <ComputeRail />
    </div>
  );
}
