"use client";

import { ArrowRight, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { cents, clock } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { ACTIVE, BILLABLE, href } from "@/lib/workloads";
import { PageHeader } from "../app/page-header";
import { Composer } from "../chat/composer";
import { MachineTable } from "../machines/machine-table";
import { LaunchDialog } from "./launch-dialog";
import { TEMPLATES, type Template } from "./templates";

export function Home() {
  const { account } = useAccount();
  const { workloads } = useWorkloads();
  const { send } = useChat(null);
  const router = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const active = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned" || w.status === "stopped");

  async function submit(text: string, uploadIds: number[]) {
    const id = await send(text, uploadIds);
    router.push(`/c/${id}`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-5xl px-6 pt-10 pb-16">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">
            {account ? `What should we run, ${account.displayName.split(" ")[0]}?` : "What should we run?"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Describe the work. Anywhere picks the GPU, sets it up, and shows the cost before anything is billed.</p>

          <div className="mt-5">
            <Composer onSubmit={submit} autoFocus placeholder="e.g. Set up Blender with a GPU for a low-poly scene" />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t)}
                className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-accent"
              >
                <t.icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.tagline}</span>
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>

          <Section
            title="Machines"
            action={
              <Link href="/machines" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                View all <ArrowRight className="size-3" />
              </Link>
            }
          >
            {active.length ? (
              <MachineTable rows={active.slice(0, 6)} />
            ) : (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">No machines running. Pick a template or describe a task above.</p>
            )}
          </Section>

          <div className="mt-10 grid gap-8 @3xl:grid-cols-[1fr_260px]">
            <Activity />
            <Usage />
          </div>
        </div>
      </div>
      <LaunchDialog key={template?.id ?? "none"} template={template} onOpenChange={(o) => !o && setTemplate(null)} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Activity() {
  const [events] = useTable(tables.myEvents);
  const { all } = useWorkloads();
  const recent = useMemo(() => [...events].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 10), [events]);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium text-muted-foreground">Activity</h2>
      {recent.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="font-mono text-xs leading-6">
          {recent.map((e) => {
            const w = all.find((x) => x.id === e.workloadId);
            return (
              <li key={String(e.id)} className="flex gap-4">
                <span className="shrink-0 text-faint tabular">{clock(e.createdAt)}</span>
                <Link href={w ? href(w) : "/machines"} className="min-w-0 truncate font-sans text-[13px] hover:underline">
                  {w && <span className="text-foreground">{w.title}</span>}
                  <span className={cn("ml-2", e.level === "error" ? "text-destructive" : e.level.startsWith("warn") ? "text-warning" : "text-muted-foreground")}>{e.message}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Usage() {
  const { account } = useAccount();
  const { platform } = usePlatform();
  const { workloads } = useWorkloads();
  const spent = useMonthSpend();
  const now = useNow(60_000);
  const cap = account?.monthlyCapCents ?? 0;
  const burn = workloads.filter((w) => BILLABLE.has(w.status)).reduce((s, w) => s + w.hourlyCents, 0);
  const credit = platform ? Math.max(0, platform.globalBudgetCents - platform.globalSpentCents) : null;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  void now;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-muted-foreground">Usage</h2>
        <Link href="/settings#spending" className="text-xs text-muted-foreground hover:text-foreground">
          Limits
        </Link>
      </div>
      <dl className="divide-y rounded-lg border text-[13px]">
        <Row label="This month" value={`${cents(spent)} / ${cents(cap)}`}>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        </Row>
        <Row label="Burn rate" value={burn ? `${cents(burn)}/hr` : "—"} />
        <Row label="Shared credit" value={credit == null ? "—" : cents(credit)} />
        <Row label="Auto-approve" value={account?.approvalThresholdCents ? `≤ ${cents(account.approvalThresholdCents)}` : "Off"} />
      </dl>
    </section>
  );
}

function Row({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="font-medium tabular">{value}</dd>
      </div>
      {children}
    </div>
  );
}
