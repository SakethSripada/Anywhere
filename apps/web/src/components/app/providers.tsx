"use client";

import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StdbProvider } from "@/lib/stdb";
import { TablesProvider } from "@/lib/tables";

function Booting() {
  return (
    <div className="grid h-full place-items-center">
      <span className="shimmer-text animate-in text-sm delay-300 duration-500 fade-in-0 fill-mode-both">Connecting</span>
    </div>
  );
}

/** Pages anyone with a link can open: no account, no SpacetimeDB session. */
export function isPublicPath(path: string | null) {
  return !!path?.startsWith("/watch/");
}

export function Providers({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (isPublicPath(path)) {
    return (
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <TooltipProvider delay={300}>{children}</TooltipProvider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <StdbProvider fallback={<Booting />}>
        <TablesProvider>
          <TooltipProvider delay={300}>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </TablesProvider>
      </StdbProvider>
    </ThemeProvider>
  );
}
