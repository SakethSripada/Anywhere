"use client";

import type { Account } from "@anywhere/stdb";
import { AlertCircle } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, useApi } from "@/lib/api";
import { reducers, useReducer, type Session } from "@/lib/stdb";
import { Logo } from "./logo";

export function Onboarding({ session, account, accountReady }: { session: Session; account: Account | null; accountReady: boolean }) {
  if (!session.ready || !accountReady) {
    return (
      <Stage>
        {session.error ? (
          <Panel title="Can’t reach Anywhere" body="The realtime backend didn’t answer. Check that SpacetimeDB is running and that the web app points at it.">
            <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-xs break-all text-muted-foreground">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              {session.error}
            </div>
            <Button className="mt-4 w-full" size="lg" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </Panel>
        ) : (
          <span className="shimmer-text text-sm">Connecting</span>
        )}
      </Stage>
    );
  }
  return <Stage>{account ? <Activate /> : <Register />}</Stage>;
}

function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="mb-10 flex items-center gap-2">
        <Logo className="size-6" />
        <span className="text-lg font-semibold tracking-tight">Anywhere</span>
      </div>
      <div className="w-full max-w-[360px]">{children}</div>
    </div>
  );
}

function Panel({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
      <h1 className="text-center text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
      <p className="mt-2 mb-7 text-center text-sm leading-6 text-muted-foreground">{body}</p>
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
    <Panel title="Welcome to Anywhere" body="Enter your name to get started.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Label htmlFor="name">Your name</Label>
        <Input id="name" autoFocus autoComplete="name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} className="h-11" />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="mt-2 h-11" disabled={!name.trim() || busy}>
          {busy ? "Creating account…" : "Continue"}
        </Button>
      </form>
    </Panel>
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Panel title="Enter your invite code" body="GPU time costs real money, so access is invite-only during the preview.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Label htmlFor="code">Invite code</Label>
        <Input id="code" autoFocus autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className="h-11 font-mono" />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="mt-2 h-11" disabled={busy}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </Panel>
  );
}
