"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, fetchHealth, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAccount, useMonthSpend, useNow } from "@/lib/data";
import { cents, ms } from "@/lib/format";
import { reducers, tables, useReducer, useSession, useTable } from "@/lib/stdb";
import { IconArrowUpRight, IconCheck, IconCopy, IconMessage, IconPhone, IconTrash } from "../icons";
import { Button, IconButton } from "../ui/button";
import { Field, Input } from "../ui/field";
import { Meter } from "../ui/meter";
import { Badge, Dot } from "../ui/status";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { PageHeader } from "../workloads/workload-list";

export function SettingsView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Settings" />
      <div className="flex w-full max-w-3xl flex-col gap-10 px-5 pb-16 sm:px-8">
        <Profile />
        <Spending />
        <Messaging />
        <Integrations />
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8">
      <div>
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-fg-faint">{description}</p>}
      </div>
      <div className="min-w-0 rounded-xl bg-canvas/30 p-5 shadow-[inset_0_0_0_1px_var(--color-line)]">{children}</div>
    </section>
  );
}

function Profile() {
  const { account } = useAccount();
  const session = useSession();
  const register = useReducer(reducers.register);
  const [name, setName] = useState(account?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = !!account && name.trim() !== account.displayName && name.trim().length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await register({ displayName: name.trim() });
      toast.success("Name updated");
    } catch (err) {
      toast.error("Couldn't save", String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Profile" description="Your identity is a SpacetimeDB key kept in this browser.">
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Display name" htmlFor="display-name">
          <div className="flex gap-2">
            <Input id="display-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="secondary" disabled={!dirty} loading={busy}>
              Save
            </Button>
          </div>
        </Field>
        {session.identity && (
          <Field label="Identity">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-canvas/60 px-2.5 py-1.5 font-mono text-2xs text-fg-subtle shadow-[inset_0_0_0_1px_var(--color-line)]">
                {session.identity}
              </code>
              <Tooltip content="Copy">
                <IconButton
                  label="Copy identity"
                  onClick={() => {
                    void navigator.clipboard.writeText(session.identity!);
                    toast.success("Identity copied");
                  }}
                >
                  <IconCopy />
                </IconButton>
              </Tooltip>
            </div>
          </Field>
        )}
      </form>
    </Section>
  );
}

const PREFS = [
  { value: "cheapest", label: "Cheapest", hint: "Smallest machine that fits" },
  { value: "balanced", label: "Balanced", hint: "Best value per hour" },
  { value: "fastest", label: "Fastest", hint: "More GPU, shorter runs" },
];

function Spending() {
  const { account } = useAccount();
  const spent = useMonthSpend();
  const update = useReducer(reducers.updatePreferences);
  const [pref, setPref] = useState(account?.preference ?? "balanced");
  const [cap, setCap] = useState(((account?.monthlyCapCents ?? 2000) / 100).toString());
  const [auto, setAuto] = useState(((account?.approvalThresholdCents ?? 0) / 100).toString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!account) return null;
  const capCents = Math.round(parseFloat(cap || "0") * 100);
  const autoCents = Math.round(parseFloat(auto || "0") * 100);
  const dirty = pref !== account.preference || capCents !== account.monthlyCapCents || autoCents !== account.approvalThresholdCents;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number.isFinite(capCents) || !Number.isFinite(autoCents)) return setError("Enter dollar amounts");
    setBusy(true);
    try {
      await update({ preference: pref, monthlyCapCents: capCents, approvalThresholdCents: autoCents });
      toast.success("Spending policy saved");
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Compute & spending"
      description="Anywhere never spends past your monthly cap, and asks before any task that could cost more than your auto-approve limit."
    >
      <form onSubmit={save} className="flex flex-col gap-5">
        <div>
          <div className="mb-2 text-xs font-medium text-fg-muted">Default preference</div>
          <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PREFS.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={pref === p.value}
                onClick={() => setPref(p.value)}
                className={cn(
                  "relative rounded-lg px-3 py-2.5 text-left outline-none transition-[box-shadow,background-color] duration-150 focus-ring",
                  pref === p.value
                    ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-line)]"
                    : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-hover",
                )}
              >
                <div className="text-sm font-medium text-fg">{p.label}</div>
                <div className="text-xs text-fg-subtle">{p.hint}</div>
                {pref === p.value && <IconCheck size={14} className="absolute top-2.5 right-2.5 text-accent" />}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly cap" htmlFor="cap" hint="Up to $50 while in preview">
            <Input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} leading={<span className="text-xs">$</span>} />
          </Field>
          <Field label="Auto-approve up to" htmlFor="auto" hint="$0 means always ask first">
            <Input id="auto" inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} leading={<span className="text-xs">$</span>} />
          </Field>
        </div>
        <div>
          <div className="mb-2 flex items-baseline justify-between text-xs">
            <span className="text-fg-subtle">Spent this month</span>
            <span className="tabular text-fg-muted">
              {cents(spent)} <span className="text-fg-faint">of {cents(account.monthlyCapCents)}</span>
            </span>
          </div>
          <Meter value={spent} max={account.monthlyCapCents} />
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>
            Save policy
          </Button>
        </div>
      </form>
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
  const showCode = code && remaining > 0;

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setLink(await api.post("/v1/messaging/link", { phone }));
    } catch (err) {
      toast.error("Couldn't start linking", err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="iMessage" description="Text Anywhere to start tasks, check on jobs and get notified when they finish. Powered by Photon.">
      <div className="flex flex-col gap-4">
        {handles.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--color-line)]">
            {handles.map((h) => (
              <li key={h.handle} className="flex items-center gap-3 px-3 py-2.5">
                <span className="grid size-7 place-items-center rounded-md bg-ok-soft text-ok">
                  <IconPhone size={14} />
                </span>
                <span className="flex-1 text-sm text-fg tabular">{h.handle}</span>
                <Badge tone="ok">Linked</Badge>
                <Tooltip content="Unlink">
                  <IconButton
                    label={`Unlink ${h.handle}`}
                    onClick={async () => {
                      try {
                        await unlink({ handle: h.handle });
                        toast.success("Number unlinked");
                      } catch (err) {
                        toast.error("Couldn't unlink", String((err as Error).message ?? err));
                      }
                    }}
                  >
                    <IconTrash />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}

        {showCode ? (
          <div className="animate-rise rounded-lg bg-accent-soft p-4 shadow-[inset_0_0_0_1px_var(--color-accent-line)]">
            <div className="text-xs text-fg-subtle">
              Text this code{link?.anywhere_number ? ` to ${link.anywhere_number}` : " to Anywhere"} from {code.handle || "your phone"}
            </div>
            <div className="mt-2 flex items-center gap-4">
              <span className="font-mono text-2xl font-semibold tracking-[0.2em] text-fg tabular">{code.code}</span>
              <span className="text-xs text-fg-faint tabular">
                expires in {Math.floor(remaining / 60000)}:{String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}
              </span>
            </div>
            {link && (
              <a
                href={`${link.deep_link_base}?msg=${encodeURIComponent(code.code)}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-fg-inverse outline-none transition-opacity hover:opacity-90 focus-ring"
              >
                <IconMessage size={14} /> Open in Messages <IconArrowUpRight size={13} />
              </a>
            )}
          </div>
        ) : (
          <form onSubmit={start} className="flex flex-col gap-3">
            <Field label={handles.length ? "Link another number" : "Your phone number"} htmlFor="phone" hint="We'll give you a one-time code to text from this number.">
              <div className="flex gap-2">
                <Input
                  id="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+1 555 010 0199"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  leading={<IconPhone />}
                />
                <Button type="submit" variant="secondary" loading={busy} disabled={phone.replace(/\D/g, "").length < 7}>
                  Get code
                </Button>
              </div>
            </Field>
          </form>
        )}
      </div>
    </Section>
  );
}

const INTEGRATIONS: { key: string; name: string; role: string }[] = [
  { key: "spacetime", name: "SpacetimeDB", role: "Realtime state & events" },
  { key: "nemotron", name: "NVIDIA Nemotron", role: "Planning & computer use" },
  { key: "brev", name: "NVIDIA Brev", role: "GPU machines" },
  { key: "storage", name: "Object storage", role: "Projects, datasets & outputs" },
  { key: "photon", name: "Photon", role: "iMessage" },
];

function Integrations() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchHealth>> | undefined>(undefined);
  useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);
  const mode = health?.mode;

  return (
    <Section title="Integrations" description="What this Anywhere deployment is connected to. Keys live only on the server.">
      {health === undefined ? (
        <div className="space-y-3">
          {INTEGRATIONS.map((i) => (
            <div key={i.key} className="skeleton h-5 w-2/3" />
          ))}
        </div>
      ) : health === null ? (
        <p className="text-sm text-bad">The control plane isn’t reachable.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2.5">
            {INTEGRATIONS.map((i) => {
              const on = !!health.integrations[i.key];
              return (
                <li key={i.key} className="flex items-center gap-3 text-sm">
                  <Dot tone={on ? "ok" : "idle"} />
                  <span className="w-36 text-fg-muted">{i.name}</span>
                  <span className="flex-1 truncate text-xs text-fg-faint">{i.role}</span>
                  <span className={cn("text-xs", on ? "text-ok" : "text-fg-faint")}>{on ? "Connected" : "Not configured"}</span>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2 border-t border-line pt-3 text-xs text-fg-subtle">
            Provisioning
            <Badge tone={mode === "live" ? "ok" : "wait"}>{mode === "live" ? "Live" : mode === "dry_run" ? "Dry run" : "Disabled"}</Badge>
            <span className="text-fg-faint">
              {mode === "live" ? "Approved plans create real, billed machines." : "Plans are produced and checked, but no machine is created."}
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
