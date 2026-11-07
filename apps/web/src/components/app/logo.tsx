import { cn } from "@/lib/utils";

/** Wordmark only. */
export function Logo({ className }: { className?: string }) {
  return <span className={cn("text-[15px] font-semibold tracking-[-0.01em]", className)}>Anywhere</span>;
}
