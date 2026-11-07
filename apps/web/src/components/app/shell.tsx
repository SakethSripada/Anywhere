"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useAccount } from "@/lib/data";
import { useSession } from "@/lib/stdb";
import { IconClose, IconSidebar, Mark } from "../icons";
import { IconButton } from "../ui/button";
import { Onboarding } from "./onboarding";
import { Sidebar } from "./sidebar";

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const { account, ready } = useAccount();
  const [mobileNav, setMobileNav] = useState(false);
  const router = useRouter();

  // "N" starts a new task from anywhere that isn't a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      if (e.key === "n" || e.key === "N") {
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
    <div className="flex h-full">
      <aside className="hidden w-[244px] shrink-0 md:block">
        <Sidebar />
      </aside>

      {/* Mobile navigation */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 md:hidden",
          mobileNav ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobileNav(false)}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[272px] bg-canvas shadow-overlay transition-transform duration-300 ease-out md:hidden",
          mobileNav ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <IconButton label="Close menu" className="absolute top-3 right-2.5 z-10" onClick={() => setMobileNav(false)}>
          <IconClose />
        </IconButton>
        <Sidebar onNavigate={() => setMobileNav(false)} />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
          <IconButton label="Open menu" onClick={() => setMobileNav(true)}>
            <IconSidebar />
          </IconButton>
          <Mark size={16} />
          <span className="text-sm font-semibold tracking-tight">Anywhere</span>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface md:rounded-xl md:shadow-[inset_0_1px_0_0_oklch(1_0_0/0.04),0_0_0_1px_var(--color-line),0_1px_3px_oklch(0_0_0/0.3)]">
          {children}
        </div>
      </main>
    </div>
  );
}
