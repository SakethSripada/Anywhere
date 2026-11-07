"use client";

import { Archive, MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAccount, useConversations } from "@/lib/data";
import { reducers, useReducer } from "@/lib/stdb";
import { useChat } from "@/lib/use-chat";
import { PageHeader } from "../app/page-header";
import { Composer, type ComposerHandle } from "./composer";
import { Thread } from "./thread";

const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Blender desktop", prompt: "Set up a GPU desktop with Blender so I can build a low-poly 3D game scene." },
  { label: "Fine-tune a 7B model", prompt: "Fine-tune a 7B language model on my dataset and give me the adapter to download." },
  { label: "GPU dev box", prompt: "Set up a Linux development desktop with a GPU I can use for a few hours." },
  { label: "What’s running?", prompt: "What's running right now, and what has it cost so far?" },
];

export function Conversation({ conversationId }: { conversationId?: string }) {
  const cid = conversationId && /^\d+$/.test(conversationId) ? BigInt(conversationId) : null;
  const { messages, ready, pending, send } = useChat(cid);
  const { conversations } = useConversations();
  const { account } = useAccount();
  const conversation = cid == null ? null : conversations.find((c) => c.id === cid);
  const router = useRouter();
  const composer = useRef<ComposerHandle>(null);
  const archive = useReducer(reducers.archiveConversation);

  async function submit(text: string, uploadIds: number[]) {
    const id = await send(text, uploadIds);
    if (cid == null) router.push(`/c/${id}`);
  }

  const empty = cid == null || (ready && messages.length === 0 && pending.length === 0 && !conversation);

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-10 sm:px-6">
          <h1 className="mb-8 text-center text-[28px] font-semibold tracking-[-0.02em]">
            {account ? `What should we run, ${account.displayName.split(" ")[0]}?` : "What should we run?"}
          </h1>
          <Composer ref={composer} onSubmit={submit} autoFocus />
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s.label}
                variant="outline"
                className="h-9 rounded-full px-4 font-normal text-muted-foreground hover:text-foreground"
                onClick={() => composer.current?.fill(s.prompt)}
              >
                {s.label}
              </Button>
            ))}
          </div>
          <p className="mt-10 text-center text-xs text-muted-foreground">
            Anywhere always shows a cost estimate and asks before anything is billed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={conversation?.title ?? "Conversation"}>
        {conversation && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Conversation options" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await archive({ id: conversation.id });
                    router.push("/");
                  } catch (err) {
                    toast.error("Couldn’t archive", { description: String((err as Error).message ?? err) });
                  }
                }}
              >
                <Archive /> Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </PageHeader>
      <Thread messages={messages} pending={pending} />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 sm:px-6">
        <Composer ref={composer} onSubmit={submit} autoFocus placeholder="Reply to Anywhere…" />
        <p className="mt-2 text-center text-xs text-muted-foreground">Anywhere asks before spending money. Check plans before approving.</p>
      </div>
    </div>
  );
}
