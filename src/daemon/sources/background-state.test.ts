import { describe, expect, it } from "bun:test";
import { BACKGROUND_FRESH_THRESHOLD_MS } from "../../lib/config";
import {
  deriveBackgroundState,
  type RosterWorker,
  type BackgroundStateJson,
} from "./background-state";

const NOW = 1_780_000_000_000;
const freshIso = new Date(NOW - 1_000).toISOString();
const staleIso = new Date(
  NOW - BACKGROUND_FRESH_THRESHOLD_MS - 5_000,
).toISOString();

function worker(over: Partial<RosterWorker> = {}): RosterWorker {
  return { pid: 123, cwd: "/private/tmp", startedAt: NOW - 1_000, ...over };
}

function state(over: Partial<BackgroundStateJson> = {}): BackgroundStateJson {
  return { cwd: "/private/tmp", createdAt: freshIso, ...over };
}

describe("deriveBackgroundState", () => {
  it("working/active maps to working", () => {
    const r = deriveBackgroundState(
      worker(),
      state({ state: "working", tempo: "active" }),
      NOW,
    );
    expect(r.status).toBe("working");
    expect(r.attentionType).toBeNull();
  });

  it("(state:blocked, tempo:active) maps to working, NOT waiting", () => {
    // The corrected mapping: state holds the last-completed-turn outcome,
    // tempo is the live axis. An actively-working agent that previously
    // blocked reads (blocked, active) and must render working (live: a9295753).
    const r = deriveBackgroundState(
      worker(),
      state({
        state: "blocked",
        tempo: "active",
        firstTerminalAt: "2026-05-30T06:47:55.976Z",
        linkScanPath: "/Users/x/.claude/projects/-private-tmp/a.jsonl",
      }),
      NOW,
    );
    expect(r.status).toBe("working");
    expect(r.attentionType).toBeNull();
  });

  it("tempo:blocked with block.questions maps to waiting/question", () => {
    const r = deriveBackgroundState(
      worker(),
      state({
        state: "working",
        tempo: "blocked",
        needs: "answer: Is blue your favorite? (Yes · No)",
        block: { questions: [{ question: "Is blue your favorite?" }] },
      }),
      NOW,
    );
    expect(r.status).toBe("waiting");
    expect(r.attentionType).toBe("question");
  });

  it("tempo:blocked with a non-array block.questions does not misclassify as question", () => {
    // Schema drift: a non-array `questions` would expose a numeric `.length`
    // and be read as a question count. With a flat `needs` it is a permission.
    const r = deriveBackgroundState(
      worker(),
      state({
        state: "blocked",
        tempo: "blocked",
        needs: "approve: rm -rf",
        block: { questions: "nope" as unknown as unknown[] },
      }),
      NOW,
    );
    expect(r.status).toBe("waiting");
    expect(r.attentionType).toBe("permission");
  });

  it("tempo:blocked with flat needs (no block) maps to waiting/permission", () => {
    const r = deriveBackgroundState(
      worker(),
      state({ state: "blocked", tempo: "blocked", needs: "approve: rm -rf" }),
      NOW,
    );
    expect(r.status).toBe("waiting");
    expect(r.attentionType).toBe("permission");
  });

  it("tempo:blocked with neither needs nor block maps to waiting/null", () => {
    const r = deriveBackgroundState(
      worker(),
      state({ state: "blocked", tempo: "active", needs: undefined }),
      NOW,
    );
    // tempo is the axis; here tempo is active so this is working...
    expect(r.status).toBe("working");
    // ...but a genuine tempo:blocked with no subtype is generic waiting:
    const blocked = deriveBackgroundState(
      worker(),
      state({ tempo: "blocked" }),
      NOW,
    );
    expect(blocked.status).toBe("waiting");
    expect(blocked.attentionType).toBeNull();
  });

  it("tempo:blocked with an empty block.questions[] falls through to needs/null", () => {
    // An empty questions array must not count as a question subtype: the
    // `(questions?.length ?? 0) > 0` check is false, so it falls through to
    // `needs` (permission) or, with neither, a generic waiting/null.
    const withNeeds = deriveBackgroundState(
      worker(),
      state({
        tempo: "blocked",
        block: { questions: [] },
        needs: "approve: rm -rf",
      }),
      NOW,
    );
    expect(withNeeds.status).toBe("waiting");
    expect(withNeeds.attentionType).toBe("permission");

    const bare = deriveBackgroundState(
      worker(),
      state({ tempo: "blocked", block: { questions: [] } }),
      NOW,
    );
    expect(bare.status).toBe("waiting");
    expect(bare.attentionType).toBeNull();
  });

  for (const lifecycle of ["done", "stopped", "failed"] as const) {
    it(`state:${lifecycle} maps to idle`, () => {
      const r = deriveBackgroundState(
        worker(),
        state({ state: lifecycle, tempo: "idle" }),
        NOW,
      );
      expect(r.status).toBe("idle");
      expect(r.attentionType).toBeNull();
    });
  }

  for (const lifecycle of ["done", "stopped", "failed"] as const) {
    it(`(state:${lifecycle}, tempo:active) maps to working, NOT idle (re-prompted worker)`, () => {
      // `state` lags at turn boundaries — it holds the LAST-completed-turn
      // outcome while `tempo` is the live axis. A finished worker re-prompted
      // in the agent view reads (terminal, active) until the new turn's
      // boundary write; tempo must win here too (mirrors the proven
      // (blocked, active) -> working case), else it renders idle while working.
      const r = deriveBackgroundState(
        worker(),
        state({
          state: lifecycle,
          tempo: "active",
          firstTerminalAt: "2026-05-30T06:47:55.976Z",
          linkScanPath: "/Users/x/.claude/projects/-private-tmp/a.jsonl",
        }),
        NOW,
      );
      expect(r.status).toBe("working");
      expect(r.attentionType).toBeNull();
    });
  }

  it("staleness guard: frozen working past threshold maps to idle", () => {
    const r = deriveBackgroundState(
      worker({ startedAt: NOW - BACKGROUND_FRESH_THRESHOLD_MS - 5_000 }),
      state({
        state: "working",
        tempo: "active",
        createdAt: staleIso,
        firstTerminalAt: null,
        linkScanPath: null,
      }),
      NOW,
    );
    expect(r.status).toBe("idle");
  });

  it("staleness guard: fresh working within threshold stays working", () => {
    const r = deriveBackgroundState(
      worker(),
      state({
        state: "working",
        tempo: "active",
        createdAt: freshIso,
        firstTerminalAt: null,
        linkScanPath: null,
      }),
      NOW,
    );
    expect(r.status).toBe("working");
  });

  it("staleness guard does NOT downgrade a first-turn block (no linkScanPath, old)", () => {
    // A first-turn block also has firstTerminalAt=null && !linkScanPath, but
    // the blocked check runs FIRST so it stays waiting.
    const r = deriveBackgroundState(
      worker({ startedAt: NOW - BACKGROUND_FRESH_THRESHOLD_MS - 5_000 }),
      state({
        state: "working",
        tempo: "blocked",
        createdAt: staleIso,
        firstTerminalAt: null,
        linkScanPath: null,
        block: { questions: [{ question: "?" }] },
      }),
      NOW,
    );
    expect(r.status).toBe("waiting");
    expect(r.attentionType).toBe("question");
  });

  it("staleness guard skipped once a turn has completed (linkScanPath present)", () => {
    const r = deriveBackgroundState(
      worker({ startedAt: NOW - BACKGROUND_FRESH_THRESHOLD_MS - 5_000 }),
      state({
        state: "working",
        tempo: "active",
        createdAt: staleIso,
        firstTerminalAt: null,
        linkScanPath: "/Users/x/.claude/projects/-private-tmp/a.jsonl",
      }),
      NOW,
    );
    expect(r.status).toBe("working");
  });

  it("backgroundDetail prefers detail, falls back to name", () => {
    expect(
      deriveBackgroundState(worker(), state({ detail: "counting" }), NOW)
        .backgroundDetail,
    ).toBe("counting");
    expect(
      deriveBackgroundState(
        worker(),
        state({ detail: undefined, name: "fallback" }),
        NOW,
      ).backgroundDetail,
    ).toBe("fallback");
  });

  it("tolerates a missing state.json (degrades to staleness-gated working)", () => {
    // Fresh worker, no state -> working; old worker, no state -> idle.
    expect(deriveBackgroundState(worker(), undefined, NOW).status).toBe(
      "working",
    );
    expect(
      deriveBackgroundState(
        worker({ startedAt: NOW - BACKGROUND_FRESH_THRESHOLD_MS - 5_000 }),
        undefined,
        NOW,
      ).status,
    ).toBe("idle");
  });

  it("staleness guard fails open to working when age is undeterminable", () => {
    // No parseable createdAt and no worker.startedAt -> resolveCreatedAtMs
    // returns null -> the staleness guard no-ops and the row stays working
    // (fail open), never wrongly swept to idle.
    const r = deriveBackgroundState(
      worker({ startedAt: undefined }),
      state({
        createdAt: undefined,
        state: "working",
        tempo: "active",
        firstTerminalAt: null,
        linkScanPath: null,
      }),
      NOW,
    );
    expect(r.status).toBe("working");
  });
});
