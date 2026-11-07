"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { parseOutput, type ToolCall } from "@/lib/chat";
import { useWorkloads } from "@/lib/data";
import { cn } from "@/lib/utils";
import { AgentRunInline, useRunSteps } from "./agent-run";

/*
 * Tool activity, the way Codex and Claude show it: quiet grey lines of
 * "verb + object", a chevron to disclose what went in and came out, a
 * shimmer while running and red only when something failed.
 */

type Labels = { running: string; done: string; failed: string };

const LABELS: Record<string, Labels> = {
  propose_workload: { running: "Planning compute for", done: "Planned compute for", failed: "Couldn’t plan" },
  approve_workload: { running: "Approving", done: "Approved", failed: "Couldn’t approve" },
  list_workloads: { running: "Checking your machines", done: "Checked your machines", failed: "Couldn’t list machines" },
  inspect_workload: { running: "Inspecting", done: "Inspected", failed: "Couldn’t inspect" },
  stop_workload: { running: "Stopping", done: "Stopped", failed: "Couldn’t stop" },
  resume_desktop: { running: "Resuming", done: "Resumed", failed: "Couldn’t resume" },
  save_project: { running: "Saving", done: "Saved", failed: "Couldn’t save" },
  delete_workload: { running: "Deleting", done: "Deleted", failed: "Couldn’t delete" },
  operate_desktop: { running: "Working in the desktop", done: "Worked in the desktop", failed: "Desktop task stopped" },
};

export function ToolRun({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(true);
  if (calls.length === 1) return <ToolRow call={calls[0]} />;
  const running = calls.some((c) => !c.result);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={cn(running && "shimmer-text")}>{running ? `Running ${calls.length} steps` : `${calls.length} steps`}</span>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Reveal open={open}>
        <div className="mt-1 flex flex-col gap-1 border-l pl-3.5">
          {calls.map((c) => (
            <ToolRow key={c.callId} call={c} />
          ))}
        </div>
      </Reveal>
    </div>
  );
}

function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className="grid transition-[grid-template-rows,opacity] duration-300 ease-out" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function ToolRow({ call }: { call: ToolCall }) {
  const { all } = useWorkloads();
  const labels = LABELS[call.name] ?? { running: call.name, done: call.name, failed: call.name };
  const output = call.result ? parseOutput(call.result.output) : null;
  const runId = call.name === "operate_desktop" && output?.run_id != null ? BigInt(String(output.run_id)) : null;
  const { run } = useRunSteps(runId);
  // A desktop task outlives its tool call: it's running until the agent run ends.
  const state =
    !call.result || run?.status === "running" ? "running" : !call.result.ok || (run && run.status !== "done") ? "failed" : "done";
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? runId != null;
  const workload = all.find((w) => w.id === call.workloadId);
  const object = objectFor(call, workload?.title);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="group flex max-w-full items-center gap-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={cn("min-w-0 truncate", state === "running" && "shimmer-text", state === "failed" && "text-destructive")}>
          {labels[state]}
          {object && <span className={cn(state !== "running" && "text-foreground/70 group-hover:text-foreground")}> {object}</span>}
        </span>
        <ChevronRight className={cn("size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-200 group-hover:opacity-100", open && "rotate-90 opacity-100")} />
      </button>
      <Reveal open={open}>
        <div className="pt-1.5 pb-2">
          {runId != null && workload ? <AgentRunInline workload={workload} runId={runId} /> : <ToolDetail call={call} output={output} />}
        </div>
      </Reveal>
    </div>
  );
}

function ToolDetail({ call, output }: { call: ToolCall; output: Record<string, unknown> | null }) {
  const args = Object.entries(call.args).filter(([, v]) => v !== null && v !== undefined && v !== "");
  const message = typeof output?.message === "string" ? output.message : null;
  return (
    <div className="overflow-hidden rounded-xl border text-xs">
      {args.length > 0 && (
        <div className="border-b bg-muted/30 px-3 py-2.5">
          <div className="mb-1.5 text-muted-foreground">Input</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono">
            {args.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 truncate">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="px-3 py-2.5">
        <div className="mb-1.5 text-muted-foreground">{call.result ? `Result · ${(call.result.ms / 1000).toFixed(1)}s` : "Running…"}</div>
        {call.result &&
          (message ? (
            <p className={cn("text-[13px]", !call.result.ok && "text-destructive")}>{message}</p>
          ) : (
            <pre className="max-h-56 overflow-auto font-mono text-[11.5px] leading-5 whitespace-pre-wrap">
              {output ? JSON.stringify(output, null, 2) : call.result.output}
            </pre>
          ))}
        {call.workloadId > 0n && call.name !== "list_workloads" && (
          <Link href={`/w/${call.workloadId}`} className="mt-2 inline-block text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Open machine
          </Link>
        )}
      </div>
    </div>
  );
}

function objectFor(call: ToolCall, title?: string): string | null {
  const a = call.args;
  if (call.name === "propose_workload") return String(a.summary ?? a.kind ?? "") || null;
  if (call.name === "operate_desktop") return null;
  if (call.name === "list_workloads") return null;
  return title ?? (a.workload_id ? `#${a.workload_id}` : null);
}
