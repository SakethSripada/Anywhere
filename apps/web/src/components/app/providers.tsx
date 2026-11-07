"use client";

import type { ReactNode } from "react";
import { StdbProvider } from "@/lib/stdb";
import { Spinner } from "../ui/spinner";
import { Toaster } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";

function Booting() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex animate-fade-in flex-col items-center gap-4 text-fg-subtle [animation-delay:300ms] [animation-duration:400ms]">
        <Spinner size={18} />
        <span className="text-sm">Connecting</span>
      </div>
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <StdbProvider fallback={<Booting />}>
      <TooltipProvider>
        <Toaster>{children}</Toaster>
      </TooltipProvider>
    </StdbProvider>
  );
}
