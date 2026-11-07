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
      .onConnect((_conn, _identity, token) => writeToken(token))
      .onConnectError((_ctx, err) => {
        // A token minted by a different issuer (e.g. after a database reset)
        // is rejected outright; drop it once and start a fresh identity.
        if (saved && /401|unauthor|token/i.test(String(err))) {
          writeToken(undefined);
          window.location.reload();
        }
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
