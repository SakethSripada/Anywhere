"use client";

import type { Workload } from "@anywhere/stdb";
import { ChevronLeft, Download, FileText, MessageSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, useApi } from "@/lib/api";
import { useWorkload } from "@/lib/data";
import { bytes, centsRange, clock } from "@/lib/format";
import { parsePlan } from "@/lib/plan";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";
import { BILLABLE } from "@/lib/workloads";
import { MobileNavTrigger } from "../app/mobile-nav";
import { PlanCard } from "../chat/plan-card";
import { AgentSidebar } from "./agent-sidebar";
import { LogView } from "./log-view";
import { MetricChart } from "./metric-chart";
import { BootProgress, EventFeed, LiveCost, Uptime, useWorkloadAction } from "./shared";
import { StatusBadge } from "./status";
import { VncScreen } from "./vnc-screen";

export function MachineView({ id }: { id: string }) {
  const wid = /^\d+$/.test(id) ? BigInt(id) : null;
  const { workload: w, ready } = useWorkload(wid);
  if (!w) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
        {ready ? "This machine doesn’t exist or isn’t yours." : <Skeleton className="h-5 w-48" />}
      </div>
    );
  }
  return <Machine w={w} />;
}

function Machine({ w }: { w: Workload }) {
  const [chatOpen, setChatOpen] = useState(true);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header w={w} chatOpen={chatOpen} onToggleChat={() => setChatOpen((o) => !o)} />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="68%" minSize="40%">
          <div className="h-full min-h-0">{w.kind === "desktop" ? <DesktopMain w={w} /> : <JobMain w={w} />}</div>
        </ResizablePanel>
        {chatOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="32%" minSize="22%" maxSize="50%">
              <AgentSidebar w={w} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

function Header({ w, chatOpen, onToggleChat }: { w: Workload; chatOpen: boolean; onToggleChat: () => void }) {
  const router = useRouter();
  const { busy, run } = useWorkloadAction(w.id);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const running = w.status === "running";
  const canDelete = !["terminated", "cancelled", "planned"].includes(w.status);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <MobileNavTrigger />
      <Button variant="ghost" size="icon-sm" aria-label="All machines" nativeButton={false} render={<Link href="/machines" />}>
        <ChevronLeft />
      </Button>
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-[15px] font-medium">{w.title}</h1>
        <StatusBadge status={w.status} />
      </div>
      <div className="hidden items-center gap-3 pl-2 text-[13px] text-muted-foreground lg:flex">
        <span>{w.gpuName}</span>
        <span className="h-3.5 w-px bg-border" />
        <span>
          Up <Uptime w={w} />
        </span>
        <span className="h-3.5 w-px bg-border" />
        <LiveCost w={w} className="text-foreground" />
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {w.kind === "desktop" && running && (
          <Button size="sm" variant="outline" disabled={busy === "save"} onClick={() => void run("save")}>
            Save
          </Button>
        )}
        {running && (
          <Button size="sm" variant="outline" onClick={() => setConfirm(w.kind === "desktop" && w.stoppable ? "stop" : "delete")}>
            {w.kind === "desktop" ? (w.stoppable ? "Stop" : "Shut down") : "Stop job"}
          </Button>
        )}
        {w.status === "stopped" && (
          <Button size="sm" disabled={busy === "resume"} onClick={() => void run("resume")}>
            Resume
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={chatOpen ? "Hide agent" : "Show agent"} onClick={onToggleChat}>
          {chatOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {w.conversationId > 0n && (
              <DropdownMenuItem onClick={() => router.push(`/c/${w.conversationId}`)}>
                <MessageSquare /> Open full chat
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(String(w.id));
                toast("Machine ID copied");
              }}
            >
              <FileText /> Copy machine ID
            </DropdownMenuItem>
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}>
                  <Trash2 /> Delete machine
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Confirm
        open={confirm === "stop"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Stop this desktop?"
        description="Anywhere saves ~/Projects to durable storage, then stops the machine. Billing pauses and you can resume any time."
        action="Save and stop"
        onConfirm={async () => (await run("stop")) && setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this machine?"
        description={
          running
            ? "Project files are saved before the machine is destroyed. Anything outside ~/Projects is lost."
            : "The machine is destroyed permanently. Saved project files and outputs stay in your storage."
        }
        action="Delete machine"
        destructive
        onConfirm={async () => (await run(w.status === "running" && w.kind === "batch" ? "stop" : "delete")) && setConfirm(null)}
      />
    </header>
  );
}

function Confirm(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant={props.destructive ? "destructive" : "default"} onClick={props.onConfirm}>
            {props.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Desktop ─────────────────────────────────────────────────────────── */

function DesktopMain({ w }: { w: Workload }) {
  if (w.status === "running" || w.status === "saving") return <LiveDesktop w={w} />;
  return <StateScreen w={w} />;
}

function LiveDesktop({ w }: { w: Workload }) {
  const api = useApi();
  const [runs] = useTable(tables.myAgentRuns);
  const [steps] = useTable(tables.myAgentSteps);
  const [switching, setSwitching] = useState(false);
  const latest = useMemo(
    () => runs.filter((r) => r.workloadId === w.id).sort((a, b) => Number(b.startedAt.toMillis() - a.startedAt.toMillis()))[0],
    [runs, w.id],
  );
  const lastStep = useMemo(() => (latest ? steps.filter((s) => s.runId === latest.id).sort((a, b) => b.seq - a.seq)[0] : undefined), [steps, latest]);
  // The agent only holds the mouse while it is actually working; otherwise the desktop is yours.
  const working = w.controller === "agent" && latest?.status === "running";
  const paused = !working && latest?.status === "paused";

  async function handOff(to: "user" | "agent") {
    setSwitching(true);
    try {
      await api.post(`/v1/workloads/${w.id}/agent/${to === "user" ? "stop" : "resume"}`);
    } catch (err) {
      toast.error("Couldn’t switch control", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <VncScreen
      workloadId={w.id}
      viewOnly={working}
      className={cn(working && "ring-2 ring-inset ring-primary/60")}
      overlay={
        (working || paused || w.status === "saving") && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
            <div className="flex max-w-xl min-w-0 items-center gap-3 rounded-full border bg-background py-1 pr-1 pl-4 shadow-lg">
              <span className="min-w-0 truncate text-[13px]">
                {working ? (
                  <>
                    <span className="font-medium text-primary">Agent is working</span>
                    {lastStep && <span className="text-muted-foreground"> · {lastStep.summary}</span>}
                  </>
                ) : paused ? (
                  <span className="text-muted-foreground">You took over. The agent can pick up where it left off.</span>
                ) : (
                  <span className="text-muted-foreground">Saving your project…</span>
                )}
              </span>
              {(working || paused) && (
                <Button size="sm" className="shrink-0 rounded-full" variant={working ? "default" : "secondary"} disabled={switching} onClick={() => void handOff(working ? "user" : "agent")}>
                  {working ? "Take over" : "Let the agent continue"}
                </Button>
              )}
            </div>
          </div>
        )
      }
    />
  );
}

function StateScreen({ w }: { w: Workload }) {
  const { busy, run } = useWorkloadAction(w.id);
  if (w.status === "planned") {
    return (
      <div className="grid h-full place-items-center overflow-y-auto p-6">
        <PlanCard workloadId={w.id} />
      </div>
    );
  }
  const booting = ["approved", "provisioning", "configuring"].includes(w.status);
  const title = booting
    ? `Getting your ${w.kind === "desktop" ? "desktop" : "job"} ready`
    : w.status === "stopped"
      ? "Desktop stopped"
      : w.status === "stopping"
        ? "Stopping"
        : w.status === "failed"
          ? "This machine ran into a problem"
          : w.status === "cancelled"
            ? "Cancelled"
            : w.status === "succeeded"
              ? "Finished"
              : "Deleted";
  const body = booting
    ? "This usually takes 5–10 minutes. You can close this tab — Anywhere keeps going and lets you know."
    : w.status === "stopped"
      ? "Your project is saved and billing is paused. Resuming takes a few minutes."
      : w.statusDetail || "No machine is running or billing for this.";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-lg flex-col px-6 py-16">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
        {booting && (
          <div className="mt-8">
            <BootProgress w={w} />
          </div>
        )}
        {w.status === "stopped" && (
          <Button className="mt-6 w-fit" disabled={busy === "resume"} onClick={() => void run("resume")}>
            Resume desktop
          </Button>
        )}
        <div className="mt-10 border-t pt-6">
          <div className="mb-3 text-xs font-medium text-muted-foreground">Activity</div>
          <EventFeed workloadId={w.id} limit={10} />
        </div>
      </div>
    </div>
  );
}

/* ── Batch job ───────────────────────────────────────────────────────── */

function JobMain({ w }: { w: Workload }) {
  if (w.status === "planned" || ["approved", "provisioning", "configuring"].includes(w.status)) return <StateScreen w={w} />;
  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col gap-0">
      <div className="shrink-0 px-6 pt-4">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="overview" className="min-h-0 overflow-y-auto px-6 py-5">
        <JobOverview w={w} />
      </TabsContent>
      <TabsContent value="logs" className="flex min-h-0 flex-col px-6 py-5">
        <LogView workloadId={w.id} className="flex-1" />
      </TabsContent>
      <TabsContent value="activity" className="min-h-0 overflow-y-auto px-6 py-5">
        <EventFeed workloadId={w.id} />
      </TabsContent>
    </Tabs>
  );
}

function JobOverview({ w }: { w: Workload }) {
  const plan = useMemo(() => parsePlan(w.planJson), [w.planJson]);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border lg:grid-cols-4">
        <Stat label="Spent">
          <LiveCost w={w} />
        </Stat>
        <Stat label="Estimate">{centsRange(w.estLowCents, w.estHighCents)}</Stat>
        <Stat label="Runtime">
          <Uptime w={w} />
        </Stat>
        <Stat label="GPU">{w.gpuName}</Stat>
      </div>
      <Metrics workloadId={w.id} />
      <section>
        <h3 className="mb-3 text-sm font-medium">Outputs</h3>
        <Artifacts workloadId={w.id} expected={plan?.outputs ?? []} done={!BILLABLE.has(w.status)} />
      </section>
      <section className="min-h-80">
        <h3 className="mb-3 text-sm font-medium">Live output</h3>
        <LogView workloadId={w.id} className="h-80" />
      </section>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-r border-b px-4 py-3 last:border-r-0 lg:border-b-0 [&:nth-child(2)]:border-r-0 lg:[&:nth-child(2)]:border-r">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tracking-tight tabular">{children}</div>
    </div>
  );
}

function Metrics({ workloadId }: { workloadId: bigint }) {
  const [rows] = useTable(tables.myMetrics);
  const series = useMemo(() => {
    const by = new Map<string, { step: number; value: number }[]>();
    for (const r of rows) {
      if (r.workloadId !== workloadId || !Number.isFinite(r.value)) continue;
      by.set(r.name, [...(by.get(r.name) ?? []), { step: r.step, value: r.value }]);
    }
    for (const list of by.values()) list.sort((a, b) => a.step - b.step);
    return by;
  }, [rows, workloadId]);
  const names = [...series.keys()].sort((a, b) => (a === "loss" ? -1 : b === "loss" ? 1 : a.localeCompare(b)));
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked && series.has(picked) ? picked : (names[0] ?? "loss");
  const points = series.get(name) ?? [];
  const latest = points.at(-1);

  return (
    <section className="rounded-xl border p-4">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div>
          <div className="text-sm font-medium">Training metrics</div>
          {latest && (
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular">
              {latest.value.toPrecision(4)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {name} · step {latest.step.toLocaleString()}
              </span>
            </div>
          )}
        </div>
        {names.length > 1 && (
          <Tabs value={name} onValueChange={(v) => setPicked(String(v))} className="ml-auto">
            <TabsList>
              {names.map((n) => (
                <TabsTrigger key={n} value={n}>
                  {n.replace(/_/g, " ")}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </div>
      <MetricChart points={points} label={name.replace(/_/g, " ")} />
    </section>
  );
}

function Artifacts({ workloadId, expected, done }: { workloadId: bigint; expected: string[]; done: boolean }) {
  const api = useApi();
  const [rows] = useTable(tables.myArtifacts);
  const files = useMemo(() => rows.filter((a) => a.workloadId === workloadId && !a.name.startsWith("agent-")), [rows, workloadId]);

  async function download(key: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/v1/files?key=${encodeURIComponent(key)}`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast.error("Download failed", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (!files.length) {
    return (
      <div className="rounded-xl border border-dashed p-4 text-[13px] text-muted-foreground">
        {done ? "This run didn’t produce any files." : "Outputs appear here as they’re saved:"}
        {!done && expected.length > 0 && (
          <ul className="mt-2 space-y-1 text-foreground">
            {expected.map((e) => (
              <li key={e}>· {e}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {files.map((a) => (
        <li key={String(a.id)}>
          <button type="button" onClick={() => void download(a.storageKey)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50">
            <FileText className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{a.name}</span>
              <span className="text-xs text-muted-foreground">
                {bytes(a.sizeBytes)} · {clock(a.createdAt)}
              </span>
            </span>
            <Download className="size-4 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}
