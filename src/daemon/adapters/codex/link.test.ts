import { describe, it, expect } from "bun:test";
import {
  CODEX_LINK_BACKWARD_GRACE_MS,
  CODEX_LINK_WINDOW_MS,
  codexRolloutPairCost,
  type CodexRolloutCandidate,
} from "./link";

function rollout(
  id: string,
  cwd: string,
  timestamp: number,
): CodexRolloutCandidate {
  return {
    path: `/Users/test/.codex/sessions/2026/04/17/rollout-${id}.jsonl`,
    metadata: {
      nativeSessionId: id,
      cwd,
      timestamp,
    },
  };
}

describe("codexRolloutPairCost", () => {
  const baseTime = Date.parse("2026-04-17T12:00:00.000Z");
  const cwd = "/Users/test/proj";

  it("is ineligible across cwds", () => {
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("a", "/other/cwd", baseTime + 1_000),
      ),
    ).toBeNull();
  });

  it("costs a rollout written shortly after the process by its forward gap", () => {
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("a", cwd, baseTime + 2_000),
      ),
    ).toBe(2_000);
  });

  it("rejects a stale rollout written before the process (regression: stale rollout in same cwd)", () => {
    // Real bug: a brand-new Codex pane with no rollout yet was being linked
    // to a rollout from a prior `codex exec` in the same cwd. Forward-only
    // comparison must reject anything older than the clock-skew grace.
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("stale", cwd, baseTime - 30_000),
      ),
    ).toBeNull();
  });

  it("rejects a stale rollout from hours earlier", () => {
    const hoursAgo = baseTime - 4 * 60 * 60 * 1000;
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("stale", cwd, hoursAgo),
      ),
    ).toBeNull();
  });

  it("orders several qualifying rollouts by gap (closest = cheapest)", () => {
    const cost = (ts: number) =>
      codexRolloutPairCost({ cwd, startTime: baseTime }, rollout("r", cwd, ts));
    expect(cost(baseTime + 2_000)!).toBeLessThan(cost(baseTime + 20_000)!);
    expect(cost(baseTime + 20_000)!).toBeLessThan(cost(baseTime + 45_000)!);
  });

  it("allows a rollout within the backward clock-skew grace at cost zero", () => {
    // Sub-second skew between OS proc startTime and Codex's session_meta
    // wall-clock stamp should not reject a legitimate match.
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("a", cwd, baseTime - 500),
      ),
    ).toBe(0);
  });

  it("rejects a rollout just beyond the backward grace", () => {
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("a", cwd, baseTime - CODEX_LINK_BACKWARD_GRACE_MS - 1),
      ),
    ).toBeNull();
  });

  it("treats the forward window as strictly less than (boundary excluded)", () => {
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("edge", cwd, baseTime + CODEX_LINK_WINDOW_MS),
      ),
    ).toBeNull();
    expect(
      codexRolloutPairCost(
        { cwd, startTime: baseTime },
        rollout("edge", cwd, baseTime + CODEX_LINK_WINDOW_MS - 1),
      ),
    ).toBe(CODEX_LINK_WINDOW_MS - 1);
  });
});
