"use client";

import { Copy, ExternalLink, Phone, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError, fetchHealth, useApi } from "@/lib/api";
import { useAccount, useMonthSpend, useNow, usePlatform } from "@/lib/data";
import { cents, ms } from "@/lib/format";
import { reducers, tables, useReducer, useSession, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";
import { AgentAccess } from "./agent-access";
import { PageHeader } from "./page-header";

const SECTIONS = [
  ["profile", "Profile"],
  ["spending", "Spending"],
  ["imessage", "iMessage"],
  ["agents", "Agents"],
  ["integrations", "Integrations"],
] as const;

export function SettingsView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Settings" />
      {/* Jump links, so the page reads as five clear sections instead of one long scroll. */}
      <nav aria-label="Settings sections" className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-4 py-2 sm:px-8">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="shrink-0 rounded-md px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              {label}
            </a>
          ))}
        </div>
      </nav>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-8">
        <Profile />
        <Spending />
        <Messaging />
        <AgentAccess Section={Section} />
        <Integrations />
      </div>
    </div>
  );
}

function Section({ id, title, description, children, footer }: { id?: string; title: string; description: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 overflow-hidden rounded-xl border bg-card">
      <div className="p-5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
        <div className="mt-5">{children}</div>
      </div>
      {footer && <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">{footer}</div>}
    </section>
  );
}

function Profile() {
  const { account } = useAccount();
  const session = useSession();
  const register = useReducer(reducers.register);
  const [name, setName] = useState(account?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [showId, setShowId] = useState(false);
  const dirty = !!account && name.trim() !== account.displayName && name.trim().length > 0;

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      await register({ displayName: name.trim() });
      toast.success("Name updated");
    } catch (err) {
      toast.error("Couldn’t save", { description: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="profile"
      title="Profile"
      description="Your account lives in this browser, so there’s no password to remember."
      footer={
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="display-name">Display name</Label>
          <Input id="display-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </div>
        {session.identity && !showId && (
          <div className="flex items-end">
            <button type="button" onClick={() => setShowId(true)} className="pb-2 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Show account ID
            </button>
          </div>
        )}
        {session.identity && showId && (
          <div className="grid gap-2">
            <Label>Account ID</Label>
            <div className="flex gap-2">
              <Input readOnly value={session.identity} className="font-mono text-xs text-muted-foreground" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy account ID"
                onClick={() => {
                  void navigator.clipboard.writeText(session.identity!);
                  toast("Account ID copied");
                }}
              >
                <Copy />
              </Button>
            </div>
          </div>
        )}
      </form>
    </Section>
  );
}

function Spending() {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const update = useReducer(reducers.updatePreferences);
  const [pref, setPref] = useState(account?.preference ?? "balanced");
  const [cap, setCap] = useState(((account?.monthlyCapCents ?? 2000) / 100).toString());
  const [auto, setAuto] = useState(((account?.approvalThresholdCents ?? 0) / 100).toString());
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const capCents = Math.round(parseFloat(cap || "0") * 100);
  const autoCents = Math.round(parseFloat(auto || "0") * 100);
  const dirty = pref !== account.preference || capCents !== account.monthlyCapCents || autoCents !== account.approvalThresholdCents;

  async function save() {
    if (!Number.isFinite(capCents) || !Number.isFinite(autoCents)) return toast.error("Enter dollar amounts");
    setBusy(true);
    try {
      await update({ preference: pref, monthlyCapCents: capCents, approvalThresholdCents: autoCents });
      toast.success("Spending policy saved");
    } catch (err) {
      toast.error("Couldn’t save", { description: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="spending"
      title="Compute and spending"
      description="Anywhere never spends past your monthly cap, and asks before anything that could cost more than your auto-approve limit."
      footer={
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          Save policy
        </Button>
      }
    >
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Label>Optimize for</Label>
          <ToggleGroup value={[pref]} onValueChange={(v) => v[0] && setPref(String(v[0]))} variant="outline" className="w-fit">
            <ToggleGroupItem value="cheapest">Cheapest</ToggleGroupItem>
            <ToggleGroupItem value="balanced">Balanced</ToggleGroupItem>
            <ToggleGroupItem value="fastest">Fastest</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="cap">Monthly cap (USD)</Label>
            <Input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            <p className="text-xs text-muted-foreground">Up to $50 during the preview.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="auto">Auto-approve up to (USD)</Label>
            <Input id="auto" inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} />
            <p className="text-xs text-muted-foreground">$0 means Anywhere always asks first.</p>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">Spent this month</span>
            <span className="tabular">
              {cents(spent)} <span className="text-muted-foreground">of {cents(account.monthlyCapCents)}</span>
            </span>
          </div>
          <Progress value={account.monthlyCapCents ? Math.min(100, (spent / account.monthlyCapCents) * 100) : 0} className="h-1.5" />
        </div>
      </div>
    </Section>
  );
}

function Messaging() {
  const api = useApi();
  const [handles] = useTable(tables.myHandles);
  const [codes] = useTable(tables.myLinkCode);
  const unlink = useReducer(reducers.unlinkHandle);
  const now = useNow(1000);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ phone: string; anywhere_number: string | null; deep_link_base: string } | null>(null);
  const code = codes[0];
  const remaining = code && now ? Math.max(0, ms(code.expiresAt) - now) : 0;

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setLink(await api.post("/v1/messaging/link", { phone }));
    } catch (err) {
      toast.error("Couldn’t start linking", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="imessage" title="iMessage" description="Text Anywhere to start tasks, check on machines and get notified when work finishes. Powered by Photon.">
      <div className="grid gap-4">
        {handles.map((h) => (
          <div key={h.handle} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <Phone className="size-4 text-muted-foreground" />
            <span className="flex-1 text-sm tabular">{h.handle}</span>
            <span className="text-[13px] text-muted-foreground">Linked</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Unlink ${h.handle}`}
              onClick={async () => {
                try {
                  await unlink({ handle: h.handle });
                  toast("Number unlinked");
                } catch (err) {
                  toast.error("Couldn’t unlink", { description: String((err as Error).message ?? err) });
                }
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        {code && remaining > 0 ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="text-[13px] text-muted-foreground">
              Text this code{link?.anywhere_number ? ` to ${link.anywhere_number}` : ""} from {code.handle || "your phone"}
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold tracking-[0.18em] tabular">{code.code}</span>
              <span className="text-xs text-muted-foreground tabular">
                expires in {Math.floor(remaining / 60000)}:{String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}
              </span>
            </div>
            {link && (
              <Button size="sm" className="mt-3" nativeButton={false} render={<a href={`${link.deep_link_base}?msg=${encodeURIComponent(code.code)}`} target="_blank" rel="noreferrer" />}>
                Open in Messages <ExternalLink />
              </Button>
            )}
          </div>
        ) : (
          <form onSubmit={start} className="grid gap-2">
            <Label htmlFor="phone">{handles.length ? "Link another number" : "Phone number"}</Label>
            <div className="flex gap-2">
              <Input id="phone" type="tel" autoComplete="tel" placeholder="+1 555 010 0199" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button type="submit" variant="outline" disabled={busy || phone.replace(/\D/g, "").length < 7}>
                Get code
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">You’ll text a one-time code from this number to prove it’s yours.</p>
          </form>
        )}
      </div>
    </Section>
  );
}

const INTEGRATIONS = [
  { key: "spacetime", name: "SpacetimeDB", role: "Realtime state and events" },
  { key: "nemotron", name: "NVIDIA Nemotron", role: "Planning and computer use" },
  { key: "brev", name: "NVIDIA Brev", role: "GPU machines" },
  { key: "storage", name: "Object storage", role: "Projects, datasets and outputs" },
  { key: "photon", name: "Photon", role: "iMessage" },
];

function Integrations() {
  // Readiness and mode come from the live platform row (the control plane
  // writes the same readiness snapshot /health serves); /health is only probed
  // to tell whether the control plane is reachable right now.
  const { platform, integrations } = usePlatform();
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof fetchHealth>> | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    void fetchHealth(ctl.signal).then((h) => {
      if (!ctl.signal.aborted) setProbe(h);
    });
    return () => ctl.abort();
  }, []);
  // Before the supervisor's first platform write, fall back to the probe's own snapshot.
  const health = probe && platform ? { mode: platform.provisioningMode, integrations } : probe;

  return (
    <Section id="integrations" title="Integrations" description="What this deployment is connected to. Keys live only on the server.">
      {health === undefined ? (
        <div className="grid gap-3">
          {INTEGRATIONS.map((i) => (
            <Skeleton key={i.key} className="h-5 w-2/3" />
          ))}
        </div>
      ) : health === null ? (
        <p className="text-sm text-destructive">The control plane isn’t reachable.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {INTEGRATIONS.map((i) => {
            const on = !!health.integrations[i.key];
            return (
              <div key={i.key} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="w-40 font-medium">{i.name}</span>
                <span className="flex-1 truncate text-[13px] text-muted-foreground">{i.role}</span>
                <span className={cn("text-[13px]", on ? "text-foreground" : "text-muted-foreground")}>{on ? "Connected" : "Not configured"}</span>
              </div>
            );
          })}
          <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <span className="w-40 font-medium">Provisioning</span>
            <span className="flex-1 truncate text-[13px] text-muted-foreground">
              {health.mode === "live" ? "Approved plans create real, billed machines" : "Plans are produced, but no machine is created"}
            </span>
            <span className="text-[13px]">{health.mode === "live" ? "Live" : health.mode === "dry_run" ? "Dry run" : "Off"}</span>
          </div>
        </div>
      )}
    </Section>
  );
}
