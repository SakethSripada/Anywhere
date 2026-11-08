"use client";

import type { Workload } from "@anywhere/stdb";
import { ChevronsUpDown, House, LayoutGrid, Moon, Plus, Settings, Sun, SunMoon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Suspense } from "react";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAccount, useConversations, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACTIVE, href, liveCents } from "@/lib/workloads";
import { needsAttention, StatusDot } from "../machines/status";
import { AppLogo, appKey } from "./app-logo";
import { Logo } from "./logo";

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon" className="border-r-sidebar-border">
      <SidebarHeader className="gap-2.5 px-2.5 pt-3">
        <div className="flex h-7 items-center justify-between px-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <Link href="/">
            <Logo />
          </Link>
          <ModeLabel />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New task  ⌘K"
              render={<Link href="/" />}
              className="h-8 border bg-sidebar-accent/40 font-medium shadow-xs hover:bg-sidebar-accent group-data-[collapsible=icon]:border-0"
            >
              <Plus />
              <span>New task</span>
              <Kbd className="ml-auto bg-transparent group-data-[collapsible=icon]:hidden">⌘K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <Suspense fallback={null}>
          <Groups />
        </Suspense>
      </SidebarContent>
      <SidebarFooter className="gap-2 p-2.5">
        <Account />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function Groups() {
  const pathname = usePathname();
  const { workloads } = useWorkloads();
  const { conversations } = useConversations();
  const { setOpenMobile } = useSidebar();
  const live = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned").slice(0, 8);
  const close = () => setOpenMobile(false);
  const nav = [
    { href: "/", label: "Home", icon: House, active: pathname === "/" },
    { href: "/machines", label: "Machines", icon: LayoutGrid, active: pathname.startsWith("/machines"), count: workloads.length },
    { href: "/settings", label: "Settings", icon: Settings, active: pathname.startsWith("/settings") },
  ];

  return (
    <>
      <SidebarGroup className="py-1.5">
        <SidebarGroupContent>
          <SidebarMenu className="gap-0.5">
            {nav.map((n) => (
              <SidebarMenuItem key={n.href}>
                <SidebarMenuButton isActive={n.active} tooltip={n.label} render={<Link href={n.href} onClick={close} />} className="h-8 text-[13px] text-sidebar-foreground/75 data-active:font-medium data-active:text-sidebar-foreground">
                  <n.icon />
                  <span>{n.label}</span>
                  {!!n.count && <span className="ml-auto text-[11px] text-muted-foreground tabular group-data-[collapsible=icon]:hidden">{n.count}</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {live.length > 0 && (
        <SidebarGroup className="py-1.5">
          <SidebarGroupLabel className="h-7 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">Running</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {live.map((w) => (
                <LiveItem key={String(w.id)} w={w} active={pathname === href(w)} onClick={close} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      {conversations.length > 0 && (
        <SidebarGroup className="py-1.5 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel className="h-7 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">Recent tasks</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0">
              {conversations.slice(0, 30).map((c) => (
                <SidebarMenuItem key={String(c.id)}>
                  <SidebarMenuButton
                    isActive={pathname === `/c/${c.id}`}
                    className="h-7 text-[13px] text-sidebar-foreground/65 data-active:text-sidebar-foreground"
                    render={<Link href={`/c/${c.id}`} onClick={close} prefetch={false} />}
                  >
                    <span>{c.title || "Untitled task"}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </>
  );
}

function LiveItem({ w, active, onClick }: { w: Workload; active: boolean; onClick: () => void }) {
  const now = useNow(5000);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={`${w.title} · ${w.status === "planned" ? "needs approval" : cents(now ? liveCents(w, now) : w.accruedCents)}`}
        render={<Link href={href(w)} onClick={onClick} prefetch={false} />}
        className="h-8 gap-2.5 pr-2 text-[13px] text-sidebar-foreground/80 data-active:text-sidebar-foreground"
      >
        <span className="relative grid size-4 shrink-0 place-items-center">
          <AppLogo app={appKey(w)} size={15} />
          {needsAttention(w.status) && <StatusDot status={w.status} className="absolute -right-1 -bottom-0.5 ring-2 ring-sidebar" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{w.title}</span>
        <span className={cn("shrink-0 text-[11px] tabular group-data-[collapsible=icon]:hidden", w.status === "planned" ? "text-warning" : "text-muted-foreground")}>
          {w.status === "planned" ? "review" : cents(now ? liveCents(w, now) : w.accruedCents)}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ModeLabel() {
  const { platform } = usePlatform();
  const mode = platform?.provisioningMode;
  if (!mode || mode === "live") return null;
  return (
    <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-px text-[10.5px] font-medium text-warning group-data-[collapsible=icon]:hidden">
      {mode === "dry_run" ? "Dry run" : "Plans only"}
    </span>
  );
}

function Account() {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const { theme, setTheme } = useTheme();
  if (!account) return null;
  const cap = account.monthlyCapCents || 1;
  const pct = Math.min(100, (spent / cap) * 100);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="h-auto py-2 data-[popup-open]:bg-sidebar-accent group-data-[collapsible=icon]:py-0" />}>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-neutral-600 to-neutral-800 text-xs font-semibold text-white">
              {account.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="grid min-w-0 flex-1 gap-1 text-left leading-tight">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium">{account.displayName}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular">{cents(spent)}</span>
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-sidebar-accent">
                <span className={cn("block h-full rounded-full", pct > 85 ? "bg-warning" : "bg-brand")} style={{ width: `${Math.max(2, pct)}%` }} />
              </span>
              <span className="truncate text-[11px] text-muted-foreground">of {cents(account.monthlyCapCents)} this month</span>
            </span>
            <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
            <DropdownMenuItem render={<Link href="/settings" />}>
              <Settings /> Settings
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunMoon /> Appearance
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? "dark"} onValueChange={(v) => setTheme(String(v))}>
                  <DropdownMenuRadioItem value="dark">
                    <Moon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">
                    <Sun /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <SunMoon /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/machines" />}>
              <LayoutGrid /> All machines
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
