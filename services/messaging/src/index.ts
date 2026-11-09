/**
 * Anywhere ⇄ iMessage bridge (Photon Spectrum).
 *
 * Two loops share one process:
 *
 *  - Inbound: every iMessage that reaches our Photon line is forwarded to the
 *    control plane (`POST /v1/bridge/inbound`), which links numbers and runs the
 *    Nemotron agent turn. A quick turn's reply comes back inline; a long one is
 *    acked (`queued`) and its reply arrives later through the outbox.
 *  - Outbound: the control plane enqueues notifications (progress, completion,
 *    budget alerts) in SpacetimeDB. We subscribe to the worker-only outbox view
 *    and deliver each one, marking it sent or failed through a reducer.
 *
 * Spectrum is the only SDK that can send on a Photon line, which is why this
 * small service exists separately from the Python control plane.
 */
import { createServer } from "node:http";
import { Spectrum, attachment, type Message, type Space } from "@spectrum-ts/core";
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
/** Retry delays are 5s, 20s, … but never longer than this. */
const MAX_RETRY_DELAY_MS = 60_000;
/** How long SpacetimeDB may stay unreachable before we exit and let Docker restart us. */
const MAX_OFFLINE_MS = 5 * 60_000;

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

type InlineAttachment = { name: string; mime_type: string; data_base64: string };
/** `queued`: the turn is still running; its reply comes through the outbox, not here. */
type InboundReply = {
  reply: string | null;
  duplicate?: boolean;
  queued?: boolean;
  attachments?: InlineAttachment[];
};

async function forward(handle: string, text: string, messageId: string): Promise<InboundReply> {
  const res = await fetch(`${config.controlUrl}/v1/bridge/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": config.bridgeSecret },
    body: JSON.stringify({ handle, text, message_id: messageId }),
    signal: AbortSignal.timeout(config.turnTimeoutMs),
  });
  // Rate limits carry a message meant for the person texting; pass it on.
  if (res.status === 429) {
    const detail = ((await res.json().catch(() => ({}))) as { detail?: unknown }).detail;
    return { reply: typeof detail === "string" ? detail : "Slow down a little and try again in a moment." };
  }
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
      const { reply, duplicate, queued, attachments } = await forward(handle, text.slice(0, 4000), message.id);
      if (duplicate) return;
      if (reply) await message.reply(reply);
      if (queued) log("info", "inbound.queued", { handle: redact(handle) });
      // Pictures the agent took this turn (e.g. "send me a screenshot") follow the text.
      for (const a of attachments ?? []) {
        try {
          const bytes = Buffer.from(a.data_base64, "base64");
          await space.send(attachment(bytes, { name: a.name, mimeType: a.mime_type }));
          log("info", "inbound.attachment_sent", { handle: redact(handle), bytes: bytes.length });
        } catch (err) {
          log("warn", "inbound.attachment_failed", { handle: redact(handle), error: String(err) });
        }
      }
    } catch (err) {
      log("error", "inbound.failed", { handle: redact(handle), error: String(err) });
      await message.reply("I hit a snag reaching Anywhere. Give it a moment and try again.");
    }
  });
}

// Messages within one conversation are handled in order; conversations run in parallel.
const chains = new Map<string, Promise<void>>();

async function inboundLoop() {
  // The stream ending means Spectrum stopped delivering; the caller exits so Docker restarts us.
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
/** Notifications whose text already went out. A failed `sent` mark (say, a dropped
 *  connection) must only retry the mark, never the text, or people get duplicates. */
const sentIds = new Set<bigint>();
const MAX_SENT_IDS = 5_000;

function rememberSent(id: bigint) {
  sentIds.add(id);
  // Sets iterate in insertion order, so this drops the oldest.
  for (const old of sentIds) {
    if (sentIds.size <= MAX_SENT_IDS) break;
    sentIds.delete(old);
  }
}
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

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 4 ** (attempt - 1));
}

/** Mark a delivered notification sent, retrying only the mark until it lands. */
async function markSent(conn: DbConnection, id: bigint) {
  for (let attempt = 1; ; attempt++) {
    try {
      await conn.reducers.markNotification({ id, status: "sent" });
      return;
    } catch (err) {
      log("warn", "outbound.mark_failed", { id: String(id), attempt, error: String(err) });
      if (attempt >= MAX_ATTEMPTS) return; // still pending; the next outbox scan retries the mark
      await new Promise((r) => setTimeout(r, retryDelay(attempt)));
    }
  }
}

async function deliver(conn: DbConnection, n: Notification) {
  if (n.channel !== "imessage" || inFlight.has(n.id)) return;
  if (sentIds.has(n.id)) {
    // Already texted; the row is only still pending because its mark didn't land.
    inFlight.add(n.id);
    await markSent(conn, n.id).finally(() => inFlight.delete(n.id));
    return;
  }
  if ((startedAttempt.get(n.id) ?? -1) >= n.attempts) return;
  if (n.attempts >= MAX_ATTEMPTS) {
    // Out of attempts (e.g. after crash loops): give up now instead of waiting out a backoff.
    await conn.reducers
      .markNotification({ id: n.id, status: "failed" })
      .catch((e: unknown) => log("error", "outbound.mark_failed", { id: String(n.id), error: String(e) }));
    return;
  }
  inFlight.add(n.id);
  startedAttempt.set(n.id, n.attempts);
  let retry = false;
  try {
    // Back off on retries: 0s, 5s, 20s, capped at a minute.
    if (n.attempts > 0) await new Promise((r) => setTimeout(r, retryDelay(n.attempts)));
    try {
      await (await spaceFor(n.handle)).send(n.body);
    } catch (err) {
      spaces.delete(n.handle); // don't keep reusing a space that just failed
      throw err;
    }
    rememberSent(n.id);
    health.lastOutboundAt = Date.now();
    startedAttempt.delete(n.id);
    log("info", "outbound.sent", { id: String(n.id), handle: redact(n.handle) });
    // The text is out; a picture (a render's first frame) follows on a best-effort basis
    // so a failed image never re-sends the text.
    void sendAttachment(n).catch((err: unknown) =>
      log("warn", "outbound.attachment_failed", { id: String(n.id), error: String(err) }),
    );
    await markSent(conn, n.id);
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

type AttachmentInfo = { url: string; name: string; mime_type: string };

async function sendAttachment(n: Notification) {
  const res = await fetch(`${config.controlUrl}/v1/bridge/notifications/${n.id}/attachment`, {
    headers: { "x-bridge-secret": config.bridgeSecret },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`control plane returned ${res.status}`);
  const info = (await res.json()) as AttachmentInfo;
  const file = await fetch(info.url, { signal: AbortSignal.timeout(30_000) });
  if (!file.ok) throw new Error(`storage returned ${file.status}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  await (await spaceFor(n.handle)).send(attachment(bytes, { name: info.name, mimeType: info.mime_type }));
  log("info", "outbound.attachment_sent", { id: String(n.id), bytes: bytes.length });
}

function watchOutbox(conn: DbConnection) {
  conn.db.workerOutbox.onInsert((_ctx, row) => void deliver(conn, row));
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      for (const row of conn.db.workerOutbox.iter()) void deliver(conn, row);
    })
    .onError((ctx) => log("error", "spacetime.subscription_error", { error: String(ctx.event) }))
    .subscribe("SELECT * FROM worker_outbox");
}

let initialRetry = 0;
let offlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Without SpacetimeDB we can't deliver anything, so a long outage restarts the process. */
function goneOffline() {
  health.spacetime = false;
  offlineTimer ??= setTimeout(() => {
    log("fatal", "spacetime.unreachable", { forMs: MAX_OFFLINE_MS });
    process.exit(1);
  }, MAX_OFFLINE_MS);
}

function backOnline() {
  health.spacetime = true;
  clearTimeout(offlineTimer);
  offlineTimer = undefined;
}

function connectSpacetime() {
  let connected = false;
  DbConnection.builder()
    .withUri(config.stdbUri)
    .withDatabaseName(config.stdbDatabase)
    .withToken(config.stdbToken)
    .withAutomaticReconnect()
    .onConnect((conn, identity) => {
      connected = true;
      initialRetry = 0;
      backOnline();
      log("info", "spacetime.connected", { identity: identity.toHexString().slice(0, 12) });
      watchOutbox(conn);
    })
    // Reconnects keep the handlers and replay the subscription (onApplied re-scans the
    // outbox), but they call this instead of onConnect, so health must be restored here.
    .onAutomaticReconnect(() => {
      backOnline();
      log("info", "spacetime.reconnected");
    })
    // `nextAttempt` is undefined when the SDK has given up on this connection for good.
    .onDisconnect((_ctx, err, nextAttempt) => {
      goneOffline();
      log("warn", "spacetime.disconnected", { error: err ? String(err) : undefined, nextAttempt });
      if (nextAttempt === undefined) {
        log("fatal", "spacetime.connection_lost");
        process.exit(1);
      }
    })
    .onConnectError((_ctx, err, nextAttempt) => {
      goneOffline();
      log("error", "spacetime.connect_error", { error: String(err), nextAttempt });
      if (connected) {
        if (nextAttempt === undefined) {
          log("fatal", "spacetime.connection_lost");
          process.exit(1);
        }
        return;
      }
      // The SDK never retries a failed *first* connection (SpacetimeDB down at boot), so we
      // do, until MAX_OFFLINE_MS runs out.
      const delay = Math.min(30_000, 1_000 * 2 ** initialRetry++);
      setTimeout(connectSpacetime, delay);
    })
    .build();
}

/* ── Run ───────────────────────────────────────────────────────────────── */

goneOffline();
connectSpacetime();

let stopping = false;
async function shutdown(signal: string) {
  stopping = true;
  log("info", "shutdown", { signal });
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Either way the bridge is deaf without the loop; exit so `restart: unless-stopped` recovers it.
try {
  await inboundLoop();
  if (!stopping) log("fatal", "inbound.loop_ended");
} catch (err) {
  if (!stopping) log("fatal", "inbound.loop_crashed", { error: String(err) });
}
health.spectrum = false;
if (!stopping) process.exit(1);
