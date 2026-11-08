"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, ViewTransition, type ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useAccount } from "@/lib/data";
import { useSession } from "@/lib/stdb";
import { Onboarding } from "./onboarding";
import { isPublicPath } from "./providers";
import { AppSidebar } from "./sidebar";

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (isPublicPath(path)) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}

function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const { account, ready } = useAccount();
  const router = useRouter();

  // ⌘K / Ctrl+K starts a new task from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (!session.ready || !ready || !account?.activated) {
    return <Onboarding session={session} account={account} accountReady={ready} />;
  }

  return (
    <SidebarProvider className="h-full min-h-0">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <ViewTransition name="page">
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </ViewTransition>
      </SidebarInset>
    </SidebarProvider>
  );
}
