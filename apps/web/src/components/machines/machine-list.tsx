"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkloads } from "@/lib/data";
import { ACTIVE } from "@/lib/workloads";
import { PageHeader } from "../app/page-header";
import { CostPanel } from "./cost-panel";
import { MachineTable } from "./machine-table";

export function MachineList() {
  const { workloads, ready } = useWorkloads();
  const live = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned");
  const stopped = workloads.filter((w) => w.status === "stopped");
  const history = workloads.filter((w) => ["succeeded", "failed", "cancelled"].includes(w.status));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Machines">
        <Button size="sm" nativeButton={false} render={<Link href="/" />}>
          <Plus /> New task
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-6xl px-6 pt-6 pb-16">
          <CostPanel />

          {!ready ? (
            <Skeleton className="mt-8 h-40 rounded-lg" />
          ) : workloads.length === 0 ? (
            <div className="mt-8 rounded-lg border border-dashed px-6 py-14 text-center">
              <p className="text-sm font-medium">No machines yet</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">Start a task from Home to create one.</p>
              <Button className="mt-4" size="sm" nativeButton={false} render={<Link href="/" />}>
                <Plus /> New task
              </Button>
            </div>
          ) : (
            <>
              <Group title="Live" count={live.length}>
                {live.length ? <MachineTable rows={live} showUpdated /> : <Empty>Nothing running or awaiting approval.</Empty>}
              </Group>
              {stopped.length > 0 && (
                <Group title="Stopped" count={stopped.length} note="Files saved · not billing">
                  <MachineTable rows={stopped} showUpdated />
                </Group>
              )}
              {history.length > 0 && (
                <Group title="History" count={history.length}>
                  <MachineTable rows={history} showUpdated />
                </Group>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, count, note, children }: { title: string; count: number; note?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        <span className="text-xs text-faint tabular">{count}</span>
        {note && <span className="ml-auto text-xs text-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-4 py-5 text-center text-[13px] text-muted-foreground">{children}</p>;
}
