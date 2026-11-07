import { cn } from "@/lib/utils";
import { statusMeta, type Tone } from "@/lib/workloads";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  busy: "bg-info",
  accent: "bg-info",
  wait: "bg-warning",
  bad: "bg-destructive",
  idle: "bg-faint",
};

const TEXT: Record<Tone, string> = {
  ok: "text-foreground",
  busy: "text-foreground",
  accent: "text-foreground",
  wait: "text-warning",
  bad: "text-destructive",
  idle: "text-muted-foreground",
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  const pulsing = m.live && status !== "running";
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {(pulsing || status === "running") && <span className={cn("absolute inset-0 rounded-full opacity-40", DOT[m.tone], pulsing ? "animate-ping" : "animate-pulse")} />}
      <span className={cn("relative size-2 rounded-full", DOT[m.tone])} />
    </span>
  );
}

/** The one status indicator: a dot and a word. Colour carries meaning only. */
export function StatusChip({ status, className, label }: { status: string; className?: string; label?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[13px] whitespace-nowrap", TEXT[m.tone], className)}>
      <StatusDot status={status} />
      {label ?? m.label}
    </span>
  );
}

export const StatusText = StatusChip;
export const StatusBadge = StatusChip;
