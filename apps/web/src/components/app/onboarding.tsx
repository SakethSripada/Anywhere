"use client";

import type { Account } from "@anywhere/stdb";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, useApi } from "@/lib/api";
import { reducers, useReducer, type Session } from "@/lib/stdb";
import { IconAlert, IconArrowRight, IconLock, Mark } from "../icons";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { Spinner } from "../ui/spinner";

export function Onboarding({
  session,
  account,
  accountReady,
}: {
  session: Session;
  account: Account | null;
  accountReady: boolean;
}) {
  if (!session.ready || !accountReady) {
    return (
      <Stage>
        {session.error ? (
          <Card
            icon={<IconAlert size={16} className="text-bad" />}
            title="Can't reach Anywhere"
            body="The realtime backend didn't answer. Check that SpacetimeDB is running and the web app points at it."
          >
            <code className="block truncate rounded-md bg-canvas/70 px-2.5 py-2 font-mono text-2xs text-fg-subtle shadow-[inset_0_0_0_1px_var(--color-line)]">
              {session.error}
            </code>
            <Button variant="secondary" className="mt-4 w-full" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </Card>
        ) : (
          <div className="flex animate-fade-in [animation-delay:300ms] [animation-duration:400ms] flex-col items-center gap-4 text-fg-subtle">
            <Spinner size={18} />
            <span className="text-sm">Connecting</span>
          </div>
        )}
      </Stage>
    );
  }
  return <Stage>{account ? <Activate /> : <Register />}</Stage>;
}

export function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-64 left-1/2 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-accent/[0.035] blur-3xl"
      />
      <div className="relative flex w-full max-w-sm flex-col items-center">
        <div className="mb-8 flex items-center gap-2">
          <Mark size={22} />
          <span className="text-lg font-semibold tracking-tighter">Anywhere</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Card({ icon, title, body, children }: { icon?: ReactNode; title: string; body: string; children: ReactNode }) {
  return (
    <div className="w-full animate-rise rounded-2xl bg-surface p-6 shadow-overlay">
      {icon && <div className="mb-4 grid size-8 place-items-center rounded-lg bg-white/[0.05]">{icon}</div>}
      <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
      <p className="mt-1.5 mb-5 text-sm text-fg-subtle">{body}</p>
      {children}
    </div>
  );
}

function Register() {
  const register = useReducer(reducers.register);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await register({ displayName: name.trim() });
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  }

  return (
    <Card title="Powerful computers, on request" body="Describe what you want to do. Anywhere picks the hardware, sets it up, and can operate it for you.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="What should we call you?" htmlFor="name" error={error}>
          <Input id="name" autoFocus autoComplete="name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!name.trim()} trailing={<IconArrowRight />}>
          Continue
        </Button>
      </form>
    </Card>
  );
}

function Activate() {
  const api = useApi();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/account/activate", { code: code.trim() || "dev" });
      // The account row flips to activated over the subscription; the gate lifts on its own.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Card
      icon={<IconLock size={16} className="text-accent" />}
      title="Enter your invite code"
      body="GPU time is real money, so access is invite-only while we're in preview."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Invite code" htmlFor="code" error={error}>
          <Input
            id="code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono tracking-wide"
            placeholder="ANYWHERE-…"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} trailing={<IconArrowRight />}>
          Unlock Anywhere
        </Button>
      </form>
    </Card>
  );
}
