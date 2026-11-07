"use client";

import { useEffect, useState } from "react";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { IconAgent, IconAlert, IconCheck } from "../icons";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Card, Stage } from "./onboarding";

type Pending = { client_name: string; redirect_host: string; scopes: string[]; scope_help: Record<string, string> };

const LABELS: Record<string, string> = { read: "View", plan: "Plan", control: "Control", spend: "Spend" };

/** OAuth consent: an MCP client (claude.ai, Claude Code, …) asks to act on this account. */
export function ConnectView({ requestId }: { requestId: string | null }) {
  const api = useApi();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(requestId ? null : "This link is missing its sign-in request.");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!requestId || !api.ready) return;
    let live = true;
    void api.get<Pending>(`/v1/oauth/requests/${encodeURIComponent(requestId)}`).then(
      (p) => {
        if (!live) return;
        setPending(p);
        // Spending is opt-in even when the app asks for it.
        setChosen(p.scopes.filter((s) => s !== "spend"));
      },
      (err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load this request."),
    );
    return () => {
      live = false;
    };
  }, [api, requestId]);

  async function decide(approve: boolean) {
    if (!requestId) return;
    setBusy(approve ? "approve" : "deny");
    try {
      const { redirect } = await api.post<{ redirect: string }>(`/v1/oauth/requests/${encodeURIComponent(requestId)}/decision`, {
        approve,
        scopes: chosen,
      });
      window.location.assign(redirect);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Start again from your app.");
      setBusy(null);
    }
  }

  if (error) {
    return (
      <Stage>
        <Card icon={<IconAlert size={16} className="text-bad" />} title="Can't connect" body={error}>
          <Button variant="secondary" className="w-full" onClick={() => window.close()}>
            Close
          </Button>
        </Card>
      </Stage>
    );
  }

  if (!pending) {
    return (
      <Stage>
        <Spinner size={18} />
      </Stage>
    );
  }

  return (
    <Stage>
      <Card
        icon={<IconAgent size={16} className="text-accent" />}
        title={`Connect ${pending.client_name}?`}
        body={`It will be able to use Anywhere on your behalf. You'll be sent back to ${pending.redirect_host}.`}
      >
        <div className="flex flex-col gap-2" role="group" aria-label="Permissions">
          {pending.scopes.map((s) => {
            const on = chosen.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => setChosen(on ? chosen.filter((x) => x !== s) : [...chosen, s])}
                className={cn(
                  "flex items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-[box-shadow,background-color] duration-150 focus-ring",
                  on ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-line)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-hover",
                )}
              >
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm", on ? "bg-accent text-fg-inverse" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]")}>
                  {on && <IconCheck size={11} />}
                </span>
                <span>
                  <span className="block text-sm font-medium text-fg">{LABELS[s] ?? s}</span>
                  <span className="block text-xs text-fg-subtle">{pending.scope_help[s] ?? s}</span>
                </span>
              </button>
            );
          })}
        </div>
        {chosen.includes("spend") && (
          <p className="mt-3 text-xs text-wait">This app could approve plans and resume machines on its own, up to your monthly cap.</p>
        )}
        <div className="mt-5 flex gap-2">
          <Button variant="ghost" className="flex-1" loading={busy === "deny"} disabled={!!busy} onClick={() => void decide(false)}>
            Deny
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            loading={busy === "approve"}
            disabled={!!busy || chosen.length === 0}
            onClick={() => void decide(true)}
          >
            Allow
          </Button>
        </div>
        <p className="mt-4 text-center text-2xs text-fg-faint">You can disconnect it any time in Settings → Agents.</p>
      </Card>
    </Stage>
  );
}
