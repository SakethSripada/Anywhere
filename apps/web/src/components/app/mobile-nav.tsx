"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";

/** Toggles the sidebar: collapse to icons on desktop, sheet on mobile. */
export function MobileNavTrigger() {
  return <SidebarTrigger className="-ml-1 text-muted-foreground" />;
}
