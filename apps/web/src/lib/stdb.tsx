"use client";

import { DbConnection, reducers, tables } from "@anywhere/stdb";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { SpacetimeDBProvider, useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import { config } from "./config";

/*
 * One SpacetimeDB connection per tab. The identity token it is issued is
 * persisted locally and doubles as the bearer credential for the control
 * plane, so realtime reads and HTTP commands share a single identity.
 */

const TOKEN_KEY = `anywhere:token:${config.spacetimeDatabase}`;
/** The last token we gave up on, kept so a wrongly dropped account can be restored. */
const PREVIOUS_TOKEN_KEY = `${TOKEN_KEY}:previous`;
/** Consecutive rejections of the saved token in this tab (survives the reloads between them). */
const REJECTIONS_KEY = `${TOKEN_KEY}:rejections`;
/** Reload with the same token this many times, backing off, before starting a fresh identity. */
const MAX_REJECTIONS = 4;

function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string | undefined) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session simply won't persist */
  }
}

function readRejections(): number {
  try {
    return Number(sessionStorage.getItem(REJECTIONS_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeRejections(n: number) {
  try {
    if (n) sessionStorage.setItem(REJECTIONS_KEY, String(n));
    else sessionStorage.removeItem(REJECTIONS_KEY);
  } catch {
    /* without session storage every rejection counts as the first */
  }
}

/** The server refused the saved token itself (not a network error, timeout or 5xx). */
function isTokenRejected(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown } | null;
  return e?.name === "WebSocketTokenError" && (e.status === 401 || e.status === 403);
}

/**
 * The saved token was refused. A SpacetimeDB restart or proxy hiccup can
 * briefly answer 401 too, and a fresh identity is a new, empty account that
 * strands the old one's machines, so retry a few times with backoff first. When
 * it really is gone (e.g. after a database reset), keep it under
 * PREVIOUS_TOKEN_KEY so it can be put back by hand, then start over.
 */
function onTokenRejected(saved: string) {
  const n = readRejections() + 1;
  if (n < MAX_REJECTIONS) {
    writeRejections(n);
    setTimeout(() => window.location.reload(), 2000 * 2 ** (n - 1));
    return;
  }
  writeRejections(0);
  try {
    localStorage.setItem(PREVIOUS_TOKEN_KEY, saved);
  } catch {
    /* nowhere to keep it; the reset still has to happen */
  }
  writeToken(undefined);
  window.location.reload();
}

const noop = () => () => {};

/**
 * The connection only exists in the browser (it needs a WebSocket, a stored
 * token and a random connection id), so prerendering emits `fallback` and the
 * provider mounts on hydration.
 */
export function StdbProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const isClient = useSyncExternalStore(noop, () => true, () => false);
  return isClient ? <Connection>{children}</Connection> : fallback;
}

function Connection({ children }: { children: ReactNode }) {
  const [builder] = useState(() => {
    const saved = readToken();
    return DbConnection.builder()
      .withUri(config.spacetimeHost)
      .withDatabaseName(config.spacetimeDatabase)
      .withToken(saved)
      .withAutomaticReconnect()
      .onConnect((_conn, _identity, token) => {
        writeToken(token);
        writeRejections(0);
      })
      .onConnectError((_ctx, err, nextAttempt) => {
        // While the SDK is still retrying, or on any other failure (network,
        // timeout, server error), keep the token and let the error show.
        if (saved && nextAttempt === undefined && isTokenRejected(err)) onTokenRejected(saved);
      });
  });
  return <SpacetimeDBProvider connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

export type Session = {
  ready: boolean;
  identity: string | null;
  token: string | null;
  error: string | null;
};

export function useSession(): Session {
  const s = useSpacetimeDB();
  return useMemo(
    () => ({
      ready: s.isActive && !!s.identity,
      identity: s.identity ? s.identity.toHexString() : null,
      token: s.token ?? null,
      error: s.connectionError ? String(s.connectionError) : null,
    }),
    [s.isActive, s.identity, s.token, s.connectionError],
  );
}

export { reducers, tables, useReducer, useTable };
