import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MobileNavTrigger } from "./mobile-nav";

/** The 52px bar at the top of every screen: title on the left, actions on the right. */
export function PageHeader({ title, children, className, leading }: { title: ReactNode; children?: ReactNode; className?: string; leading?: ReactNode }) {
  return (
    <header className={cn("flex h-13 shrink-0 items-center gap-2 px-3 sm:px-4", className)}>
      <MobileNavTrigger />
      {leading}
      <div className="min-w-0 flex-1 truncate text-[15px] font-medium">{title}</div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </header>
  );
}
