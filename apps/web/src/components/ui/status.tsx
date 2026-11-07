import { cn } from "@/lib/cn";
import { statusMeta, type Tone } from "@/lib/workloads";

const toneText: Record<Tone, string> = {
  ok: "text-ok",
  busy: "text-busy",
  wait: "text-wait",
  bad: "text-bad",
  idle: "text-idle",
  accent: "text-accent",
};

const toneBg: Record<Tone, string> = {
  ok: "bg-ok-soft",
  busy: "bg-busy-soft",
  wait: "bg-wait-soft",
  bad: "bg-bad-soft",
  idle: "bg-idle-soft",
  accent: "bg-accent-soft",
};

export function Dot({ tone, live, className }: { tone: Tone; live?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-1.5 shrink-0 rounded-full bg-current",
        toneText[tone],
        live && "animate-pulse-dot",
        className,
      )}
    />
  );
}

export function StatusPill({ status, className, label }: { status: string; className?: string; label?: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-2xs font-medium tracking-wide",
        toneBg[meta.tone],
        toneText[meta.tone],
        className,
      )}
    >
      <Dot tone={meta.tone} live={meta.live} />
      {label ?? meta.label}
    </span>
  );
}

export function Badge({ tone = "idle", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-2xs font-medium",
        toneBg[tone],
        toneText[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
