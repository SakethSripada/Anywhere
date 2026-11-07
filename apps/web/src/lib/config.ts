/** Public runtime configuration. Only non-secret values may live here. */
export const config = {
  /** SpacetimeDB host, e.g. wss://maincloud.spacetimedb.com or ws://localhost:3000. */
  spacetimeHost: process.env.NEXT_PUBLIC_SPACETIME_HOST ?? "ws://127.0.0.1:3000",
  spacetimeDatabase: process.env.NEXT_PUBLIC_SPACETIME_DATABASE ?? "anywhere",
  /** Control plane base URL. Same-origin `/api` in production (Caddy strips the prefix). */
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, ""),
};

/** WebSocket form of the control plane URL, resolved against the page origin. */
export function apiWsUrl(path: string): string {
  const base = new URL(config.apiUrl, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString().replace(/\/$/, "") + path;
}
