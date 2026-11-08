"use client";

import { Bot, Copy, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError, useApi } from "@/lib/api";
import { config } from "@/lib/config";
import { useNow } from "@/lib/data";
import { ago } from "@/lib/format";

export const SCOPE_LABELS: Record<string, string> = { read: "View", plan: "Plan", control: "Control", spend: "Spend" };
const DEFAULT_SCOPES = ["read", "plan", "control"];

type McpToken = {
  id: number;
  name: string;
  scopes: string[];
  hint: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
};
type Grant = { id: number; client_name: string; scopes: string[]; created_at: string; last_used_at: string | null };
type Loaded = { tokens: McpToken[] | null; grants: Grant[]; scopes: Record<string, string>; error: string | null };

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast.error("Couldn’t copy", { description: "Select the text and copy it manually." }),
  );
}

/** One switch per permission. Shared by Settings and the OAuth consent page. */
export function PermissionSwitches({
  scopes,
  chosen,
  help,
  onChange,
}: {
  scopes: string[];
  chosen: string[];
  help: Record<string, string>;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="grid gap-2">
      {scopes.map((s) => {
        const on = chosen.includes(s);
        return (
          <label key={s} className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
            <Switch className="mt-0.5" checked={on} onCheckedChange={(v) => onChange(v ? [...chosen, s] : chosen.filter((x) => x !== s))} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{SCOPE_LABELS[s] ?? s}</span>
              {help[s] && <span className="text-[13px] text-muted-foreground">{help[s]}</span>}
            </span>
          </label>
        );
      })}
      {chosen.includes("spend") && (
        <p className="text-xs text-amber-500">With Spend, it can approve plans and resume machines on its own, up to your monthly cap.</p>
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  detail,
  scopes,
  onRemove,
  removeLabel,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  scopes: string[];
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="hidden gap-1 sm:flex">
        {scopes.map((s) => (
          <Badge key={s} variant={s === "spend" ? "destructive" : "secondary"}>
            {SCOPE_LABELS[s] ?? s}
          </Badge>
        ))}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={removeLabel} onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}

/** Settings → Agents: the MCP endpoint, connected OAuth apps, and personal tokens. */
export function AgentAccess({ Section }: { Section: (p: { title: string; description: string; children: React.ReactNode }) => React.ReactNode }) {
  const api = useApi();
  const now = useNow(60_000);
  const [data, setData] = useState<Loaded>({ tokens: null, grants: [], scopes: {}, error: null });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const endpoint = typeof window === "undefined" ? `${config.apiUrl}/mcp` : new URL(`${config.apiUrl}/mcp`, window.location.href).href;

  const fetchAll = useCallback(
    (): Promise<Loaded> =>
      Promise.all([
        api.get<{ tokens: McpToken[]; scopes: Record<string, string> }>("/v1/mcp/tokens"),
        // OAuth may be off on this server; connected apps are then simply empty.
        api.get<{ grants: Grant[] }>("/v1/oauth/grants").catch(() => ({ grants: [] as Grant[] })),
      ]).then(
        ([t, g]) => ({ tokens: t.tokens, grants: g.grants, scopes: t.scopes, error: null }),
        (err) => ({
          tokens: null,
          grants: [],
          scopes: {},
          error: err instanceof ApiError && err.status === 404 ? "Agent access is turned off on this server." : "Couldn’t load agent access.",
        }),
      ),
    [api],
  );
  const reload = useCallback(() => fetchAll().then(setData), [fetchAll]);

  useEffect(() => {
    if (!api.ready) return;
    let live = true;
    void fetchAll().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [api.ready, fetchAll]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<McpToken & { token: string }>("/v1/mcp/tokens", { name: name.trim(), scopes });
      setCreated(res.token);
      setName("");
      setScopes(DEFAULT_SCOPES);
      await reload();
    } catch (err) {
      toast.error("Couldn’t create token", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string, done: string) {
    try {
      await api.del(path);
      toast(done);
      await reload();
    } catch (err) {
      toast.error("Couldn’t remove", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const when = (iso: string | null) => (iso ? `used ${ago(new Date(iso), now || undefined)}` : "never used");
  const command = created ? `claude mcp add --transport http anywhere ${endpoint} --header "Authorization: Bearer ${created}"` : "";

  return (
    <Section
      title="Agents (MCP)"
      description="Let Claude and other MCP clients use Anywhere as a tool. Apps that support OAuth only need the server URL; others use a token. Neither can approve spending unless you allow it."
    >
      <div className="grid gap-5">
        <div className="grid gap-2">
          <Label>Server URL</Label>
          <div className="flex gap-2">
            <Input readOnly value={endpoint} className="font-mono text-xs text-muted-foreground" />
            <Button type="button" variant="outline" size="icon" aria-label="Copy server URL" onClick={() => copy(endpoint, "URL")}>
              <Copy />
            </Button>
          </div>
        </div>

        {data.error ? (
          <p className="text-sm text-destructive">{data.error}</p>
        ) : data.tokens === null ? (
          <Skeleton className="h-11 w-full" />
        ) : (
          <>
            {data.grants.length > 0 && (
              <div className="grid gap-2">
                <Label>Connected apps</Label>
                {data.grants.map((g) => (
                  <Row
                    key={g.id}
                    icon={<Bot />}
                    title={g.client_name}
                    detail={`Signed in with OAuth · ${when(g.last_used_at)}`}
                    scopes={g.scopes}
                    removeLabel={`Disconnect ${g.client_name}`}
                    onRemove={() => void remove(`/v1/oauth/grants/${g.id}`, `Disconnected ${g.client_name}`)}
                  />
                ))}
              </div>
            )}

            {data.tokens.length > 0 && (
              <div className="grid gap-2">
                <Label>Tokens</Label>
                {data.tokens.map((t) => {
                  const expired = now > 0 && new Date(t.expires_at).getTime() <= now;
                  return (
                    <Row
                      key={t.id}
                      icon={<KeyRound />}
                      title={t.name}
                      detail={`${t.hint}… · ${when(t.last_used_at)} · ${expired ? "expired" : `expires ${ago(new Date(t.expires_at), now || undefined)}`}`}
                      scopes={t.scopes}
                      removeLabel={`Revoke ${t.name}`}
                      onRemove={() => void remove(`/v1/mcp/tokens/${t.id}`, `Revoked “${t.name}”`)}
                    />
                  );
                })}
              </div>
            )}

            {created ? (
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-4">
                <p className="text-[13px] text-muted-foreground">Copy this token now. It won’t be shown again.</p>
                <div className="flex gap-2">
                  <Input readOnly value={created} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" aria-label="Copy token" onClick={() => copy(created, "Token")}>
                    <Copy />
                  </Button>
                </div>
                <p className="text-[13px] text-muted-foreground">Add it to Claude Code:</p>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-2.5 py-2 font-mono text-xs">{command}</code>
                  <Button variant="outline" size="icon" aria-label="Copy command" onClick={() => copy(command, "Command")}>
                    <Copy />
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={create} className="grid gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="mcp-name">New token</Label>
                  <Input id="mcp-name" placeholder="Claude Code on my laptop" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <PermissionSwitches scopes={Object.keys(SCOPE_LABELS)} chosen={scopes} help={data.scopes} onChange={setScopes} />
                <div className="flex justify-end">
                  <Button type="submit" variant="outline" disabled={busy || !name.trim() || scopes.length === 0}>
                    Create token
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
