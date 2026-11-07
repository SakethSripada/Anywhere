import { cn } from "@/lib/utils";
import { statusMeta } from "@/lib/workloads";

/**
 * Status as a word, not a badge. Neutral by default; only work in progress
 * (shimmer) and failure (red) draw attention — the way Codex and Claude do it.
 */
export function StatusText({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span
      className={cn(
        "shrink-0 text-[13px] whitespace-nowrap",
        m.tone === "bad" ? "text-destructive" : m.live && status !== "running" ? "shimmer-text" : status === "running" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {m.label}
    </span>
  );
}

/** Back-compat alias used across screens. */
export const StatusBadge = StatusText;
