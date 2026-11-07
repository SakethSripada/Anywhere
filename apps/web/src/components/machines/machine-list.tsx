"use client";

import type { Workload } from "@anywhere/stdb";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccount, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { BILLABLE, href, liveCents } from "@/lib/workloads";
import { PageHeader } from "../app/page-header";
import { Uptime } from "./shared";
import { StatusBadge } from "./status";

type Filter = "all" | "running" | "desktop" | "batch" | "ended";

const MATCH: Record<Filter, (w: Workload) => boolean> = {
  all: () => true,
  running: (w) => BILLABLE.has(w.status) || w.status === "approved",
  desktop: (w) => w.kind === "desktop",
  batch: (w) => w.kind === "batch",
  ended: (w) => ["succeeded", "stopped", "cancelled", "failed"].includes(w.status),
};

export function MachineList() {
  const { workloads, ready } = useWorkloads();
  const { account } = useAccount();
  const { platform } = usePlatform();
  const spent = useMonthSpend();
  const [filter, setFilter] = useState<Filter>("all");
  const router = useRouter();
  const now = useNow(5000);
  const rows = useMemo(() => workloads.filter(MATCH[filter]), [workloads, filter]);
  const running = workloads.filter((w) => BILLABLE.has(w.status));
  const burn = running.reduce((s, w) => s + w.hourlyCents, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Machines">
        <Button size="sm" nativeButton={false} render={<Link href="/" />}>
          <Plus /> New
        </Button>
      </PageHeader>
      <div className="mx-auto w-full max-w-6xl px-4 pb-12 sm:px-8">
        <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-xl border md:grid-cols-4">
          <Summary label="Running now" value={String(running.length)} sub={running.length ? `${cents(burn)}/hr combined` : "Nothing is billing"} />
          <Summary label="Spent this month" value={cents(spent)} sub={`of ${cents(account?.monthlyCapCents ?? 0)} cap`} />
          <Summary
            label="Shared GPU credit"
            value={platform ? cents(Math.max(0, platform.globalBudgetCents - platform.globalSpentCents)) : "—"}
            sub={platform ? `left of ${cents(platform.globalBudgetCents)}` : ""}
          />
          <Summary
            label="Provisioning"
            value={platform?.provisioningMode === "live" ? "Live" : platform?.provisioningMode === "dry_run" ? "Dry run" : "Off"}
            sub={platform?.provisioningMode === "live" ? "Approved plans create machines" : "Plans only — nothing is billed"}
          />
        </div>

        <div className="mt-8 mb-3 flex items-center justify-between gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="running">Running</TabsTrigger>
              <TabsTrigger value="desktop">Desktops</TabsTrigger>
              <TabsTrigger value="batch">Jobs</TabsTrigger>
              <TabsTrigger value="ended">Ended</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-xs text-muted-foreground tabular">{rows.length} shown</span>
        </div>

        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">GPU</TableHead>
                <TableHead className="hidden md:table-cell">Runtime</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="hidden pr-4 text-right lg:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!ready &&
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6} className="pl-4">
                      <Skeleton className="h-4 w-1/3" />
                    </TableCell>
                  </TableRow>
                ))}
              {ready && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-16 text-center">
                    <div className="text-sm font-medium">No machines here yet</div>
                    <div className="mt-1 text-[13px] text-muted-foreground">Describe a task in a new chat and Anywhere will plan the compute.</div>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((w) => (
                <TableRow key={String(w.id)} className="cursor-pointer" onClick={() => router.push(href(w))}>
                  <TableCell className="max-w-0 py-3 pl-4">
                    <div>
                      <span className="block min-w-0">
                        <Link href={href(w)} className="block truncate font-medium" onClick={(e) => e.stopPropagation()}>
                          {w.title}
                        </Link>
                        <span className="block truncate text-xs text-muted-foreground">{w.summary}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={w.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{w.gpuName}</TableCell>
                  <TableCell className="hidden text-muted-foreground tabular md:table-cell">
                    <Uptime w={w} />
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {w.status === "planned" ? <span className="text-muted-foreground">≤ {cents(w.estHighCents)}</span> : cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })}
                  </TableCell>
                  <TableCell className="hidden pr-4 text-right text-muted-foreground lg:table-cell">{ago(w.updatedAt, now || undefined)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-r border-b p-4 md:border-b-0 [&:nth-child(2)]:border-r-0 md:[&:nth-child(2)]:border-r md:last:border-r-0 [&:nth-child(n+3)]:border-b-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
