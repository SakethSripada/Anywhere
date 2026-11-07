"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow, useWorkload } from "@/lib/data";
import { cents, centsRange, hoursRange } from "@/lib/format";
import { approach, CONFIDENCE, parsePlan, type Offer } from "@/lib/plan";
import { ACTIVE, href, liveCents } from "@/lib/workloads";
import { IconAlert, IconArrowRight, IconChevronRight, IconDesktop, IconInfo, IconWorkload } from "../icons";
import { Button } from "../ui/button";
import { StatusPill } from "../ui/status";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";

export function PlanCard({ workloadId }: { workloadId: bigint }) {
  const { workload: w, ready } = useWorkload(workloadId);
  const api = useApi();
  const now = useNow(5000);
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);

  if (!w) {
    return ready ? null : <div className="skeleton h-48 w-full max-w-xl rounded-xl" />;
  }
  const plan = parsePlan(w.planJson);
  if (!plan) return null;

  const est = plan.selected.estimate;
  const offer = plan.selected.offer;
  const blockers = plan.policy?.blockers ?? [];
  const planned = w.status === "planned";

  async function act(action: "approve" | "cancel") {
    setBusy(action);
    try {
      await api.post(`/v1/workloads/${w!.id}/${action}`);
      if (action === "approve") toast.success("Approved", "Anywhere is getting your machine ready.");
    } catch (err) {
      toast.error(action === "approve" ? "Couldn't approve" : "Couldn't cancel", err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="w-full max-w-xl animate-rise overflow-hidden rounded-xl bg-raised shadow-[inset_0_1px_0_0_oklch(1_0_0/0.05),0_0_0_1px_var(--color-line-strong),0_8px_24px_-12px_oklch(0_0_0/0.5)]">
      <header className="flex items-start gap-3 px-4 pt-4">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          {w.kind === "desktop" ? <IconDesktop size={16} /> : <IconWorkload size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-md font-semibold tracking-tight text-fg">{w.title}</h3>
          </div>
          <p className="mt-0.5 text-sm text-fg-subtle">{plan.intent.summary}</p>
        </div>
        <StatusPill status={w.status} className="mt-1" />
      </header>

      <dl className="mt-4 grid grid-cols-[4.75rem_1fr] gap-x-3 sm:grid-cols-[6.5rem_1fr] sm:gap-x-4 gap-y-3 px-4 text-sm">
        <Row label="Approach">{approach(plan)}</Row>
        <Row label="Machine">
          <span className="text-fg">{offer.label}</span>
          <span className="text-fg-subtle"> · {friendlyGpu(offer)}</span>
        </Row>
        <Row label="Estimate">
          <span className="tabular font-medium text-fg">{centsRange(est.cost_low_cents, est.cost_high_cents)}</span>
          <span className="text-fg-subtle"> · {hoursRange(est.hours_low, est.hours_high)}</span>
          <Tooltip
            content={
              <span className="block max-w-64 py-0.5 text-left font-normal leading-relaxed text-fg-muted">
                {est.assumptions.join(" ")}
              </span>
            }
          >
            <button
              type="button"
              className={cn(
                "ml-2 inline-flex translate-y-[-1px] items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-2xs font-medium outline-none focus-ring",
                est.confidence === "high" ? "bg-ok-soft text-ok" : est.confidence === "medium" ? "bg-wait-soft text-wait" : "bg-idle-soft text-fg-subtle",
              )}
            >
              {CONFIDENCE[est.confidence]}
              <IconInfo size={11} />
            </button>
          </Tooltip>
        </Row>
        {plan.outputs.length > 0 && (
          <Row label="You'll get">
            <ul className="space-y-0.5">
              {plan.outputs.map((o) => (
                <li key={o} className="flex gap-2">
                  <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-fg-faint" />
                  {o}
                </li>
              ))}
            </ul>
          </Row>
        )}
        {plan.inputs && (
          <Row label="Dataset">
            {plan.inputs.dataset_name} <span className="text-fg-subtle">· {plan.inputs.dataset_rows.toLocaleString()} rows</span>
          </Row>
        )}
      </dl>

      {(plan.warnings.length > 0 || (planned && blockers.length > 0)) && (
        <div className="mt-4 flex flex-col gap-2 px-4">
          {planned &&
            blockers.map((b) => (
              <Callout key={b} tone="bad">
                {b}
              </Callout>
            ))}
          {plan.warnings.map((m) => (
            <Callout key={m} tone="wait">
              {m}
            </Callout>
          ))}
        </div>
      )}

      <Collapsible.Root className="mt-4 border-t border-line">
        <div className="flex items-center gap-2 px-2 py-2">
          <Collapsible.Trigger className="group flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-subtle outline-none transition-colors hover:bg-hover hover:text-fg-muted focus-ring">
            <IconChevronRight size={13} className="transition-transform duration-200 ease-out group-data-[panel-open]:rotate-90" />
            Technical details
          </Collapsible.Trigger>
          <div className="ml-auto flex items-center gap-2">
            {planned ? (
              <>
                <Button variant="ghost" size="sm" loading={busy === "cancel"} disabled={!!busy} onClick={() => act("cancel")}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === "approve"}
                  disabled={!!busy || blockers.length > 0}
                  onClick={() => act("approve")}
                >
                  Approve · up to {cents(est.cost_high_cents)}
                </Button>
              </>
            ) : ACTIVE.has(w.status) || w.status === "stopped" || w.status === "succeeded" ? (
              <>
                {w.accruedCents > 0 && (
                  <span className="tabular text-xs text-fg-subtle">{cents(now ? liveCents(w, now) : w.accruedCents, { precise: true })} so far</span>
                )}
                <Link
                  href={href(w)}
                  className="group inline-flex h-7 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 text-sm font-medium text-fg outline-none transition-colors hover:bg-white/[0.1] focus-ring"
                >
                  {w.kind === "desktop" ? "Open desktop" : "View job"}
                  <IconArrowRight size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
                </Link>
              </>
            ) : null}
          </div>
        </div>
        <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-250 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
          <div className="space-y-4 border-t border-line bg-canvas/30 px-4 py-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-3">
              <Spec label="Instance" value={offer.type} mono />
              <Spec label="Provider" value={`Brev · ${offer.provider.toUpperCase()}`} />
              <Spec label="GPU" value={`${offer.gpu} · ${offer.vram_gb} GB`} />
              <Spec label="CPU / RAM" value={`${offer.vcpus} vCPU · ${offer.ram_gb} GB`} />
              <Spec label="Rate" value={`$${offer.price_per_hour.toFixed(2)}/hr`} />
              <Spec label="Stop & resume" value={offer.stoppable ? "Supported" : "Not supported"} />
            </div>
            {plan.requirements.rationale.length > 0 && (
              <Detail title="Why this machine">
                {plan.requirements.rationale.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </Detail>
            )}
            {est.assumptions.length > 0 && (
              <Detail title="Estimate assumptions">
                {est.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </Detail>
            )}
            {plan.alternatives.length > 0 && (
              <div>
                <div className="mb-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Also considered</div>
                <div className="divide-y divide-line rounded-lg shadow-[inset_0_0_0_1px_var(--color-line)]">
                  {plan.alternatives.map((alt) => (
                    <div key={alt.offer.type} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <span className="w-24 truncate text-fg-muted">{alt.offer.label}</span>
                      <span className="flex-1 truncate text-fg-subtle">{friendlyGpu(alt.offer)}</span>
                      <span className="tabular text-fg-subtle">${alt.offer.price_per_hour.toFixed(2)}/hr</span>
                      <span className="tabular w-20 text-right text-fg-muted">
                        {centsRange(alt.estimate.cost_low_cents, alt.estimate.cost_high_cents)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {offer.price_source && (
              <p className="text-2xs text-fg-faint">
                Prices from {offer.price_source}
                {offer.price_as_of && ` as of ${new Date(offer.price_as_of).toLocaleDateString()}`}. Billing is per second
                while the machine exists.
              </p>
            )}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </article>
  );
}

function friendlyGpu(o: Offer) {
  return `NVIDIA ${o.gpu} with ${o.vram_gb} GB of video memory`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-xs text-fg-faint">{label}</dt>
      <dd className="min-w-0 text-fg-muted">{children}</dd>
    </>
  );
}

function Spec({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-fg-faint">{label}</div>
      <div className={cn("mt-0.5 truncate text-fg-muted", mono && "font-mono text-2xs leading-5")}>{value}</div>
    </div>
  );
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">{title}</div>
      <ul className="space-y-1 text-xs text-fg-subtle [&>li]:relative [&>li]:pl-3 [&>li]:before:absolute [&>li]:before:top-[0.55em] [&>li]:before:left-0 [&>li]:before:size-1 [&>li]:before:rounded-full [&>li]:before:bg-fg-faint">
        {children}
      </ul>
    </div>
  );
}

function Callout({ tone, children }: { tone: "bad" | "wait"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg px-3 py-2 text-xs",
        tone === "bad" ? "bg-bad-soft text-bad" : "bg-wait-soft text-wait",
      )}
    >
      <IconAlert size={14} className="mt-px shrink-0" />
      <span className="text-fg-muted">{children}</span>
    </div>
  );
}
