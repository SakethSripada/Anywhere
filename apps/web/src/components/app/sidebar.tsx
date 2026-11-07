"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useAccount, useConversations, useMonthSpend, usePlatform, useWorkloads } from "@/lib/data";
import { cents } from "@/lib/format";
import { BILLABLE } from "@/lib/workloads";
import {
  IconDesktop,
  IconMessage,
  IconPlus,
  IconSettings,
  IconWorkload,
  IconWorkspace,
  Mark,
} from "../icons";
import { Kbd } from "../ui/kbd";
import { Meter } from "../ui/meter";
import { Dot } from "../ui/status";
import { Tooltip } from "../ui/tooltip";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full w-full flex-col gap-1 px-2.5 pt-3 pb-2.5">
      <div className="flex h-8 items-center gap-2 px-1.5">
        <Mark size={18} className="text-fg" />
        <span className="text-md font-semibold tracking-tighter text-fg">Anywhere</span>
        <ModeBadge />
      </div>

      <Link
        href="/"
        onClick={onNavigate}
        className={cn(
          "group mt-3 mb-2 flex h-8 items-center gap-2 rounded-md bg-raised px-2.5 text-sm font-medium text-fg",
          "shadow-[inset_0_1px_0_0_oklch(1_0_0/0.06),0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0_0_0/0.3)]",
          "transition-[background-color,transform] duration-150 hover:bg-overlay active:translate-y-px focus-ring",
        )}
      >
        <IconPlus size={15} className="text-fg-muted transition-transform duration-200 ease-spring group-hover:rotate-90" />
        New task
        <Kbd className="ml-auto">N</Kbd>
      </Link>

      <Suspense fallback={<NavSkeleton />}>
        <NavLinks onNavigate={onNavigate} />
      </Suspense>

      <div className="mt-auto flex flex-col gap-2">
        <SpendCard />
      </div>
    </nav>
  );
}

function NavSkeleton() {
  return (
    <div className="flex flex-col gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 rounded-md px-2 py-2">
          <div className="skeleton h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { workloads } = useWorkloads();
  const { conversations } = useConversations();
  const runningDesktops = workloads.filter((w) => w.kind === "desktop" && BILLABLE.has(w.status)).length;
  const activeJobs = workloads.filter((w) => w.kind === "batch" && BILLABLE.has(w.status)).length;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" || pathname.startsWith("/c/") : pathname.startsWith(href);

  return (
    <>
      <div className="flex flex-col gap-px">
        <NavItem href="/" icon={<IconWorkspace />} active={isActive("/")} onClick={onNavigate}>
          Workspace
        </NavItem>
        <NavItem href="/desktops" icon={<IconDesktop />} active={isActive("/desktops")} onClick={onNavigate} live={runningDesktops}>
          Desktops
        </NavItem>
        <NavItem href="/workloads" icon={<IconWorkload />} active={isActive("/workloads")} onClick={onNavigate} live={activeJobs}>
          Workloads
        </NavItem>
        <NavItem href="/settings" icon={<IconSettings />} active={isActive("/settings")} onClick={onNavigate}>
          Settings
        </NavItem>
      </div>

      {conversations.length > 0 && (
        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="px-2 pb-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Recent</div>
          <div className="-mx-1 flex min-h-0 flex-col gap-px overflow-y-auto px-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)] pb-6">
            {conversations.slice(0, 30).map((c) => {
              const href = `/c/${c.id}`;
              const active = pathname === href;
              return (
                <Link
                  key={String(c.id)}
                  href={href}
                  onClick={onNavigate}
                  prefetch={false}
                  className={cn(
                    "group flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-fg-subtle outline-none",
                    "transition-colors duration-100 hover:bg-hover hover:text-fg-muted focus-ring",
                    active && "bg-selected text-fg hover:bg-selected hover:text-fg",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.title || "Untitled"}</span>
                  {c.channel === "imessage" && (
                    <Tooltip content="From iMessage">
                      <span className="text-fg-faint">
                        <IconMessage size={13} />
                      </span>
                    </Tooltip>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function NavItem({
  href,
  icon,
  active,
  children,
  onClick,
  live,
}: {
  href: string;
  icon: ReactNode;
  active: boolean;
  children: ReactNode;
  onClick?: () => void;
  live?: number;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm font-medium text-fg-subtle outline-none",
        "transition-colors duration-100 hover:bg-hover hover:text-fg-muted focus-ring",
        "[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-faint [&>svg]:transition-colors hover:[&>svg]:text-fg-subtle",
        active && "bg-selected text-fg hover:bg-selected hover:text-fg [&>svg]:text-fg-muted hover:[&>svg]:text-fg-muted",
      )}
    >
      {icon}
      {children}
      {!!live && (
        <span className="ml-auto flex items-center gap-1.5 text-2xs text-ok tabular">
          <Dot tone="ok" live />
          {live}
        </span>
      )}
    </Link>
  );
}

function ModeBadge() {
  const { platform } = usePlatform();
  const mode = platform?.provisioningMode;
  if (!mode || mode === "live") return null;
  return (
    <Tooltip content={mode === "dry_run" ? "Plans are validated with Brev but nothing is billed" : "Provisioning is off — plans only"}>
      <span className="ml-auto rounded-[5px] bg-wait-soft px-1.5 py-0.5 text-2xs font-medium text-wait">
        {mode === "dry_run" ? "Dry run" : "Plans only"}
      </span>
    </Tooltip>
  );
}

function SpendCard() {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const cap = account?.monthlyCapCents ?? 0;
  return (
    <Link
      href="/settings"
      className="group block rounded-lg px-2.5 py-2.5 outline-none transition-colors duration-100 hover:bg-hover focus-ring"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-fg-subtle">This month</span>
        <span className="tabular text-xs text-fg-muted">
          <span className="font-medium text-fg">{cents(spent)}</span>
          {cap > 0 && <span className="text-fg-faint"> / {cents(cap)}</span>}
        </span>
      </div>
      <Meter value={spent} max={cap || 1} className="mt-2" />
      {account && (
        <div className="mt-2.5 flex items-center gap-2">
          <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-2xs font-semibold text-accent">
            {account.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-muted group-hover:text-fg">{account.displayName}</span>
        </div>
      )}
    </Link>
  );
}
