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
    <MobileNavProvider sidebar={(close) => <Sidebar onNavigate={close} />}>
      <div className="flex h-full bg-canvas">
        <aside className="hidden w-[248px] shrink-0 md:block">
          <Sidebar />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-xl md:shadow-(--shadow-sheet)">{children}</div>
        </main>
      </div>
    </MobileNavProvider>
  );
}
