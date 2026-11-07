"use client";

import { useState } from "react";
import { useApi } from "./api";
import { useMessages } from "./data";

/**
 * Sending side of a conversation. Optimistic bubbles show until the real
 * message arrives over the SpacetimeDB subscription.
 */
export function useChat(conversationId: bigint | null, opts: { workloadId?: bigint } = {}) {
  const api = useApi();
  const { messages, ready } = useMessages(conversationId);
  const [optimistic, setOptimistic] = useState<{ id: string; text: string }[]>([]);
  const pending = optimistic.filter((x) => !messages.some((m) => m.role === "user" && m.body.startsWith(x.text)));

  async function send(text: string, uploadIds: number[] = []): Promise<number> {
    const id = crypto.randomUUID();
    setOptimistic((p) => [...p, { id, text }]);
    try {
      const res = await api.post<{ conversation_id: number }>("/v1/chat", {
        text,
        conversation_id: conversationId == null ? null : Number(conversationId),
        workload_id: opts.workloadId == null ? null : Number(opts.workloadId),
        upload_ids: uploadIds,
      });
      return res.conversation_id;
    } catch (err) {
      setOptimistic((p) => p.filter((x) => x.id !== id));
      throw err;
    }
  }

  return { messages, ready, pending, send };
}
