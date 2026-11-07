"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAccount } from "@/lib/data";
import { useSession } from "@/lib/stdb";
import { MobileNavProvider } from "./mobile-nav";
import { Onboarding } from "./onboarding";
import { Sidebar } from "./sidebar";

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const { account, ready } = useAccount();
  const router = useRouter();

  // ⌘⇧O / Ctrl+Shift+O starts a new chat, as in ChatGPT.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
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
    <MobileNavProvider sidebar={(close) => <Sidebar onNavigate={close} />}>
      <div className="flex h-full">
        <aside className="hidden w-[260px] shrink-0 border-r border-sidebar-border md:block">
          <Sidebar />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
      </div>
    </MobileNavProvider>
  );
}
