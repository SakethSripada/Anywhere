"use client";

import type { Workload } from "@anywhere/stdb";
import { useRouter } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNow } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { BILLABLE, href, liveCents } from "@/lib/workloads";
import { AppLogo, appKey } from "../app/app-logo";
import { Uptime } from "./shared";
import { StatusChip } from "./status";

/** Dense machine listing, console-style: one row per machine, click to open. */
export function MachineTable({ rows, showUpdated = false }: { rows: Workload[]; showUpdated?: boolean }) {
  const router = useRouter();
  const now = useNow(2000, rows.some((w) => BILLABLE.has(w.status)));
  return (
    <div className="overflow-hidden rounded-card bg-card shadow-hairline">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent [&>th]:h-10 [&>th]:text-[12px] [&>th]:font-normal [&>th]:text-ink-3">
            <TableHead className="pl-3">Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden @2xl:table-cell">GPU</TableHead>
            <TableHead className="hidden @2xl:table-cell">Uptime</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            {showUpdated && <TableHead className="hidden pr-3 text-right @3xl:table-cell">Updated</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((w) => (
            <TableRow key={String(w.id)} className="cursor-pointer border-line transition-colors hover:bg-hover [&>td]:py-2.5" onClick={() => router.push(href(w))}>
              <TableCell className="max-w-0 pl-3">
                <div className="flex items-center gap-2.5">
                  <AppLogo app={appKey(w)} size={15} />
                  <span className="truncate text-[13px] font-medium">{w.title}</span>
                </div>
              </TableCell>
              <TableCell>
                <StatusChip status={w.status} />
              </TableCell>
              <TableCell className="hidden text-[13px] text-muted-foreground @2xl:table-cell">{w.gpuName}</TableCell>
              <TableCell className="hidden text-[13px] text-muted-foreground tabular @2xl:table-cell">
                <Uptime w={w} />
              </TableCell>
              <TableCell className="text-right text-[13px] tabular">
                {w.status === "planned" ? (
                  <span className="text-muted-foreground">≤ {cents(w.estHighCents)}</span>
                ) : (
                  cents(now && BILLABLE.has(w.status) ? liveCents(w, now) : w.accruedCents, { precise: true })
                )}
              </TableCell>
              {showUpdated && <TableCell className="hidden pr-3 text-right text-[13px] text-muted-foreground @3xl:table-cell">{ago(w.updatedAt, now || undefined)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
