import { describe, expect, it } from "vitest";
import {
  BILLABLE,
  canTransition,
  PLATFORM_MAX_MONTHLY_CAP_CENTS,
  shouldBumpConversation,
  TRANSITIONS,
  usageUpdate,
  validatePreferences,
  WORKLOAD_STATUSES,
} from "./lifecycle";

describe("workload lifecycle", () => {
  it("follows the happy path for a desktop that is stopped and resumed", () => {
    const path = ["planned", "approved", "provisioning", "configuring", "running", "saving", "running", "stopping", "stopped", "provisioning"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("never skips approval before compute is provisioned", () => {
    expect(canTransition("planned", "provisioning")).toBe(false);
    expect(canTransition("planned", "running")).toBe(false);
  });

  it("treats cancelled and terminated as final", () => {
    for (const to of WORKLOAD_STATUSES) {
      expect(canTransition("cancelled", to)).toBe(false);
      expect(canTransition("terminated", to)).toBe(false);
    }
  });

  it("lets every billable state fail so cleanup can always run", () => {
    for (const s of BILLABLE) {
      if (s === "stopping") continue; // stopping fails into terminated via failed
      expect(canTransition(s, "failed"), s).toBe(true);
    }
    expect(canTransition("failed", "terminated")).toBe(true);
  });

  it("rejects unknown statuses", () => {
    expect(canTransition("planned", "launching")).toBe(false);
    expect(canTransition("nope", "approved")).toBe(false);
  });

  it("only references known statuses", () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const t of targets) expect(WORKLOAD_STATUSES).toContain(t);
    }
  });
});

describe("account preferences", () => {
  const ok = { preference: "balanced", monthlyCapCents: 2000, approvalThresholdCents: 0 };

  it("accepts sane values", () => expect(validatePreferences(ok)).toBeNull());
  it("rejects caps above the platform ceiling", () =>
    expect(validatePreferences({ ...ok, monthlyCapCents: PLATFORM_MAX_MONTHLY_CAP_CENTS + 1 })).toMatch(/cap/));
  it("rejects a threshold above the cap", () =>
    expect(validatePreferences({ ...ok, approvalThresholdCents: 2500 })).toMatch(/threshold/));
  it("rejects unknown preferences", () => expect(validatePreferences({ ...ok, preference: "yolo" })).toMatch(/preference/));
});

describe("write coalescing", () => {
  const S = 1_000_000n;

  it("skips record_usage calls that change nothing", () => {
    expect(usageUpdate({ accruedCents: 50, lastActiveAtMicros: 100n * S }, 50, false, 200n * S)).toBeNull();
    expect(usageUpdate({ accruedCents: 50 }, 40, false, 200n * S)).toBeNull(); // monotonic
  });

  it("coalesces touches inside the interval but keeps spend increases", () => {
    const row = { accruedCents: 50, lastActiveAtMicros: 100n * S };
    expect(usageUpdate(row, 50, true, 110n * S)).toBeNull();
    expect(usageUpdate(row, 60, true, 110n * S)).toEqual({ accruedCents: 60, touch: false });
    expect(usageUpdate(row, 50, true, 130n * S)).toEqual({ accruedCents: 50, touch: true });
    expect(usageUpdate({ accruedCents: 0 }, 0, true, 1n)).toEqual({ accruedCents: 0, touch: true });
  });

  it("bumps a conversation at most every ten seconds", () => {
    expect(shouldBumpConversation(100n * S, 105n * S)).toBe(false);
    expect(shouldBumpConversation(100n * S, 110n * S)).toBe(true);
  });
});
