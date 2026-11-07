import { cn } from "@/lib/utils";

/** Anywhere's mark: a window frame with a cursor in transit — a computer, wherever you are. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-6 place-items-center rounded-[7px] bg-primary text-primary-foreground", className)}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
        <rect x="1.75" y="2.75" width="12.5" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5 14.25h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="m7 5.5 3.5 1.6-1.5.5-.6 1.6L7 5.5Z" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Anywhere</span>
    </span>
  );
}
