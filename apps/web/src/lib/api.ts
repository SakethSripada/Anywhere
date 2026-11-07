"use client";

import { useCallback, useMemo } from "react";
import { config } from "./config";
import { useSession } from "./stdb";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[] | null;

async function request<T>(path: string, init: RequestInit & { token: string | null; identity: string | null }): Promise<T> {
  const { token, identity, headers, ...rest } = init;
  if (!token) throw new ApiError("Still connecting — try again in a second", 0);
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(identity ? { "X-Anywhere-Identity": identity } : {}),
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
    });
  } catch {
    throw new ApiError("Anywhere's control plane is unreachable", 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : (body.detail?.[0]?.msg ?? detail);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(detail || `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

/** Authenticated control-plane client bound to the current SpacetimeDB identity. */
export function useApi() {
  const { token, identity } = useSession();

  const get = useCallback(<T,>(path: string) => request<T>(path, { method: "GET", token, identity }), [token, identity]);
  const post = useCallback(
    <T,>(path: string, body?: Json) =>
      request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), token, identity }),
    [token, identity],
  );

  const del = useCallback(<T,>(path: string) => request<T>(path, { method: "DELETE", token, identity }), [token, identity]);

  return useMemo(() => ({ get, post, del, ready: !!token }), [get, post, del, token]);
}

/** Unauthenticated probe used for the integrations panel and the offline banner. */
export async function fetchHealth(): Promise<{ ok: boolean; mode: string; integrations: Record<string, boolean> } | null> {
  try {
    const res = await fetch(`${config.apiUrl}/health`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export type UploadProfile = { rows: number; schema: string; [k: string]: unknown };

/** Presigned upload straight to object storage; the control plane only sees metadata. */
export async function uploadDataset(
  api: ReturnType<typeof useApi>,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ uploadId: number; profile: UploadProfile }> {
  const meta = { filename: file.name, content_type: file.type || "application/octet-stream", size: file.size };
  const { upload_id, put_url } = await api.post<{ upload_id: number; put_url: string }>("/v1/uploads", meta);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", put_url);
    xhr.setRequestHeader("Content-Type", meta.content_type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new ApiError("Upload was rejected by storage", xhr.status)));
    xhr.onerror = () => reject(new ApiError("Upload failed — check your connection", 0));
    xhr.send(file);
  });
  const done = await api.post<{ upload_id: number; profile: UploadProfile }>(`/v1/uploads/${upload_id}/complete`, meta);
  return { uploadId: done.upload_id, profile: done.profile };
}
