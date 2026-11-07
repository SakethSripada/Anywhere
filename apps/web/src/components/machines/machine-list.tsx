"use client";

import { Plus, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccount, useMonthSpend, usePlatform, useWorkloads } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { ACTIVE, BILLABLE, href } from "@/lib/workloads";
import { PageHeader } from "../app/page-header";
import { MachineCard } from "./machine-card";
import { StatusChip } from "./status";

export function MachineList() {
  const { workloads, ready } = useWorkloads();
  const { account } = useAccount();
  const { platform } = usePlatform();
  const spent = useMonthSpend();
  const router = useRouter();
  const live = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned");
  const stopped = workloads.filter((w) => w.status === "stopped");
  const history = workloads.filter((w) => ["succeeded", "failed", "cancelled"].includes(w.status));
  const running = workloads.filter((w) => BILLABLE.has(w.status));
  const burn = running.reduce((s, w) => s + w.hourlyCents, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Machines" className="border-b">
        <Button size="sm" nativeButton={false} render={<Link href="/" />}>
          <Plus /> New task
        </Button>
      </PageHeader>
      <div className="@container mx-auto w-full max-w-6xl px-5 pt-6 pb-16 sm:px-8">
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          <Stat label="Running now" value={String(running.length)} sub={running.length ? `${cents(burn)}/hr combined` : "Nothing is billing"} />
          <Stat label="Spent this month" value={cents(spent)} sub={`of your ${cents(account?.monthlyCapCents ?? 0)} limit`} />
          <Stat label="Shared credit left" value={platform ? cents(Math.max(0, platform.globalBudgetCents - platform.globalSpentCents)) : "—"} sub={platform ? `of ${cents(platform.globalBudgetCents)}` : ""} />
          <Stat
            label="Provisioning"
            value={platform?.provisioningMode === "live" ? "Live" : platform?.provisioningMode === "dry_run" ? "Dry run" : "Plans only"}
            sub={platform ? `${platform.activeInstances} of ${platform.maxConcurrentInstances} machines in use` : ""}
          />
        </div>

        {!ready ? (
          <div className="mt-8 grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : workloads.length === 0 ? (
          <div className="mt-8 flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
            <span className="mb-3 grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
              <Server className="size-5" />
            </span>
            <p className="text-sm font-medium">No machines yet</p>
            <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">Start a template or describe what you need on the home page. Anywhere plans the hardware and asks before billing.</p>
            <Button className="mt-5" nativeButton={false} render={<Link href="/" />}>
              <Plus /> New task
            </Button>
          </div>
        ) : (
          <>
            <Group title="Live" empty="Nothing is running or waiting for approval." count={live.length}>
              {live.map((w) => (
                <MachineCard key={String(w.id)} w={w} />
              ))}
            </Group>
            {stopped.length > 0 && (
              <Group title="Stopped" count={stopped.length} note="Files are saved; resume any time. Stopped machines don’t bill.">
                {stopped.map((w) => (
                  <MachineCard key={String(w.id)} w={w} />
                ))}
              </Group>
            )}
            {history.length > 0 && (
              <section className="mt-10">
                <h2 className="mb-3 text-sm font-semibold">History</h2>
                <div className="overflow-hidden rounded-xl border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-4">Name</TableHead>
                        <TableHead>Result</TableHead>
                        <TableHead className="hidden md:table-cell">GPU</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead className="hidden pr-4 text-right md:table-cell">Finished</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((w) => (
                        <TableRow key={String(w.id)} className="cursor-pointer" onClick={() => router.push(href(w))}>
                          <TableCell className="max-w-0 py-3 pl-4">
                            <div className="truncate font-medium">{w.title}</div>
                            <div className="truncate text-xs text-muted-foreground">{w.statusDetail || w.summary}</div>
                          </TableCell>
                          <TableCell>
                            <StatusChip status={w.status} />
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{w.gpuName}</TableCell>
                          <TableCell className="text-right tabular">{cents(w.accruedCents, { precise: true })}</TableCell>
                          <TableCell className="hidden pr-4 text-right text-muted-foreground md:table-cell">{ago(w.updatedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Group({ title, count, note, empty, children }: { title: string; count: number; note?: string; empty?: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground tabular">{count}</span>
        {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
      </div>
      {count === 0 && empty ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">{children}</div>
      )}
    </section>
  );
}
