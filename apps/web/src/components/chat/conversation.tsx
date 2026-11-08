"use client";

import { Archive, MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useConversations } from "@/lib/data";
import { reducers, useReducer } from "@/lib/stdb";
import { useChat } from "@/lib/use-chat";
import { PageHeader } from "../app/page-header";
import { Composer, type ComposerHandle } from "./composer";
import { ContextPanel } from "./context-panel";
import { Thread } from "./thread";


export function Conversation({ conversationId }: { conversationId?: string }) {
  const cid = conversationId && /^\d+$/.test(conversationId) ? BigInt(conversationId) : null;
  const { messages, ready, pending, send } = useChat(cid);
  const { conversations } = useConversations();
  const conversation = cid == null ? null : conversations.find((c) => c.id === cid);
  const router = useRouter();
  const composer = useRef<ComposerHandle>(null);
  const archive = useReducer(reducers.archiveConversation);

  async function submit(text: string, uploadIds: number[]) {
    const id = await send(text, uploadIds);
    if (cid == null) router.push(`/c/${id}`);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader title={conversation?.title ?? (ready ? "New task" : "")} className="border-b">
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
        <Composer ref={composer} onSubmit={submit} autoFocus compact placeholder="Reply, or ask for changes to the plan…" />
      </div>
      </div>
      <ContextPanel conversationId={cid} />
    </div>
  );
}
