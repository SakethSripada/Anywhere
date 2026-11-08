import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center text-foreground", className)}>
      <svg viewBox="0 0 48 48" className="size-full" aria-hidden>
        <g stroke="currentColor" fill="currentColor" strokeWidth="2.4" strokeLinejoin="round">
          <path d="M15 6.5h26.5l-8.5 14.5H6.5z" />
          <path d="M15 27h26.5L33 41.5H6.5z" opacity="0.45" />
        </g>
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
