"use client";

import type { Workload } from "@anywhere/stdb";
import { Monitor, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNow } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { BILLABLE, href, liveCents } from "@/lib/workloads";
import { Uptime } from "./shared";
import { StatusChip } from "./status";

/** Dense machine listing, console-style: one row per machine, click to open. */
export function MachineTable({ rows, showUpdated = false }: { rows: Workload[]; showUpdated?: boolean }) {
  const router = useRouter();
  const now = useNow(2000);
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent [&>th]:h-9 [&>th]:text-xs [&>th]:font-normal [&>th]:text-muted-foreground">
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
            <TableRow key={String(w.id)} className="cursor-pointer transition-colors [&>td]:py-2" onClick={() => router.push(href(w))}>
              <TableCell className="max-w-0 pl-3">
                <div className="flex items-center gap-2.5">
                  {w.kind === "desktop" ? <Monitor className="size-3.5 shrink-0 text-faint" /> : <Sparkles className="size-3.5 shrink-0 text-faint" />}
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
