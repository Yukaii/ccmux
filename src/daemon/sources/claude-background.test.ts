import { describe, expect, it } from "bun:test";
import { SessionManager } from "../sessions";
import { ClaudeBackgroundSource } from "./claude-background";
import type { RosterJson, BackgroundStateJson } from "./background-state";

const NOW = 1_780_000_000_000;

function build(
  roster: RosterJson | null,
  states: Record<string, BackgroundStateJson> = {},
) {
  const manager = new SessionManager();
  const source = new ClaudeBackgroundSource(manager, {
    readRoster: () => roster,
    readState: (short) => states[short],
    now: () => NOW,
  });
  return { manager, source };
}

function rosterWith(workers: RosterJson["workers"], proto = 1): RosterJson {
  return { proto, workers };
}

describe("ClaudeBackgroundSource", () => {
  it("creates a background session with the identity mapping", () => {
    const { manager, source } = build(
      rosterWith({
        a9295753: {
          pid: 4242,
          sessionId: "a9295753-aaaa",
          cliVersion: "2.1.168",
          cwd: "/private/tmp",
          startedAt: NOW - 1_000,
        },
      }),
      {
        a9295753: {
          state: "working",
          tempo: "active",
          detail: "doing work",
          cwd: "/private/tmp",
          resumeSessionId: "a9295753-aaaa",
          createdAt: new Date(NOW - 1_000).toISOString(),
        },
      },
    );

    source.syncFromRoster();

    const sessions = manager.getSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe("a9295753"); // daemonShort is the dedup key
    expect(s.trackingMode).toBe("background");
    expect(s.agentType).toBe("claude");
    expect(s.tmuxPane).toBeNull();
    expect(s.pid).toBe(4242);
    expect(s.nativeSessionId).toBe("a9295753-aaaa"); // resumeSessionId
    expect(s.version).toBe("2.1.168");
    expect(s.status).toBe("working");
    expect(s.backgroundDetail).toBe("doing work");
  });

  it("uses linkScanPath VERBATIM and never reconstructs it (resumed worker)", () => {
    // A resumed worker's current sessionId points at a STALE transcript;
    // linkScanPath is authoritative. Use a path that does NOT match
    // <encoded-cwd>/<resumeSessionId>.jsonl to prove it is taken verbatim.
    const staleLink =
      "/Users/x/.claude/projects/-private-tmp/PRE-RESUME-uuid.jsonl";
    const { manager, source } = build(
      rosterWith({
        f00d: {
          pid: 7,
          cwd: "/private/tmp",
          startedAt: NOW - 1_000,
        },
      }),
      {
        f00d: {
          state: "done",
          tempo: "idle",
          cwd: "/private/tmp",
          resumeSessionId: "current-resume-uuid",
          linkScanPath: staleLink,
        },
      },
    );

    source.syncFromRoster();

    const s = manager.getSessions()[0];
    expect(s.logPath).toBe(staleLink);
    expect(s.nativeSessionId).toBe("current-resume-uuid");
  });

  it("removes a background session when its short drops from the roster", () => {
    const states = {
      a: { state: "working", tempo: "active", cwd: "/tmp" },
      b: { state: "working", tempo: "active", cwd: "/tmp" },
    } satisfies Record<string, BackgroundStateJson>;
    const manager = new SessionManager();
    let roster: RosterJson = rosterWith({
      a: { pid: 1, cwd: "/tmp", startedAt: NOW },
      b: { pid: 2, cwd: "/tmp", startedAt: NOW },
    });
    const source = new ClaudeBackgroundSource(manager, {
      readRoster: () => roster,
      readState: (short) =>
        (states as Record<string, BackgroundStateJson>)[short],
      now: () => NOW,
    });

    source.syncFromRoster();
    expect(
      manager
        .getSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "b"]);

    // `b` drops out of the roster (claude stop / rm) -> sole death signal.
    roster = rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } });
    source.syncFromRoster();
    expect(manager.getSessions().map((s) => s.id)).toEqual(["a"]);
  });

  it("ignores a state.json event for a short not in roster.workers", () => {
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      {
        a: { state: "working", tempo: "active", cwd: "/tmp" },
        ghost: { state: "working", tempo: "active", cwd: "/tmp" },
      },
    );
    source.syncFromRoster();
    expect(manager.getSessions().map((s) => s.id)).toEqual(["a"]);

    // The jobs/ dir is a historical superset; a dead dir's state.json event
    // must not resurrect a non-member.
    source.handleStateChange("ghost");
    expect(manager.getSessions().map((s) => s.id)).toEqual(["a"]);
  });

  it("creates no row when the worker and state both lack a cwd", () => {
    // upsert early-returns without a cwd; a member can't be placed, but it
    // must not throw or create a malformed row (corrects on the next write).
    const { manager, source } = build(
      rosterWith({ nocwd: { pid: 1, startedAt: NOW } }),
      { nocwd: { state: "working", tempo: "active" } },
    );
    source.syncFromRoster();
    expect(manager.getSessions()).toHaveLength(0);
  });

  it("re-derives status on a state.json change for a member", () => {
    const states: Record<string, BackgroundStateJson> = {
      a: { state: "working", tempo: "active", cwd: "/tmp" },
    };
    const manager = new SessionManager();
    const source = new ClaudeBackgroundSource(manager, {
      readRoster: () =>
        rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      readState: (short) => states[short],
      now: () => NOW,
    });

    source.syncFromRoster();
    expect(manager.getSession("a")?.status).toBe("working");

    // state.json flips to a blocked turn; the roster did NOT change.
    states.a = {
      state: "working",
      tempo: "blocked",
      cwd: "/tmp",
      needs: "approve: write file",
    };
    source.handleStateChange("a");
    expect(manager.getSession("a")?.status).toBe("waiting");
    expect(manager.getSession("a")?.attentionType).toBe("permission");
  });

  it("threads inFlight progress and clears it when it leaves state.json", () => {
    const states: Record<string, BackgroundStateJson> = {
      a: {
        state: "working",
        tempo: "active",
        cwd: "/tmp",
        inFlight: { tasks: 2, queued: 1, kinds: ["Task"] },
      },
    };
    const manager = new SessionManager();
    const source = new ClaudeBackgroundSource(manager, {
      readRoster: () =>
        rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      readState: (short) => states[short],
      now: () => NOW,
    });

    source.syncFromRoster();
    expect(manager.getSession("a")?.backgroundInFlight).toEqual({
      tasks: 2,
      queued: 1,
      kinds: ["Task"],
    });

    // Turn boundary write drops inFlight: the session must not keep a
    // stale progress snapshot.
    states.a = { state: "done", tempo: "idle", cwd: "/tmp" };
    source.handleStateChange("a");
    expect(manager.getSession("a")?.backgroundInFlight).toEqual({});
  });

  it("guards a non-object inFlight (schema drift) without threading it", () => {
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      {
        a: {
          state: "working",
          tempo: "active",
          cwd: "/tmp",
          inFlight: "3 tasks" as unknown as BackgroundStateJson["inFlight"],
        },
      },
    );
    expect(() => source.syncFromRoster()).not.toThrow();
    expect(manager.getSession("a")?.backgroundInFlight).toBeUndefined();
  });

  it("drops malformed inFlight fields, keeping the valid ones", () => {
    // A non-array `kinds` surviving to the SessionManager would throw from
    // `kinds.every` inside the structural equality on the next update, out
    // of the uncaught jobs-watcher callback.
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      {
        a: {
          state: "working",
          tempo: "active",
          cwd: "/tmp",
          inFlight: {
            tasks: 1,
            queued: "2",
            kinds: "Task",
          } as unknown as BackgroundStateJson["inFlight"],
        },
      },
    );
    expect(() => source.syncFromRoster()).not.toThrow();
    expect(manager.getSession("a")?.backgroundInFlight).toEqual({ tasks: 1 });
  });

  it("keeps only string entries of a mixed-type kinds array", () => {
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      {
        a: {
          state: "working",
          tempo: "active",
          cwd: "/tmp",
          inFlight: {
            kinds: ["Task", 5, null],
          } as unknown as BackgroundStateJson["inFlight"],
        },
      },
    );
    source.syncFromRoster();
    expect(manager.getSession("a")?.backgroundInFlight).toEqual({
      kinds: ["Task"],
    });
  });

  it("degrades to zero background rows when proto !== 1", () => {
    // Seed one session via a good roster, then a proto bump must clear it.
    const manager = new SessionManager();
    let roster: RosterJson = rosterWith({
      a: { pid: 1, cwd: "/tmp", startedAt: NOW },
    });
    const source = new ClaudeBackgroundSource(manager, {
      readRoster: () => roster,
      readState: () => ({ state: "working", tempo: "active", cwd: "/tmp" }),
      now: () => NOW,
    });
    source.syncFromRoster();
    expect(manager.getSessions()).toHaveLength(1);

    roster = rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }, 2);
    source.syncFromRoster();
    expect(manager.getSessions()).toHaveLength(0);
  });

  it("tolerates a malformed roster entry (null worker) without throwing", () => {
    // A null worker value is structurally malformed JSON; the source must
    // skip it, not throw out of a chokidar callback and wedge the daemon.
    const { manager, source } = build(
      {
        proto: 1,
        workers: { good: { pid: 1, cwd: "/tmp", startedAt: NOW }, bad: null },
      } as unknown as RosterJson,
      { good: { state: "working", tempo: "active", cwd: "/tmp" } },
    );
    expect(() => source.syncFromRoster()).not.toThrow();
    expect(manager.getSessions().map((s) => s.id)).toEqual(["good"]);
  });

  it("tolerates a null child entry in state.json without throwing", () => {
    // The crash path needs old + new children both length-1 with a null
    // element; upsert filters null/non-object children before the store.
    const states: Record<string, BackgroundStateJson> = {
      a: {
        state: "working",
        tempo: "active",
        cwd: "/tmp",
        children: [{ id: "1", href: "h", kind: "pr" }],
      },
    };
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      states,
    );
    source.syncFromRoster();
    expect(manager.getSession("a")?.backgroundChildren).toHaveLength(1);

    states.a = {
      state: "working",
      tempo: "active",
      cwd: "/tmp",
      children: [null],
    } as unknown as BackgroundStateJson;
    expect(() => source.handleStateChange("a")).not.toThrow();
    expect(manager.getSession("a")?.backgroundChildren).toEqual([]);
  });

  it("skips a non-string cwd without throwing (corrects on next write)", () => {
    // A truthy non-string `cwd` (schema drift) must not reach `.split("/")`
    // in createBackgroundSession and throw out of the watcher callback —
    // the same wedge the null-worker / null-child guards prevent.
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      {
        a: {
          state: "working",
          tempo: "active",
          cwd: 42,
        } as unknown as BackgroundStateJson,
      },
    );
    expect(() => source.syncFromRoster()).not.toThrow();
    expect(manager.getSessions()).toHaveLength(0);
  });

  it("leaves an existing row's last-known-good values on a state.json read-miss", () => {
    // A transient readState() miss for an EXISTING member must not clobber
    // logPath/status with worker-only fallbacks; it leaves them intact.
    const link = "/Users/x/.claude/projects/-tmp/live.jsonl";
    const states: Record<string, BackgroundStateJson> = {
      a: {
        state: "working",
        tempo: "active",
        cwd: "/tmp",
        resumeSessionId: "live-sid",
        linkScanPath: link,
      },
    };
    const { manager, source } = build(
      rosterWith({ a: { pid: 1, cwd: "/tmp", startedAt: NOW } }),
      states,
    );
    source.syncFromRoster();
    expect(manager.getSession("a")?.logPath).toBe(link);

    delete states.a; // state.json transiently unreadable
    source.handleStateChange("a");
    expect(manager.getSession("a")?.logPath).toBe(link);
    expect(manager.getSession("a")?.status).toBe("working");
  });
});
