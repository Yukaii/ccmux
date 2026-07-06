import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Verify the linkCodexSessions marker link pass closes the
 * daemon-startup race described in `CodexHookAdapter.onMarkerAdded`
 * (markers may replay before the first process scan creates the
 * pane-tracked session) and re-derives native-id ownership each scan
 * so a heuristic mis-link heals instead of being refused
 * forever.
 */
const tempRoot = join(
  tmpdir(),
  `ccmux-codex-marker-enrich-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const markersDir = join(tempRoot, "markers");

process.env.CCMUX_HOME = tempRoot;
const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  MARKERS_DIR: markersDir,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "../../index";
import { HookManager } from "../../hook-manager";
import {
  refreshMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";
import { SessionManager } from "../../sessions";
import type { Session, TmuxPane } from "../../../types/session";

interface Internals {
  sessionManager: SessionManager;
  hookManager: HookManager;
  reconcileCodexMarkerLinks(
    sessions: readonly Session[],
    panes: readonly TmuxPane[],
  ): Promise<void>;
}

function writeMarker(filename: string, marker: SessionPidMarker) {
  mkdirSync(markersDir, { recursive: true });
  writeFileSync(join(markersDir, `${filename}.json`), JSON.stringify(marker));
}

function fakePane(paneId: string, tty: string): TmuxPane {
  return {
    paneId,
    panePid: 0,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: `ccmux:0.${paneId.replace("%", "")}`,
    tty,
    startTime: null,
    windowActivity: null,
    paneTitle: "codex",
    currentCommand: "codex",
    currentPath: "/tmp",
  };
}

describe("Daemon reconcileCodexMarkerLinks", () => {
  let daemon: Daemon;
  let internals: Internals;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    refreshMarkerCache();
    daemon = new Daemon();
    internals = daemon as unknown as Internals;
    // The real context has a tmux-backed listPanes; override with a fake
    // so the test does not shell out.
    const prevCtx = internals.hookManager.getContext();
    internals.hookManager.setContext({
      ...prevCtx!,
      listPanes: async () => [fakePane("%7", "/dev/ttys042")],
    });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("enriches an unlinked pane-tracked Codex session from a TTY-matching marker", async () => {
    const session = internals.sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%7",
      pid: 12345,
      cwd: "/Users/test/proj",
    });

    writeMarker("codex-real-sid", {
      agent_type: "codex",
      pid: 99999,
      tty: "ttys042",
      session_id: "real-sid",
      transcript_path: "/tmp/rollout.jsonl",
      timestamp: 1,
    });
    refreshMarkerCache();

    await internals.reconcileCodexMarkerLinks(
      [session],
      [fakePane("%7", "/dev/ttys042")],
    );

    const updated = internals.sessionManager.getSession(session.id);
    expect(updated?.nativeSessionId).toBe("real-sid");
    expect(updated?.logPath).toBe("/tmp/rollout.jsonl");
  });

  it("is a no-op when no marker's TTY matches the session's pane TTY", async () => {
    const session = internals.sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%7",
      pid: 1,
      cwd: "/Users/test/proj",
    });

    writeMarker("codex-other", {
      agent_type: "codex",
      pid: 1,
      tty: "ttys999",
      session_id: "other-sid",
      timestamp: 1,
    });
    refreshMarkerCache();

    await internals.reconcileCodexMarkerLinks(
      [session],
      [fakePane("%7", "/dev/ttys042")],
    );

    const updated = internals.sessionManager.getSession(session.id);
    expect(updated?.nativeSessionId).toBeUndefined();
  });

  it("ignores Claude markers on the same TTY", async () => {
    const session = internals.sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%7",
      pid: 1,
      cwd: "/Users/test/proj",
    });

    writeMarker("claude-overlap", {
      agent_type: "claude",
      pid: 1,
      tty: "ttys042",
      session_id: "claude-sid",
      timestamp: 1,
    });
    refreshMarkerCache();

    await internals.reconcileCodexMarkerLinks(
      [session],
      [fakePane("%7", "/dev/ttys042")],
    );

    const updated = internals.sessionManager.getSession(session.id);
    expect(updated?.nativeSessionId).toBeUndefined();
  });

  it("AT-E1: heals a swapped pair — each session re-links to its own pane's marker in one pass", async () => {
    const paneA = fakePane("%7", "/dev/ttys042");
    const paneB = fakePane("%8", "/dev/ttys043");
    const prevCtx = internals.hookManager.getContext();
    internals.hookManager.setContext({
      ...prevCtx!,
      listPanes: async () => [paneA, paneB],
    });

    const sessionA = internals.sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%7",
      pid: 100,
      cwd: "/Users/test/proj",
    });
    const sessionB = internals.sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%8",
      pid: 200,
      cwd: "/Users/test/proj",
    });
    // The heuristic rollout fallback grabbed each other's ids (the audit's
    // same-cwd swap). Pre-Phase-2 this was permanent: only unlinked
    // sessions were reconsidered and the conflict was refused forever.
    internals.sessionManager.setNativeSessionId(sessionA.id, "sid-b");
    internals.sessionManager.setNativeSessionId(sessionB.id, "sid-a");

    writeMarker("codex-sid-a", {
      agent_type: "codex",
      pid: 100,
      tty: "ttys042",
      session_id: "sid-a",
      transcript_path: "/tmp/rollout-a.jsonl",
      timestamp: 1,
    });
    writeMarker("codex-sid-b", {
      agent_type: "codex",
      pid: 200,
      tty: "ttys043",
      session_id: "sid-b",
      transcript_path: "/tmp/rollout-b.jsonl",
      timestamp: 1,
    });
    refreshMarkerCache();

    await internals.reconcileCodexMarkerLinks(
      [sessionA, sessionB],
      [paneA, paneB],
    );

    expect(
      internals.sessionManager.getSession(sessionA.id)?.nativeSessionId,
    ).toBe("sid-a");
    expect(
      internals.sessionManager.getSession(sessionB.id)?.nativeSessionId,
    ).toBe("sid-b");
    expect(internals.sessionManager.getSession(sessionA.id)?.logPath).toBe(
      "/tmp/rollout-a.jsonl",
    );
    expect(internals.sessionManager.getSession(sessionB.id)?.logPath).toBe(
      "/tmp/rollout-b.jsonl",
    );
  });
});
