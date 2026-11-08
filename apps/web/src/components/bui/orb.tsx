import { cn } from "@/lib/utils";
import { FluidOrb } from "./fluid-orb";

export type OrbState = "working" | "thinking" | "paused" | "ready" | "offline";

const SPEED: Record<OrbState, number> = { working: 3.2, thinking: 2.4, paused: 0.5, ready: 1, offline: 0 };

/**
 * The agent's presence — Rare UI's Fluid Orb in the agent's violet. It churns
 * faster while the agent works, drifts while it's ready, and stills when
 * there's nothing to drive.
 */
export function AgentOrb({ state = "ready", size = 20, className }: { state?: OrbState; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <FluidOrb
        size={size}
        color="#6d5dfc"
        speed={SPEED[state]}
        className={cn("shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-[filter,opacity] duration-500", state === "offline" && "opacity-50 grayscale")}
      />
    </span>
  );
}
