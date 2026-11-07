"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StdbProvider } from "@/lib/stdb";

function Booting() {
  return (
    <div className="grid h-full place-items-center">
      <span className="shimmer-text animate-in text-sm delay-300 duration-500 fade-in-0 fill-mode-both">Connecting</span>
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <StdbProvider fallback={<Booting />}>
        <TooltipProvider delay={300}>
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </StdbProvider>
    </ThemeProvider>
  );
}
