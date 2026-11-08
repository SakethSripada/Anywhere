"use client";

import { useMemo, useState } from "react";
import { useApi } from "./api";
import { useMessages } from "./data";

/** The server stores the trimmed text, plus one line per attached dataset. */
const isEcho = (body: string, text: string) => body === text || body.startsWith(`${text}\n\n[Attached dataset: `);

type Optimistic = { id: string; text: string; after: bigint };

/**
 * Sending side of a conversation. Optimistic bubbles show until the real
 * message arrives over the SpacetimeDB subscription.
 */
export function useChat(conversationId: bigint | null, opts: { workloadId?: bigint } = {}) {
  const api = useApi();
  const { messages, ready } = useMessages(conversationId);
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);

  // Each bubble is answered by one user message created after it was sent
  // (message ids only grow) with the same text; earlier messages with equal or
  // prefixing text, or one already claimed by another bubble, don't count.
  const matched = useMemo(() => {
    const done = new Map<string, bigint>(); // bubble id -> message id
    if (!optimistic.length) return done;
    const claimed = new Set<bigint>();
    for (const x of optimistic) {
      const m = messages.find((m) => m.role === "user" && m.id > x.after && !claimed.has(m.id) && isEcho(m.body, x.text));
      if (m) {
        claimed.add(m.id);
        done.set(x.id, m.id);
      }
    }
    return done;
  }, [messages, optimistic]);
  const pending = matched.size ? optimistic.filter((x) => !matched.has(x.id)) : optimistic;

  // Forget bubbles once their real message has arrived. A remaining bubble with
  // the same text must not later claim that message, so move its floor past it.
  // (State adjusted during render, React's pattern for state derived from props.)
  if (matched.size) {
    const floor = new Map<string, bigint>();
    for (const x of optimistic) {
      const mid = matched.get(x.id);
      if (mid !== undefined && mid > (floor.get(x.text) ?? 0n)) floor.set(x.text, mid);
    }
    setOptimistic(
      optimistic
        .filter((x) => !matched.has(x.id))
        .map((x) => {
          const f = floor.get(x.text);
          return f !== undefined && f > x.after ? { ...x, after: f } : x;
        }),
    );
  }

  async function send(text: string, uploadIds: number[] = []): Promise<number> {
    const id = crypto.randomUUID();
    const after = messages.reduce((max, m) => (m.id > max ? m.id : max), 0n);
    setOptimistic((p) => [...p, { id, text: text.trim(), after }]);
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
