import { cn } from "@/lib/utils";
import { statusMeta, type Tone } from "@/lib/workloads";

const CHIP: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  busy: "bg-info-soft text-info",
  accent: "bg-info-soft text-info",
  wait: "bg-warning-soft text-warning",
  bad: "bg-destructive-soft text-destructive",
  idle: "bg-idle-soft text-muted-foreground",
};

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  busy: "bg-info",
  accent: "bg-info",
  wait: "bg-warning",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/60",
};

/**
 * The one status indicator used across the app. Colour always means the same
 * thing: emerald running, cobalt in progress, amber needs you, red failed,
 * grey idle. In-progress states pulse.
 */
export function StatusChip({ status, className, label }: { status: string; className?: string; label?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", CHIP[m.tone], className)}>
      <span className={cn("size-1.5 rounded-full", DOT[m.tone], m.live && status !== "running" && "animate-pulse")} />
      {label ?? m.label}
    </span>
  );
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[m.tone], m.live && status !== "running" && "animate-pulse", className)} />;
}

/** Plain-text status, for dense places like table cells inside sentences. */
export function StatusText({ status, className }: { status: string; className?: string }) {
  return <StatusChip status={status} className={className} />;
}

export const StatusBadge = StatusChip;
