"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useAccount, useConversations, useMonthSpend, useNow, usePlatform, useWorkloads } from "@/lib/data";
import { ago, cents } from "@/lib/format";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { ACTIVE, BILLABLE } from "@/lib/workloads";
import { AppLogo } from "../app/app-logo";
import { PageHeader } from "../app/page-header";
import { Composer } from "../chat/composer";
import { MachineCard } from "../machines/machine-card";
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
        {/* Hero: the one thing to do here */}
        <section className="relative border-b">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 [background-image:radial-gradient(color-mix(in_srgb,var(--foreground)_7%,transparent)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_0%,black,transparent)]" />
            <div className="absolute -top-40 left-1/2 h-80 w-[720px] -translate-x-1/2 rounded-full bg-agent/10 blur-3xl" />
          </div>
          <div className="@container relative mx-auto w-full max-w-3xl px-6 pt-14 pb-10">
            <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em]">
              {account ? `What should we run, ${account.displayName.split(" ")[0]}?` : "What should we run?"}
            </h1>
            <div className="mt-5">
              <Composer onSubmit={submit} autoFocus placeholder="e.g. Set up Blender on a GPU for a low-poly island scene" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 @2xl:grid-cols-4">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplate(t)}
                  className="group flex flex-col gap-3 rounded-card bg-card p-3.5 text-left shadow-hairline transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:bg-hover hover:shadow-btn"
                >
                  <span className="grid size-8 place-items-center rounded-control bg-field shadow-hairline transition-transform duration-200 group-hover:scale-105">
                    <AppLogo app={t.logo} size={18} />
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium">{t.title}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-4 text-muted-foreground">{t.tagline}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="@container mx-auto w-full max-w-6xl px-6 pt-10 pb-20">
          <Section
            title="Your machines"
            action={
              <Link href="/machines" className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                View all <ArrowRight className="size-3" />
              </Link>
            }
          >
            {active.length ? (
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                {active.slice(0, 6).map((w) => (
                  <MachineCard key={String(w.id)} w={w} />
                ))}
              </div>
            ) : (
              <div className="rounded-card bg-card px-6 py-10 text-center shadow-hairline">
                <p className="text-[13px] font-medium">Nothing running</p>
              </div>
            )}
          </Section>

          <div className="mt-14 grid gap-10 @4xl:grid-cols-[1fr_300px]">
            <RecentTasks />
            <Usage />
          </div>
        </div>
      </div>
      <LaunchDialog key={template?.id ?? "none"} template={template} onOpenChange={(o) => !o && setTemplate(null)} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="eyebrow">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RecentTasks() {
  const { conversations } = useConversations();
  const now = useNow(60_000);
  return (
    <Section title="Recent tasks">
      {conversations.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Your conversations with Anywhere show up here.</p>
      ) : (
        <ul className="-mx-2">
          {conversations.slice(0, 7).map((c) => (
            <li key={String(c.id)}>
              <Link href={`/c/${c.id}`} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60">
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85 group-hover:text-foreground">{c.title || "Untitled task"}</span>
                <span className="shrink-0 text-[11.5px] text-faint">{now ? ago(c.updatedAt, now) : ""}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Usage() {
  const { account } = useAccount();
  const { platform } = usePlatform();
  const { workloads } = useWorkloads();
  const spent = useMonthSpend();
  const cap = account?.monthlyCapCents ?? 0;
  const burn = workloads.filter((w) => BILLABLE.has(w.status)).reduce((s, w) => s + w.hourlyCents, 0);
  const credit = platform ? Math.max(0, platform.globalBudgetCents - platform.globalSpentCents) : null;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <Section
      title="Usage"
      action={
        <Link href="/settings#spending" className="text-[12px] text-muted-foreground hover:text-foreground">
          Limits
        </Link>
      }
    >
      <div className="rounded-card bg-card shadow-hairline">
        <div className="px-4 pt-3.5 pb-4">
          <div className="text-[11.5px] text-muted-foreground">This month</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tracking-tight tabular">{cents(spent)}</span>
            <span className="text-[12px] text-muted-foreground tabular">of {cents(cap)}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-[width]", pct > 85 ? "bg-warning" : "bg-brand")} style={{ width: `${Math.max(1.5, pct)}%` }} />
          </div>
        </div>
        <dl className="divide-y border-t text-[12.5px]">
          <Row label="Spending now" value={burn ? `${cents(burn)}/hr` : "-"} />
          <Row label="Team credit left" value={credit == null ? "-" : cents(credit)} />
          <Row label="Approval" value={account?.approvalThresholdCents ? `Automatic up to ${cents(account.approvalThresholdCents)}` : "You approve every machine"} />
        </dl>
      </div>
    </Section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-[12px] tabular">{value}</dd>
    </div>
  );
}
