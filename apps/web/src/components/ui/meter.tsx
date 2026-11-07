import { cn } from "@/lib/cn";

/** A thin usage bar that warms from neutral to ember to red as it fills. */
export function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const tone = pct >= 0.9 ? "bg-bad" : pct >= 0.7 ? "bg-accent" : "bg-fg-muted";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("relative h-1 overflow-hidden rounded-full bg-white/[0.06]", className)}
    >
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500 ease-out", tone)}
        style={{ width: `${Math.max(pct * 100, value > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}
