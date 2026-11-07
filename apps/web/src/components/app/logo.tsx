import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-background", className)}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
        <rect x="1.75" y="2.75" width="12.5" height="9" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M5 14.25h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.02em] group-data-[collapsible=icon]:hidden">Anywhere</span>
    </span>
  );
}
