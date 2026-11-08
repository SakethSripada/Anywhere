"use client";

/* DEMO BRANCH ONLY: routes control-plane calls to the in-browser simulator. */
import { useMemo } from "react";
import { handBack, respond, startAgentRun, takeOver, workloadAction } from "./demo/sim";
import { insert, nextId, OWNER, rows, ts } from "./demo/store";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Body = Record<string, unknown> | null | undefined;

async function route<T>(method: string, path: string, body: Body): Promise<T> {
  await new Promise((r) => setTimeout(r, 180));
  const url = new URL(path, "http://demo");
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  if (p === "/v1/chat") {
    const focus = body?.workload_id != null ? BigInt(String(body.workload_id)) : null;
    let cid = body?.conversation_id != null ? BigInt(String(body.conversation_id)) : null;
    if (focus && !cid) cid = rows("myWorkloads").find((w) => w.id === focus)?.conversationId ?? null;
    if (!cid) {
      cid = nextId();
      const text = String(body?.text ?? "");
      insert("myConversations", { id: cid, owner: OWNER, title: text.slice(0, 60), channel: "web", archived: false, createdAt: ts(Date.now()), updatedAt: ts(Date.now()) });
    }
    insert("myMessages", { id: nextId(), conversationId: cid, owner: OWNER, role: "user", kind: "text", body: String(body?.text), workloadId: 0n, channel: "web", createdAt: ts(Date.now()) });
    void respond(cid, String(body?.text ?? ""), focus);
    return { conversation_id: Number(cid) } as T;
  }
  if ((m = p.match(/^\/v1\/workloads\/(\d+)\/agent\/(run|stop|resume)$/))) {
    const id = BigInt(m[1]);
    if (m[2] === "run") return { run_id: Number(await startAgentRun(id, String(body?.goal))) } as T;
    if (m[2] === "stop") takeOver(id);
    else handBack(id);
    return { ok: true } as T;
  }
  if ((m = p.match(/^\/v1\/workloads\/(\d+)\/(\w+)$/))) {
    workloadAction(BigInt(m[1]), m[2]);
    return { ok: true } as T;
  }
  if (p.match(/^\/v1\/desktops\/\d+\/session$/)) return { ticket: "demo" } as T;
  if (p === "/v1/files") throw new ApiError("Downloads are disabled in the demo", 403);
  if (p === "/v1/account/activate") return { ok: true } as T;
  if (p === "/v1/messaging/link") return { phone: body?.phone, anywhere_number: "+1 (415) 555-0199", deep_link_base: "#" } as T;
  if (p === "/v1/uploads") return { upload_id: Number(nextId()), put_url: "demo" } as T;
  if (p.match(/^\/v1\/uploads\/\d+\/complete$/)) return { upload_id: Number(nextId()), profile: { rows: 4200, schema: "messages" } } as T;
  throw new ApiError(`${method} ${p} isn’t available in the demo`, 404);
}

export function useApi() {
  return useMemo(
    () => ({
      get: <T,>(path: string, opts?: { signal?: AbortSignal }) => (void opts, route<T>("GET", path, null)),
      post: <T,>(path: string, body?: Body) => route<T>("POST", path, body),
      del: <T,>(path: string) => route<T>("DELETE", path, null),
      ready: true,
    }),
    [],
  );
}

export async function fetchHealth(signal?: AbortSignal) {
  void signal;
  return { ok: true, mode: "live", integrations: { spacetime: true, nemotron: true, brev: true, storage: true, photon: true } as Record<string, boolean> };
}

export type UploadProfile = { rows: number; schema: string; [k: string]: unknown };

export async function uploadDataset(api: ReturnType<typeof useApi>, file: File, onProgress: (f: number) => void, signal?: AbortSignal) {
  for (let i = 1; i <= 10; i++) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    await new Promise((r) => setTimeout(r, 120));
    onProgress(i / 10);
  }
  const rowsGuess = Math.max(200, Math.round(file.size / 1400));
  void api;
  return { uploadId: Number(nextId()), profile: { rows: rowsGuess, schema: "messages" } };
}
