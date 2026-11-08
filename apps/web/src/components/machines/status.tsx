import { cn } from "@/lib/utils";
import { statusMeta, type Tone } from "@/lib/workloads";

/*
 * Status is quiet by default. Healthy states get a small, softened dot and
 * plain text; colour is saved for what needs attention (waiting on you,
 * failed). Only in-progress states move, and only gently.
 */

const DOT: Record<Tone, string> = {
  ok: "bg-green/70",
  busy: "bg-ink-3",
  accent: "bg-ink-3",
  wait: "bg-warning",
  bad: "bg-red",
  idle: "bg-line-strong",
};

const TEXT: Record<Tone, string> = {
  ok: "text-ink-2",
  busy: "text-ink-2",
  accent: "text-ink-2",
  wait: "text-warning",
  bad: "text-red",
  idle: "text-ink-3",
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  const moving = m.live && status !== "running";
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT[m.tone], moving && "animate-pulse", className)} />;
}

/** Whether a status deserves to draw the eye (used to hide dots for healthy rows). */
export function needsAttention(status: string) {
  const t = statusMeta(status).tone;
  return t === "wait" || t === "bad" || t === "busy";
}

/** The one status indicator: a small dot and a word. */
export function StatusChip({ status, className, label }: { status: string; className?: string; label?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap", TEXT[m.tone], className)}>
      <StatusDot status={status} />
      {label ?? m.label}
    </span>
  );
}

export const StatusText = StatusChip;
export const StatusBadge = StatusChip;
