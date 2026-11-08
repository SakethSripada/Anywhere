import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { MobileNavTrigger } from "./mobile-nav";

/** The 48px bar at the top of every screen. */
export function PageHeader({ title, children, className, leading }: { title: ReactNode; children?: ReactNode; className?: string; leading?: ReactNode }) {
  return (
    <header className={cn("flex h-12 shrink-0 items-center gap-2 border-b px-3", className)}>
      <MobileNavTrigger />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      {leading}
      <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </header>
  );
}
