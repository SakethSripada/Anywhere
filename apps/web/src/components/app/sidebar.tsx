"use client";

import { ChevronsUpDown, Moon, Plus, Settings, Sun, SunMoon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Suspense, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { useAccount, useConversations, useMonthSpend, usePlatform, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACTIVE, href, statusMeta } from "@/lib/workloads";
import { Logo } from "./logo";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-13 shrink-0 items-center justify-between px-4">
        <Link href="/" onClick={onNavigate}>
          <Logo />
        </Link>
        <ModeLabel />
      </div>
      <div className="px-2 pb-2">
        <Link
          href="/"
          onClick={onNavigate}
          className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors hover:bg-sidebar-accent"
        >
          <span className="grid size-5 place-items-center rounded-full bg-foreground text-background">
            <Plus className="size-3.5" strokeWidth={2.25} />
          </span>
          New chat
        </Link>
      </div>
      <Suspense fallback={<div className="flex-1" />}>
        <Lists onNavigate={onNavigate} />
      </Suspense>
      <AccountMenu onNavigate={onNavigate} />
    </nav>
  );
}

function Row({ href: to, active, children, onClick, trailing }: { href: string; active: boolean; children: ReactNode; onClick?: () => void; trailing?: ReactNode }) {
  return (
    <Link
      href={to}
      onClick={onClick}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] text-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
        active && "bg-sidebar-accent text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </Link>
  );
}

function Lists({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { workloads } = useWorkloads();
  const { conversations } = useConversations();
  const machines = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "stopped" || w.status === "planned").slice(0, 6);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2 pt-2 pb-4">
      <section>
        <Heading href="/machines" active={pathname.startsWith("/machines")} onClick={onNavigate}>
          Machines
        </Heading>
        {machines.length === 0 ? (
          <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing running</p>
        ) : (
          machines.map((w) => {
            const m = statusMeta(w.status);
            return (
              <Row
                key={String(w.id)}
                href={href(w)}
                active={pathname === href(w)}
                onClick={onNavigate}
                trailing={
                  <span className={cn("shrink-0 text-xs", m.live && w.status !== "running" ? "shimmer-text" : "text-muted-foreground")}>
                    {w.status === "running" ? "Running" : w.status === "planned" ? "Plan" : m.label}
                  </span>
                }
              >
                {w.title}
              </Row>
            );
          })
        )}
      </section>
      {conversations.length > 0 && (
        <section>
          <div className="px-2.5 pb-1 text-xs text-muted-foreground">Chats</div>
          {conversations.slice(0, 40).map((c) => (
            <Row key={String(c.id)} href={`/c/${c.id}`} active={pathname === `/c/${c.id}`} onClick={onNavigate}>
              {c.title || "Untitled"}
            </Row>
          ))}
        </section>
      )}
    </div>
  );
}

function Heading({ href: to, active, onClick, children }: { href: string; active: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <Link
      href={to}
      onClick={onClick}
      className={cn("flex items-center justify-between rounded-md px-2.5 pb-1 text-xs text-muted-foreground transition-colors hover:text-foreground", active && "text-foreground")}
    >
      {children}
      <span className="text-[11px]">View all</span>
    </Link>
  );
}

function ModeLabel() {
  const { platform } = usePlatform();
  const mode = platform?.provisioningMode;
  if (!mode || mode === "live") return null;
  return <span className="text-xs text-muted-foreground">{mode === "dry_run" ? "Dry run" : "Plans only"}</span>;
}

function AccountMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const { theme, setTheme } = useTheme();
  if (!account) return null;
  const cap = account.monthlyCapCents;

  return (
    <div className="p-2">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">
            {account.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px]">{account.displayName}</span>
            <span className="block truncate text-xs text-muted-foreground tabular">{cents(spent)} spent this month</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="space-y-2 py-2 font-normal">
              <span className="flex justify-between text-xs text-muted-foreground">
                <span>Monthly spend</span>
                <span className="tabular">
                  {cents(spent)} of {cents(cap)}
                </span>
              </span>
              <Progress value={cap ? Math.min(100, (spent / cap) * 100) : 0} className="h-1" />
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/settings" onClick={onNavigate} />}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoon /> Appearance
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(v) => setTheme(String(v))}>
                <DropdownMenuRadioItem value="light">
                  <Sun /> Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon /> Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <SunMoon /> System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
