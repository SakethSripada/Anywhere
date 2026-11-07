"use client";

import type RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { apiWsUrl } from "@/lib/config";
import { IconExpand, IconRefresh } from "../icons";
import { IconButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";

type Phase = "connecting" | "live" | "lost" | "failed";

/**
 * Live desktop over noVNC. The browser never talks to the VM: it trades its
 * identity for a 60-second ticket, and the control plane relays the stream
 * through an SSH tunnel to the instance's loopback-only VNC server.
 */
export function VncScreen({
  workloadId,
  viewOnly,
  className,
  children,
}: {
  workloadId: bigint;
  viewOnly: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const api = useApi();
  const frame = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [attempt, setAttempt] = useState(0);
  const viewOnlyRef = useRef(viewOnly);

  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (rfb.current) rfb.current.viewOnly = viewOnly;
  }, [viewOnly]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const [{ default: RFBClass }, { ticket }] = await Promise.all([
          import("@novnc/novnc"),
          api.post<{ ticket: string }>(`/v1/desktops/${workloadId}/session`),
        ]);
        if (cancelled || !target.current) return;
        const client = new RFBClass(target.current, apiWsUrl(`/v1/desktops/${workloadId}/vnc?ticket=${encodeURIComponent(ticket)}`), {
          wsProtocols: ["binary"],
          shared: true,
        });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = "transparent";
        client.qualityLevel = 7;
        client.compressionLevel = 2;
        client.viewOnly = viewOnlyRef.current;
        client.addEventListener("connect", () => !cancelled && setPhase("live"));
        client.addEventListener("disconnect", ((e: CustomEvent<{ clean: boolean }>) => {
          rfb.current = null;
          if (cancelled) return;
          if (attempt < 5) {
            setPhase("lost");
            retry = setTimeout(() => setAttempt((a) => a + 1), Math.min(1000 * 2 ** attempt, 10_000));
          } else {
            setPhase("failed");
          }
          void e;
        }) as EventListener);
        rfb.current = client;
      } catch {
        if (cancelled) return;
        if (attempt < 5) {
          setPhase("lost");
          retry = setTimeout(() => setAttempt((a) => a + 1), Math.min(1000 * 2 ** attempt, 10_000));
        } else {
          setPhase("failed");
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [api, workloadId, attempt]);

  const fullscreen = useCallback(() => {
    const el = frame.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  }, []);

  return (
    <div ref={frame} className={cn("group/screen relative h-full w-full overflow-hidden bg-black", className)}>
      <div ref={target} className="absolute inset-0 [&_canvas]:!outline-none" />

      {phase !== "live" && (
        <div className="absolute inset-0 grid animate-fade-in place-items-center bg-canvas">
          <div className="flex flex-col items-center gap-3 text-center">
            {phase === "failed" ? (
              <>
                <span className="text-sm text-fg-muted">The desktop stream isn’t responding.</span>
                <button
                  type="button"
                  onClick={() => {
                    setPhase("connecting");
                    setAttempt(0);
                  }}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 text-sm text-fg outline-none transition-colors hover:bg-white/[0.1] focus-ring"
                >
                  <IconRefresh size={14} /> Reconnect
                </button>
              </>
            ) : (
              <>
                <Spinner size={18} className="text-fg-subtle" />
                <span className="text-sm text-fg-subtle">{phase === "lost" ? "Reconnecting to your desktop" : "Connecting to your desktop"}</span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="absolute top-3 right-3 flex gap-1 rounded-lg bg-black/60 p-1 opacity-0 backdrop-blur transition-opacity duration-200 group-hover/screen:opacity-100 focus-within:opacity-100">
        <Tooltip content="Reconnect">
          <IconButton
            label="Reconnect"
            size="xs"
            onClick={() => {
              setPhase("connecting");
              setAttempt((a) => a + 1);
            }}
          >
            <IconRefresh />
          </IconButton>
        </Tooltip>
        <Tooltip content="Full screen">
          <IconButton label="Full screen" size="xs" onClick={fullscreen}>
            <IconExpand />
          </IconButton>
        </Tooltip>
      </div>

      {children}
    </div>
  );
}
