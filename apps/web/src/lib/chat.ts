import type { Message } from "@anywhere/stdb";
import { useEffect, useState } from "react";

/** One agent tool invocation, assembled from its tool_call and tool_result messages. */
export type ToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  workloadId: bigint;
  startedAt: Message["createdAt"];
  result?: { ok: boolean; output: string; ms: number };
};

export type ChatItem =
  | { type: "user"; key: string; m: Message }
  | { type: "text"; key: string; m: Message }
  | { type: "error"; key: string; m: Message }
  | { type: "plan"; key: string; m: Message }
  | { type: "status"; key: string; m: Message }
  | { type: "agent"; key: string; m: Message }
  | { type: "image"; key: string; m: Message }
  | { type: "tools"; key: string; calls: ToolCall[] };

function parse(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Turn the flat message log into render items. Consecutive tool calls collapse
 * into one run; results attach to their call by id even if they arrive late.
 */
export function toItems(messages: readonly Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, ToolCall>();

  for (const m of messages) {
    const key = String(m.id);
    if (m.kind === "tool_call") {
      const body = parse(m.body);
      if (!body) continue;
      const call: ToolCall = {
        callId: String(body.call_id),
        name: String(body.name),
        args: (body.args as Record<string, unknown>) ?? {},
        workloadId: m.workloadId,
        startedAt: m.createdAt,
      };
      calls.set(call.callId, call);
      const last = items.at(-1);
      if (last?.type === "tools") last.calls.push(call);
      else items.push({ type: "tools", key, calls: [call] });
      continue;
    }
    if (m.kind === "tool_result") {
      const body = parse(m.body);
      const call = body && calls.get(String(body.call_id));
      if (call && body) call.result = { ok: Boolean(body.ok), output: String(body.output ?? ""), ms: Number(body.ms ?? 0) };
      continue;
    }
    if (m.role === "user") items.push({ type: "user", key, m });
    else if (m.kind === "plan") items.push({ type: "plan", key, m });
    else if (m.kind === "status") items.push({ type: "status", key, m });
    else if (m.kind === "error") items.push({ type: "error", key, m });
    else if (m.kind === "agent") items.push({ type: "agent", key, m });
    else if (m.kind === "image") items.push({ type: "image", key, m });
    else items.push({ type: "text", key, m });
  }
  return items;
}

const BUSY_TIMEOUT = 180_000;

/**
 * When the agent stops counting as mid-turn (epoch ms), or null if it isn't:
 * the last thing said was the user's, or a tool is running, for up to 3 minutes.
 */
export function busyDeadline(items: readonly ChatItem[]): number | null {
  const last = items.at(-1);
  if (!last) return null;
  // After tools the model always writes a reply, so a trailing tool run means "still working".
  const at = last.type === "tools" ? last.calls.at(-1)!.startedAt : last.type === "user" ? last.m.createdAt : null;
  return at ? Number(at.toMillis()) + BUSY_TIMEOUT : null;
}

/**
 * True while the agent is still mid-turn (see busyDeadline). No ticking clock:
 * one timer fires at the deadline instead of re-rendering every second.
 */
export function useAgentBusy(items: readonly ChatItem[]): boolean {
  const deadline = busyDeadline(items);
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (deadline == null) return;
    const t = setTimeout(() => setPassed(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
  }, [deadline]);
  return deadline != null && passed !== deadline;
}

export function parseOutput(output: string): Record<string, unknown> | null {
  return parse(output);
}

/** A picture message (a render or a texted screenshot): body is {url, caption, viewer}. */
export function parseImage(body: string): { url: string; caption: string; viewer: string } | null {
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    return typeof v.url === "string" ? { url: v.url, caption: String(v.caption ?? ""), viewer: String(v.viewer ?? "") } : null;
  } catch {
    return null;
  }
}
