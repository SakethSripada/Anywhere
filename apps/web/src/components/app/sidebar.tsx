"use client";

import { ChevronsUpDown, House, Moon, Plus, Server, Settings, Sun, SunMoon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Suspense, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { useAccount, useConversations, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACTIVE, href, liveCents } from "@/lib/workloads";
import { StatusDot } from "../machines/status";
import { Logo } from "./logo";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link href="/" onClick={onNavigate}>
          <Logo />
        </Link>
        <ModeLabel />
      </div>
      <div className="px-3">
        <Button className="h-9 w-full justify-start gap-2 px-3" nativeButton={false} render={<Link href="/" onClick={onNavigate} />}>
          <Plus className="size-4" />
          New task
          <Kbd className="ml-auto bg-white/15 text-primary-foreground">⌘K</Kbd>
        </Button>
      </div>
      <Suspense fallback={<div className="flex-1" />}>
        <Nav onNavigate={onNavigate} />
      </Suspense>
      <Footer onNavigate={onNavigate} />
    </nav>
  );
}

function Item({ href: to, active, icon, children, onClick, trailing }: { href: string; active?: boolean; icon?: ReactNode; children: ReactNode; onClick?: () => void; trailing?: ReactNode }) {
  return (
    <Link
      href={to}
      onClick={onClick}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        active && "bg-background font-medium text-foreground shadow-(--shadow-card) ring-1 ring-border hover:bg-background [&>svg]:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </Link>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {action}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { workloads } = useWorkloads();
  const { conversations } = useConversations();
  const now = useNow(5000);
  const live = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned").slice(0, 6);

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
      <div className="flex flex-col gap-px">
        <Item href="/" icon={<House />} active={pathname === "/"} onClick={onNavigate}>
          Home
        </Item>
        <Item
          href="/machines"
          icon={<Server />}
          active={pathname.startsWith("/machines")}
          onClick={onNavigate}
          trailing={workloads.length > 0 ? <span className="text-xs text-muted-foreground tabular">{workloads.length}</span> : undefined}
        >
          Machines
        </Item>
      </div>

      {live.length > 0 && (
        <Section title="Live">
          {live.map((w) => (
            <Item
              key={String(w.id)}
              href={href(w)}
              active={pathname === href(w)}
              onClick={onNavigate}
              icon={<StatusDot status={w.status} className="mx-1 size-1.5" />}
              trailing={
                <span className="text-xs text-muted-foreground tabular">{w.status === "planned" ? "Review" : cents(now ? liveCents(w, now) : w.accruedCents)}</span>
              }
            >
              {w.title}
            </Item>
          ))}
        </Section>
      )}

      {conversations.length > 0 && (
        <Section title="Tasks">
          {conversations.slice(0, 30).map((c) => (
            <Item key={String(c.id)} href={`/c/${c.id}`} active={pathname === `/c/${c.id}`} onClick={onNavigate}>
              {c.title || "Untitled task"}
            </Item>
          ))}
        </Section>
      )}
    </div>
  );
}

function ModeLabel() {
  const { platform } = usePlatform();
  const mode = platform?.provisioningMode;
  if (!mode || mode === "live") return null;
  return (
    <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning">{mode === "dry_run" ? "Dry run" : "Plans only"}</span>
  );
}

function Footer({ onNavigate }: { onNavigate?: () => void }) {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const { theme, setTheme } = useTheme();
  if (!account) return null;
  const cap = account.monthlyCapCents;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;

  return (
    <div className="flex flex-col gap-2 p-3">
      <Link href="/settings#spending" onClick={onNavigate} className="rounded-lg px-2.5 py-2 transition-colors hover:bg-sidebar-accent">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Spent this month</span>
          <span className="tabular">
            {cents(spent)} <span className="text-muted-foreground">/ {cents(cap)}</span>
          </span>
        </div>
        <Progress value={pct} className="mt-2 h-1" />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {account.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{account.displayName}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
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
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/machines" onClick={onNavigate} />}>
            <Server /> All machines
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
