"use client";

import { Bot, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, useApi } from "@/lib/api";
import { PermissionSwitches } from "./agent-access";
import { LogoMark } from "./logo";

type Pending = { client_name: string; redirect_host: string; scopes: string[]; scope_help: Record<string, string> };

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-4 py-10">
      <div className="mb-8 flex items-center gap-2">
        <LogoMark className="size-7" />
        <span className="text-lg font-semibold tracking-tight">Anywhere</span>
      </div>
      <div className="w-full max-w-[400px]">{children}</div>
    </div>
  );
}

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
      (err) => live && setError(err instanceof ApiError ? err.message : "Couldn’t load this request."),
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleAlert className="size-4 text-destructive" /> Can’t connect
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </Stage>
    );
  }

  if (!pending) {
    return (
      <Stage>
        <Skeleton className="h-72 w-full rounded-xl" />
      </Stage>
    );
  }

  return (
    <Stage>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" /> Connect {pending.client_name}?
          </CardTitle>
          <CardDescription>
            It will be able to use Anywhere on your behalf. Afterwards you’ll be sent back to {pending.redirect_host}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PermissionSwitches scopes={pending.scopes} chosen={chosen} help={pending.scope_help} onChange={setChosen} />
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <div className="flex w-full gap-2">
            <Button variant="outline" className="flex-1" disabled={!!busy} onClick={() => void decide(false)}>
              {busy === "deny" ? "Denying…" : "Deny"}
            </Button>
            <Button className="flex-1" disabled={!!busy || chosen.length === 0} onClick={() => void decide(true)}>
              {busy === "approve" ? "Connecting…" : "Allow"}
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">You can disconnect it any time in Settings → Agents.</p>
        </CardFooter>
      </Card>
    </Stage>
  );
}
