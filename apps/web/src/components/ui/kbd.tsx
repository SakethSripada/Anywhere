import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-[5px] px-1",
        "bg-white/[0.06] font-sans text-2xs font-medium text-fg-subtle",
        "shadow-[inset_0_-1px_0_0_oklch(1_0_0/0.06)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
