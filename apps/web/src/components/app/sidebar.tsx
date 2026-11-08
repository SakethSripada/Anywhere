"use client";

import { ChevronsUpDown, House, Moon, Plus, Server, Settings, Sun, SunMoon } from "lucide-react";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAccount, useConversations, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { ACTIVE, href, liveCents } from "@/lib/workloads";
import { StatusDot } from "../machines/status";
import { Logo } from "./logo";

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-3 pt-3">
        <div className="flex items-center justify-between px-1">
          <Link href="/">
            <Logo />
          </Link>
          <ModeLabel />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton variant="outline" tooltip="New task" render={<Link href="/" />}>
              <Plus />
              <span>New task</span>
              <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">⌘K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <Suspense fallback={null}>
          <Groups />
        </Suspense>
      </SidebarContent>
      <SidebarFooter className="p-3">
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
  const now = useNow(5000);
  const live = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned").slice(0, 8);
  const close = () => setOpenMobile(false);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={pathname === "/"} tooltip="Home" render={<Link href="/" onClick={close} />}>
                <House />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={pathname.startsWith("/machines")} tooltip="Machines" render={<Link href="/machines" onClick={close} />}>
                <Server />
                <span>Machines</span>
              </SidebarMenuButton>
              {workloads.length > 0 && <SidebarMenuBadge className="text-muted-foreground">{workloads.length}</SidebarMenuBadge>}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={pathname.startsWith("/settings")} tooltip="Settings" render={<Link href="/settings" onClick={close} />}>
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {live.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Live</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {live.map((w) => (
                <SidebarMenuItem key={String(w.id)}>
                  <SidebarMenuButton isActive={pathname === href(w)} render={<Link href={href(w)} onClick={close} prefetch={false} />}>
                    <StatusDot status={w.status} className="mx-1 size-1.5" />
                    <span>{w.title}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="font-normal text-muted-foreground tabular">
                    {w.status === "planned" ? "Review" : cents(now ? liveCents(w, now) : w.accruedCents)}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      {conversations.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Tasks</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.slice(0, 30).map((c) => (
                <SidebarMenuItem key={String(c.id)}>
                  <SidebarMenuButton
                    isActive={pathname === `/c/${c.id}`}
                    className="text-foreground/75 data-active:text-foreground"
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

function ModeLabel() {
  const { platform } = usePlatform();
  const mode = platform?.provisioningMode;
  if (!mode || mode === "live") return null;
  return (
    <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">{mode === "dry_run" ? "Dry run" : "Plans only"}</span>
  );
}

function Account() {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const { theme, setTheme } = useTheme();
  if (!account) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-[popup-open]:bg-sidebar-accent" />}>
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-semibold">{account.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate text-[13px] font-medium">{account.displayName}</span>
              <span className="truncate text-xs text-muted-foreground tabular">
                {cents(spent)} of {cents(account.monthlyCapCents)} this month
              </span>
            </span>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
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
              <Server /> All machines
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
