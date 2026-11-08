"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, useApi } from "@/lib/api";
import { useWorkload } from "@/lib/data";
import { centsRange, hoursRange } from "@/lib/format";
import { approach, CONFIDENCE, parsePlan, type Offer } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { ACTIVE, href } from "@/lib/workloads";
import { StatusText } from "../machines/status";
import { GpuCompare } from "./gpu-compare";
import { RenderTimeTable } from "./render-time";

function useActions(id: bigint) {
  const api = useApi();
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  async function act(action: "approve" | "cancel") {
    setBusy(action);
    try {
      await api.post(`/v1/workloads/${id}/${action}`);
    } catch (err) {
      toast.error(action === "approve" ? "Couldn’t approve" : "Couldn’t cancel", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }
  return { busy, act };
}

/** A compute plan awaiting a decision, presented like a permission prompt. */
export function PlanCard({ workloadId }: { workloadId: bigint }) {
  const { workload: w, ready } = useWorkload(workloadId);
  const { busy, act } = useActions(workloadId);
  const [compare, setCompare] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);

  if (!w) return ready ? null : <Skeleton className="h-40 w-full max-w-xl rounded-2xl" />;
  const plan = parsePlan(w.planJson);
  if (!plan) return null;

  const est = plan.selected.estimate;
  const offer = plan.selected.offer;
  const blockers = plan.policy?.blockers ?? [];
  const planned = w.status === "planned";
  const openable = ACTIVE.has(w.status) || w.status === "stopped" || w.status === "succeeded";

  return (
    <article className="w-full max-w-xl rounded-2xl border bg-card">
      <div className="px-5 pt-4 pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="truncate text-[15px] font-medium">{w.title}</h3>
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 cursor-help text-[15px] font-medium tabular" />}>
              {centsRange(est.cost_low_cents, est.cost_high_cents)}
            </TooltipTrigger>
            <TooltipContent className="max-w-72 text-left leading-relaxed">
              {CONFIDENCE[est.confidence]}. {est.assumptions.join(" ")}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-4 text-[13px] text-muted-foreground">
          <span className="truncate">
            NVIDIA {offer.gpu} · {offer.vram_gb} GB · {hoursRange(est.hours_low, est.hours_high)}
          </span>
          <span className="shrink-0 tabular">${offer.price_per_hour.toFixed(2)}/hr</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground/80">
          {approach(plan)}.{plan.outputs.length > 0 && ` You’ll get ${lowerList(plan.outputs)}.`}
        </p>
        {plan.inputs?.dataset_name && (
          <p className="mt-1 text-[13px] text-muted-foreground">
            Training on {plan.inputs.dataset_name} ({(plan.inputs.dataset_rows ?? 0).toLocaleString()} rows)
          </p>
        )}
        {plan.requirements.mode === "interactive" && (
          <p className="mt-1 text-[13px] text-muted-foreground">Billed only while it runs. Stop any time and resume later.</p>
        )}
        {planned &&
          blockers.map((b) => (
            <p key={b} className="mt-3 text-[13px] text-destructive">
              {b}
            </p>
          ))}
        {plan.warnings.map((m) => (
          <p key={m} className="mt-3 text-[13px] text-muted-foreground">
            Note: {m}
          </p>
        ))}
      </div>

      <Collapsible>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2">
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
            Details
            <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
          </CollapsibleTrigger>
          {plan.alternatives.length > 0 && (
            <button
              type="button"
              aria-expanded={compare}
              onClick={() => setCompare((c) => !c)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[13px] whitespace-nowrap transition-colors hover:text-foreground",
                compare ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Compare
              <ChevronDown className={cn("size-3.5 transition-transform", compare && "rotate-180")} />
            </button>
          )}
          {!!plan.render_time?.rows.length && (
            <button
              type="button"
              aria-expanded={renderOpen}
              onClick={() => setRenderOpen((o) => !o)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[13px] whitespace-nowrap transition-colors hover:text-foreground",
                renderOpen ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Render time
              <ChevronDown className={cn("size-3.5 transition-transform", renderOpen && "rotate-180")} />
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {planned ? (
              <>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act("cancel")}>
                  Cancel
                </Button>
                <Button size="sm" disabled={!!busy || blockers.length > 0} onClick={() => act("approve")}>
                  {busy === "approve" ? "Approving…" : "Approve"}
                </Button>
              </>
            ) : (
              <>
                <StatusText status={w.status} className="px-1" />
                {openable && (
                  <Button size="sm" variant="ghost" nativeButton={false} render={<Link href={href(w)} />}>
                    Open <ArrowUpRight className="size-3.5" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        <CollapsibleContent>
          <div className="space-y-5 border-t px-5 py-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
              <Spec label="Machine" value={offer.label} />
              <Spec label="Instance" value={offer.type} mono />
              <Spec label="Provider" value={`NVIDIA Brev · ${offer.provider.toUpperCase()}`} />
              <Spec label="CPU / RAM" value={`${offer.vcpus} vCPU · ${offer.ram_gb} GB`} />
              <Spec label="Billing" value="Per second while it exists" />
              <Spec label="Stop and resume" value={offer.stoppable ? "Supported" : "Not supported"} />
            </dl>
            <Detail title="Why this machine" items={plan.requirements.rationale} />
            <Detail title="How the estimate was made" items={est.assumptions} />
            {plan.alternatives.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Also considered</div>
                {plan.alternatives.map((a) => (
                  <AltRow key={a.offer.type} offer={a.offer} low={a.estimate.cost_low_cents} high={a.estimate.cost_high_cents} />
                ))}
              </div>
            )}
            {offer.price_source && (
              <p className="text-xs text-muted-foreground">
                Prices from {offer.price_source}
                {offer.price_as_of && `, ${new Date(offer.price_as_of).toLocaleDateString()}`}.
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {compare && <GpuCompare plan={plan} />}
      {renderOpen && plan.render_time && (
        <div className="border-t px-5 py-4">
          <h4 className="mb-2 text-[13px] font-medium">How long a frame takes</h4>
          <RenderTimeTable data={plan.render_time} chosen={plan.selected.offer.gpu} />
        </div>
      )}
    </article>
  );
}

/** The plan as one row, for narrow surfaces like a machine's agent panel. */
export function PlanRow({ workloadId }: { workloadId: bigint }) {
  const { workload: w } = useWorkload(workloadId);
  const { busy, act } = useActions(workloadId);
  if (!w) return null;
  const plan = parsePlan(w.planJson);
  if (!plan) return null;
  const est = plan.selected.estimate;

  return (
    <div className="flex items-center gap-3 rounded-xl border px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{w.title}</div>
        <div className="truncate text-xs text-muted-foreground tabular">
          NVIDIA {plan.selected.offer.gpu} · {centsRange(est.cost_low_cents, est.cost_high_cents)} · {hoursRange(est.hours_low, est.hours_high)}
        </div>
      </div>
      {w.status === "planned" ? (
        <Button size="xs" disabled={!!busy || (plan.policy?.blockers.length ?? 0) > 0} onClick={() => act("approve")}>
          Approve
        </Button>
      ) : (
        <StatusText status={w.status} className="text-xs" />
      )}
    </div>
  );
}

function lowerList(items: string[]) {
  const l = items.map((s) => s.charAt(0).toLowerCase() + s.slice(1));
  return l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0];
}

function Spec({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate", mono && "font-mono text-xs leading-5")}>{value}</dd>
    </div>
  );
}

function Detail({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{title}</div>
      <ul className="list-disc space-y-0.5 pl-4 text-[13px] leading-6 text-foreground/80 marker:text-muted-foreground">
        {items.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function AltRow({ offer, low, high }: { offer: Offer; low: number; high: number }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[13px]">
      <span className="w-28 truncate">{offer.label}</span>
      <span className="flex-1 truncate text-muted-foreground">
        NVIDIA {offer.gpu} · {offer.vram_gb} GB
      </span>
      <span className="text-muted-foreground tabular">${offer.price_per_hour.toFixed(2)}/hr</span>
      <span className="w-24 text-right tabular">{centsRange(low, high)}</span>
    </div>
  );
}
