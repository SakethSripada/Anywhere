"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { useAccount, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { tables, useTable } from "@/lib/stdb";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { ACTIVE, BILLABLE, href } from "@/lib/workloads";
import { MobileNavTrigger } from "../app/mobile-nav";
import { Composer } from "../chat/composer";
import { MachineCard } from "../machines/machine-card";
import { LaunchDialog } from "./launch-dialog";
import { TEMPLATES, type Template } from "./templates";

function greeting(now: number) {
  if (!now) return "Welcome back";
  const h = new Date(now).getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const { account } = useAccount();
  const { workloads } = useWorkloads();
  const { send } = useChat(null);
  const router = useRouter();
  const now = useNow(60_000);
  const [template, setTemplate] = useState<Template | null>(null);
  const active = workloads.filter((w) => ACTIVE.has(w.status) || w.status === "planned" || w.status === "stopped");

  async function submit(text: string, uploadIds: number[]) {
    const id = await send(text, uploadIds);
    router.push(`/c/${id}`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
        <MobileNavTrigger />
      </div>
      <div className="@container mx-auto w-full max-w-5xl px-5 pt-10 pb-16 sm:px-8 md:pt-16">
        <section>
          <p className="text-sm text-muted-foreground">
            {greeting(now)}
            {account ? `, ${account.displayName.split(" ")[0]}` : ""}
          </p>
          <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.025em] sm:text-[32px]">What do you need a computer for?</h1>
          <div className="mt-6">
            <Composer
              onSubmit={submit}
              autoFocus
              placeholder="Describe the task — “Set up Blender with a GPU”, “Fine-tune Llama 3 8B on my tickets”…"
            />
          </div>
        </section>

        <section className="mt-10">
          <SectionTitle>Start from a template</SectionTitle>
          <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t)}
                className="group flex flex-col items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-(--shadow-card) transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-primary/30 hover:shadow-(--shadow-float)"
              >
                <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <t.icon className="size-[18px]" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {active.length > 0 && (
          <section className="mt-10">
            <SectionTitle action={<Link href="/machines" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">All machines <ArrowRight className="size-3.5" /></Link>}>
              Your machines
            </SectionTitle>
            <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
              {active.slice(0, 6).map((w) => (
                <MachineCard key={String(w.id)} w={w} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10 grid gap-6 @3xl:grid-cols-[1fr_300px]">
          <Activity />
          <Spend />
        </section>
      </div>
      <LaunchDialog key={template?.id ?? "none"} template={template} onOpenChange={(o) => !o && setTemplate(null)} />
    </div>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold">{children}</h2>
      {action}
    </div>
  );
}

function Activity() {
  const [events] = useTable(tables.myEvents);
  const { all } = useWorkloads();
  const now = useNow(30_000);
  const recent = useMemo(() => [...events].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 8), [events]);
  return (
    <div>
      <SectionTitle>Recent activity</SectionTitle>
      <div className="overflow-hidden rounded-xl border bg-card">
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">Nothing yet. Start a template or describe a task above.</p>
        ) : (
          <ul className="divide-y">
            {recent.map((e) => {
              const w = all.find((x) => x.id === e.workloadId);
              return (
                <li key={String(e.id)}>
                  <Link href={w ? href(w) : "/machines"} className="flex items-baseline gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-subtle">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 -translate-y-px rounded-full",
                        e.level === "error" ? "bg-destructive" : e.level === "success" ? "bg-success" : e.level.startsWith("warn") ? "bg-warning" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {w && <span className="font-medium">{w.title} </span>}
                      <span className="text-muted-foreground">{e.message}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{ago(e.createdAt, now || undefined)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Spend() {
  const { account } = useAccount();
  const { platform } = usePlatform();
  const { workloads } = useWorkloads();
  const spent = useMonthSpend();
  const cap = account?.monthlyCapCents ?? 0;
  const burn = workloads.filter((w) => BILLABLE.has(w.status)).reduce((s, w) => s + w.hourlyCents, 0);
  const credit = platform ? Math.max(0, platform.globalBudgetCents - platform.globalSpentCents) : null;
  return (
    <div>
      <SectionTitle action={<Link href="/settings#spending" className="text-[13px] text-muted-foreground hover:text-foreground">Limits</Link>}>Spend</SectionTitle>
      <div className="rounded-xl border bg-card p-4">
        <div className="text-xs text-muted-foreground">This month</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tracking-tight tabular">{cents(spent)}</span>
          <span className="text-sm text-muted-foreground">of {cents(cap)}</span>
        </div>
        <Progress value={cap ? Math.min(100, (spent / cap) * 100) : 0} className="mt-3 h-1.5" />
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 text-[13px]">
          <div>
            <dt className="text-xs text-muted-foreground">Burning now</dt>
            <dd className="mt-0.5 font-medium tabular">{burn ? `${cents(burn)}/hr` : "Nothing"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Shared credit left</dt>
            <dd className="mt-0.5 font-medium tabular">{credit == null ? "—" : cents(credit)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {account?.approvalThresholdCents ? `Plans up to ${cents(account.approvalThresholdCents)} start automatically. Anything more waits for you.` : "Every plan waits for your approval before anything is billed."}
        </p>
      </div>
    </div>
  );
}
