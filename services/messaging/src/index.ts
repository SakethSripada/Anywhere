/**
 * Anywhere ⇄ iMessage bridge (Photon Spectrum).
 *
 * Two loops share one process:
 *
 *  - Inbound: every iMessage that reaches our Photon line is forwarded to the
 *    control plane (`POST /v1/bridge/inbound`), which links numbers, runs the
 *    Nemotron agent turn and returns the reply we text back.
 *  - Outbound: the control plane enqueues notifications (progress, completion,
 *    budget alerts) in SpacetimeDB. We subscribe to the worker-only outbox view
 *    and deliver each one, marking it sent or failed through a reducer.
 *
 * Spectrum is the only SDK that can send on a Photon line, which is why this
 * small service exists separately from the Python control plane.
 */
import { createServer } from "node:http";
import { Spectrum, type Message, type Space } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { DbConnection, type Notification } from "@anywhere/stdb";

/* ── Configuration ─────────────────────────────────────────────────────── */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log("fatal", "config.missing", { name });
    process.exit(1);
  }
  return value;
}

const config = {
  projectId: required("SPECTRUM_PROJECT_ID"),
  projectSecret: required("SPECTRUM_PROJECT_SECRET"),
  controlUrl: (process.env.CONTROL_URL ?? "http://127.0.0.1:8000").replace(/\/$/, ""),
  bridgeSecret: required("MESSAGING_BRIDGE_SECRET"),
  stdbUri: (process.env.SPACETIME_HOST ?? "http://127.0.0.1:3000").replace(/^http/, "ws"),
  stdbDatabase: process.env.SPACETIME_DATABASE ?? "anywhere",
  stdbToken: required("SPACETIME_WORKER_TOKEN"),
  port: Number(process.env.PORT ?? 8787),
  turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS ?? 120_000),
};

const MAX_ATTEMPTS = 3;

/* ── Logging (one JSON object per line, matching the control plane) ───── */

function log(level: "info" | "warn" | "error" | "fatal", event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: "messaging", ...fields });
  (level === "info" ? console.log : console.error)(line);
}

/** Never log full phone numbers. */
function redact(handle: string): string {
  return handle.length > 4 ? `…${handle.slice(-4)}` : "…";
}

/* ── Health ────────────────────────────────────────────────────────────── */

const health = { spectrum: false, spacetime: false, lastInboundAt: 0, lastOutboundAt: 0 };

createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  const ok = health.spectrum && health.spacetime;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, ...health }));
}).listen(config.port, () => log("info", "health.listening", { port: config.port }));

/* ── Spectrum ──────────────────────────────────────────────────────────── */

const app = await Spectrum({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  providers: [imessage.config()],
  signal: AbortSignal.timeout(30_000),
});
const im = imessage(app);
health.spectrum = true;
log("info", "spectrum.ready");

/* ── Inbound ───────────────────────────────────────────────────────────── */

type InboundReply = { reply: string | null; duplicate?: boolean };

async function forward(handle: string, text: string, messageId: string): Promise<InboundReply> {
  const res = await fetch(`${config.controlUrl}/v1/bridge/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": config.bridgeSecret },
    body: JSON.stringify({ handle, text, message_id: messageId }),
    signal: AbortSignal.timeout(config.turnTimeoutMs),
  });
  if (!res.ok) throw new Error(`control plane returned ${res.status}`);
  return (await res.json()) as InboundReply;
}

function textOf(message: Message): string | null {
  const c = message.content;
  if (c.type === "text") return c.text;
  if (c.type === "markdown") return c.markdown;
  return null;
}

async function handleInbound(space: Space, message: Message) {
  const handle = message.sender?.id;
  const text = textOf(message)?.trim();
  if (!handle || !text) return;
  health.lastInboundAt = Date.now();
  log("info", "inbound.received", { handle: redact(handle), chars: text.length });

  await space.responding(async () => {
    try {
      const { reply, duplicate } = await forward(handle, text.slice(0, 4000), message.id);
      if (duplicate || !reply) return;
      await message.reply(reply);
    } catch (err) {
      log("error", "inbound.failed", { handle: redact(handle), error: String(err) });
      await message.reply("I hit a snag reaching Anywhere. Give it a moment and try again.");
    }
  });
}

// Messages within one conversation are handled in order; conversations run in parallel.
const chains = new Map<string, Promise<void>>();

async function inboundLoop() {
  for await (const [space, message] of app.messages) {
    if (message.direction !== "inbound") continue;
    const prev = chains.get(space.id) ?? Promise.resolve();
    const next = prev.then(() => handleInbound(space, message)).catch(() => {});
    chains.set(space.id, next);
    void next.finally(() => {
      if (chains.get(space.id) === next) chains.delete(space.id);
    });
  }
}

/* ── Outbound ──────────────────────────────────────────────────────────── */

const inFlight = new Set<bigint>();
/** The attempt number each notification's latest delivery started with, so a
 *  retry we schedule and a subscription event for the same row never both send. */
const startedAttempt = new Map<bigint, number>();
/** One iMessage space per handle, reused across notifications (two API calls saved per send). */
const spaces = new Map<string, Promise<Awaited<ReturnType<typeof im.space.create>>>>();

function spaceFor(handle: string) {
  let space = spaces.get(handle);
  if (!space) {
    space = im.user(handle).then((user) => im.space.create(user));
    spaces.set(handle, space);
  }
  return space;
}

async function deliver(conn: DbConnection, n: Notification) {
  if (n.channel !== "imessage" || inFlight.has(n.id)) return;
  if ((startedAttempt.get(n.id) ?? -1) >= n.attempts) return;
  inFlight.add(n.id);
  startedAttempt.set(n.id, n.attempts);
  let retry = false;
  try {
    // Back off on retries: 0s, 5s, 20s.
    if (n.attempts > 0) await new Promise((r) => setTimeout(r, 5_000 * 4 ** (n.attempts - 1)));
    try {
      await (await spaceFor(n.handle)).send(n.body);
    } catch (err) {
      spaces.delete(n.handle); // don't keep reusing a space that just failed
      throw err;
    }
    health.lastOutboundAt = Date.now();
    await conn.reducers.markNotification({ id: n.id, status: "sent" });
    startedAttempt.delete(n.id);
    log("info", "outbound.sent", { id: String(n.id), handle: redact(n.handle) });
  } catch (err) {
    const final = n.attempts + 1 >= MAX_ATTEMPTS;
    log(final ? "error" : "warn", "outbound.failed", { id: String(n.id), attempt: n.attempts + 1, error: String(err) });
    // Re-marking as pending keeps it in the outbox (and visible after a restart).
    await conn.reducers
      .markNotification({ id: n.id, status: final ? "failed" : "pending" })
      .catch((e: unknown) => log("error", "outbound.mark_failed", { id: String(n.id), error: String(e) }));
    if (final) startedAttempt.delete(n.id);
    retry = !final;
  } finally {
    inFlight.delete(n.id);
  }
  // Schedule the retry ourselves: the re-marked row is an update, not an insert,
  // and may never reach onInsert, which used to leave it stuck until a reconnect.
  if (retry) void deliver(conn, { ...n, attempts: n.attempts + 1 });
}

function connectSpacetime() {
  DbConnection.builder()
    .withUri(config.stdbUri)
    .withDatabaseName(config.stdbDatabase)
    .withToken(config.stdbToken)
    .withAutomaticReconnect()
    .onConnect((conn, identity) => {
      health.spacetime = true;
      log("info", "spacetime.connected", { identity: identity.toHexString().slice(0, 12) });
      conn.db.workerOutbox.onInsert((_ctx, row) => void deliver(conn, row));
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          for (const row of conn.db.workerOutbox.iter()) void deliver(conn, row);
        })
        .onError((ctx) => log("error", "spacetime.subscription_error", { error: String(ctx.event) }))
        .subscribe("SELECT * FROM worker_outbox");
    })
    .onDisconnect(() => {
      health.spacetime = false;
      log("warn", "spacetime.disconnected");
    })
    .onConnectError((_ctx, err) => {
      health.spacetime = false;
      log("error", "spacetime.connect_error", { error: String(err) });
    })
    .build();
}

/* ── Run ───────────────────────────────────────────────────────────────── */

connectSpacetime();

async function shutdown(signal: string) {
  log("info", "shutdown", { signal });
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await inboundLoop();
} catch (err) {
  log("fatal", "inbound.loop_crashed", { error: String(err) });
  process.exit(1);
}
