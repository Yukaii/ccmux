import { describe, it, expect } from "bun:test";
import {
  cleanupStaleSessions,
  encodeProjectPath,
  matchSessionsToPanes,
} from "./session-pane-match";
import { SessionManager } from "./sessions";
import type { ProcessInfo, Session, TmuxPane } from "../types/session";
import { ZOMBIE_STALE_MS } from "../lib/config";

describe("cleanupStaleSessions", () => {
  const createPane = (paneId: string): TmuxPane => ({
    paneId,
    panePid: 1000,
    sessionName: "test",
    windowIndex: 0,
    paneIndex: 0,
    target: "test:0.0",
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  });

  /**
   * Run cleanup for two consecutive scans, threading the O4 hysteresis
   * pending set the way the daemon does. Destructive transitions (unbind /
   * remove) require both scans to agree, so tests asserting a destructive
   * outcome drive two; "keep" assertions hold under any number of scans.
   */
  const runCleanup = (
    manager: SessionManager,
    processes: ProcessInfo[],
    panes: TmuxPane[],
  ): void => {
    let pending: ReadonlySet<string> = new Set();
    for (let i = 0; i < 2; i++) {
      pending = cleanupStaleSessions(manager, processes, panes, pending);
    }
  };

  it("should remove session when its tracked PID is no longer running", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 12345);

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 99999,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should keep session when its tracked PID is still running", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 12345);

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(true);
  });

  it("should remove session with PID even if another process exists for same cwd", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 12345);

    // Different PID, same cwd - session should still be removed
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 99999,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should fall back to cwd-based cleanup when session has no PID", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/other-project",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should keep session without PID when process exists for same cwd", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(true);
  });

  it("should handle multiple sessions with different PIDs correctly", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 11111);

    manager.createSession(
      "session-2",
      "/Users/test/.claude/projects/-Users-test-myproject/session-2.jsonl",
    );
    manager.setPid("session-2", 22222);

    // Only session-2's PID is still running
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 22222,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("session-1")).toBe(false);
    expect(manager.hasSession("session-2")).toBe(true);
  });

  it("should remove session when its assigned pane no longer exists", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");

    // Pane %42 no longer exists - only %99 exists
    const panes: TmuxPane[] = [createPane("%99")];

    // Process still exists for the cwd
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, panes);

    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should keep session when its assigned pane still exists", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");

    // Pane %42 still exists
    const panes: TmuxPane[] = [createPane("%42"), createPane("%99")];

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, panes);

    expect(manager.hasSession("session-1")).toBe(true);
  });

  it("should soft-evict session with dead pane when PID is still running", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");
    manager.setPid("session-1", 12345);

    // Pane %42 no longer exists
    const panes: TmuxPane[] = [createPane("%99")];

    // PID still running
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, panes);

    // Should be kept (PID alive) but pane cleared for re-matching
    expect(manager.hasSession("session-1")).toBe(true);
    const session = manager.getSession("session-1");
    expect(session?.tmuxPane).toBeNull();
    expect(session?.pid).toBe(12345);
  });

  it("should re-match soft-evicted session via PID on next scan (no marker)", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");
    manager.setPid("session-1", 12345);

    const proc: ProcessInfo = {
      pid: 12345,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    // Step 1: pane disappears, soft-evict
    runCleanup(manager, [proc], [createPane("%99")]);
    expect(manager.getSession("session-1")?.tmuxPane).toBeNull();

    // Step 2: pane comes back, matchSessionsToPanes re-matches via PID
    const pane42 = createPane("%42");
    pane42.tty = "/dev/ttys001";
    matchSessionsToPanes(manager, [proc], [pane42]);

    const session = manager.getSession("session-1");
    expect(session?.tmuxPane).toBe("%42");
    expect(session?.pid).toBe(12345);
  });

  it("should remove soft-evicted session once PID dies", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");
    manager.setPid("session-1", 12345);

    const proc: ProcessInfo = {
      pid: 12345,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    // Step 1: soft-evict (pane gone, PID alive)
    runCleanup(manager, [proc], [createPane("%99")]);
    expect(manager.hasSession("session-1")).toBe(true);

    // Step 2: PID dies, should be removed
    runCleanup(manager, [], []);
    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should force-remove stale zombie session even when cwd matches", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    // No pane, no PID. Make updatedAt stale
    const internal = (manager as unknown as { sessions: Map<string, Session> })
      .sessions;
    internal.get("session-1")!.updatedAt = new Date(
      Date.now() - ZOMBIE_STALE_MS - 1000,
    );

    // Process exists for same cwd; normally would keep the session
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    // Zombie should be force-removed despite matching cwd
    expect(manager.hasSession("session-1")).toBe(false);
  });

  it("should keep fresh paneless session when cwd matches (not yet stale)", async () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    // No pane, no PID, updatedAt is fresh (just created)

    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    // Fresh session falls through to cwd check; cwd matches, so kept
    expect(manager.hasSession("session-1")).toBe(true);
  });

  it("should keep a background session even when stale and paneless (roster-owned)", async () => {
    const manager = new SessionManager();
    manager.createBackgroundSession({
      daemonShort: "sup-1",
      pid: null,
      cwd: "/Users/test/myproject",
      logPath: null,
      version: null,
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastPrompt: null,
      lastActivityAt: null,
    });
    // No pane, no PID. Make updatedAt stale (would reap a normal zombie row).
    const internal = (manager as unknown as { sessions: Map<string, Session> })
      .sessions;
    internal.get("sup-1")!.updatedAt = new Date(
      Date.now() - ZOMBIE_STALE_MS - 1000,
    );

    // Process exists for the same cwd; irrelevant for background rows, which
    // are owned by the claude-background roster watcher and never reaped here.
    const claudeProcesses: ProcessInfo[] = [
      {
        pid: 12345,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/myproject",
        startTime: null,
      },
    ];

    runCleanup(manager, claudeProcesses, []);

    expect(manager.hasSession("sup-1")).toBe(true);
  });

  it("AT-O4: a single scan's disappearance proposes but does not destroy", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 12345);

    // PID gone this scan — one scan is insufficient evidence.
    const pending = cleanupStaleSessions(manager, [], [], new Set());

    expect(manager.hasSession("session-1")).toBe(true);
    expect(pending.has("remove:session-1")).toBe(true);
  });

  it("AT-O4: evidence returning on the next scan drops the proposal", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 12345);

    const proc: ProcessInfo = {
      pid: 12345,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    // Scan 1: transient `ps` gap proposes removal.
    let pending = cleanupStaleSessions(manager, [], [], new Set());
    // Scan 2: the process is visible again — proposal dropped, nothing dies.
    pending = cleanupStaleSessions(manager, [proc], [], pending);
    expect(manager.hasSession("session-1")).toBe(true);
    expect(pending.size).toBe(0);

    // Scan 3: even if the pid disappears again, it's a NEW proposal (the
    // two scans must be consecutive), so still nothing dies.
    pending = cleanupStaleSessions(manager, [], [], pending);
    expect(manager.hasSession("session-1")).toBe(true);
  });

  it("AT-O4: a one-scan empty pane list is a no-op, not a mass unbind/remove", () => {
    const manager = new SessionManager();
    // Pane-bound, pid-less session: pre-Phase-2 a transient [] pane list
    // removed every one of these in a single pass (the tmux-side analogue
    // of the ps-side wipe).
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setTmuxPane("session-1", "%42");
    // Pane-bound session WITH a live pid: same transient [] would unbind it.
    manager.createSession(
      "session-2",
      "/Users/test/.claude/projects/-Users-test-myproject/session-2.jsonl",
    );
    manager.setTmuxPane("session-2", "%43");
    manager.setPid("session-2", 12345);

    const proc: ProcessInfo = {
      pid: 12345,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    // Scan 1: panes transiently empty.
    let pending = cleanupStaleSessions(manager, [proc], [], new Set());
    expect(manager.hasSession("session-1")).toBe(true);
    expect(manager.getSession("session-2")?.tmuxPane).toBe("%43");

    // Scan 2: panes are back — everything intact, proposals dropped.
    pending = cleanupStaleSessions(
      manager,
      [proc],
      [createPane("%42"), createPane("%43")],
      pending,
    );
    expect(manager.hasSession("session-1")).toBe(true);
    expect(manager.getSession("session-2")?.tmuxPane).toBe("%43");
    expect(pending.size).toBe(0);
  });
});

describe("encodeProjectPath", () => {
  it("should replace slashes with hyphens", () => {
    expect(encodeProjectPath("/Users/test/project")).toBe(
      "-Users-test-project",
    );
  });

  it("should replace underscores with hyphens", () => {
    expect(encodeProjectPath("/Users/test/my_project")).toBe(
      "-Users-test-my-project",
    );
  });

  it("should handle mixed slashes and underscores", () => {
    expect(encodeProjectPath("/Users/test_user/my_project")).toBe(
      "-Users-test-user-my-project",
    );
  });

  it("should replace dots with hyphens (matches Claude's real dir encoding)", () => {
    // A leading-dot dir yields a double dash: the `/` and the `.` each map to `-`.
    expect(encodeProjectPath("/Users/test/.dotfiles")).toBe(
      "-Users-test--dotfiles",
    );
    expect(encodeProjectPath("/Users/test/app.v2")).toBe("-Users-test-app-v2");
    expect(encodeProjectPath("/Users/test/example.com")).toBe(
      "-Users-test-example-com",
    );
  });

  it("should replace any non-alphanumeric character with a hyphen", () => {
    expect(encodeProjectPath("/a b/c+d")).toBe("-a-b-c-d");
  });
});

describe("matchSessionsToPanes TTY indexing", () => {
  const createPane = (paneId: string, tty: string | null): TmuxPane => ({
    paneId,
    panePid: 1000,
    sessionName: "test",
    windowIndex: 0,
    paneIndex: 0,
    target: "test:0.0",
    tty,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  });

  it("re-matches soft-evicted session via TTY lookup", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    // Pre-assign PID (soft-evicted: has PID but no pane)
    manager.setPid("session-1", 100);

    const proc: ProcessInfo = {
      pid: 100,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    const pane = createPane("%1", "/dev/ttys001");

    matchSessionsToPanes(manager, [proc], [pane]);

    const session = manager.getSession("session-1");
    expect(session?.tmuxPane).toBe("%1");
  });

  it("does NOT bind a pane to a background row sharing cwd + pid (roster-owned)", () => {
    const manager = new SessionManager();
    // A stale/recycled worker pid colliding with a pane-resident claude in
    // the same cwd would otherwise bind a pane to the background row.
    manager.createBackgroundSession({
      daemonShort: "sup-1",
      pid: 100,
      cwd: "/Users/test/myproject",
      logPath: null,
      version: null,
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastPrompt: null,
      lastActivityAt: null,
    });

    const proc: ProcessInfo = {
      pid: 100, // collides with the background row's worker pid
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };
    const pane = createPane("%1", "/dev/ttys001");

    matchSessionsToPanes(manager, [proc], [pane]);

    expect(manager.getSession("sup-1")?.tmuxPane).toBeNull();
  });

  it("matches multiple processes to panes by TTY", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-a",
      "/Users/test/.claude/projects/-Users-test-projA/session-a.jsonl",
    );
    manager.setPid("session-a", 100);
    manager.createSession(
      "session-b",
      "/Users/test/.claude/projects/-Users-test-projB/session-b.jsonl",
    );
    manager.setPid("session-b", 200);

    const procs: ProcessInfo[] = [
      {
        pid: 100,
        command: "claude",
        agentType: "claude",
        tty: "ttys001",
        cwd: "/Users/test/projA",
        startTime: null,
      },
      {
        pid: 200,
        command: "claude",
        agentType: "claude",
        tty: "ttys002",
        cwd: "/Users/test/projB",
        startTime: null,
      },
    ];

    const panes = [
      createPane("%1", "/dev/ttys001"),
      createPane("%2", "/dev/ttys002"),
    ];

    matchSessionsToPanes(manager, procs, panes);

    expect(manager.getSession("session-a")?.tmuxPane).toBe("%1");
    expect(manager.getSession("session-b")?.tmuxPane).toBe("%2");
  });

  it("skips panes with null TTY", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 100);

    const proc: ProcessInfo = {
      pid: 100,
      command: "claude",
      agentType: "claude",
      tty: "ttys001",
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    // Pane has no TTY - can't match
    const pane = createPane("%1", null);
    matchSessionsToPanes(manager, [proc], [pane]);

    expect(manager.getSession("session-1")?.tmuxPane).toBeNull();
  });

  it("skips processes with null TTY in index", () => {
    const manager = new SessionManager();
    manager.createSession(
      "session-1",
      "/Users/test/.claude/projects/-Users-test-myproject/session-1.jsonl",
    );
    manager.setPid("session-1", 100);

    // Process has no TTY - won't be indexed
    const proc: ProcessInfo = {
      pid: 100,
      command: "claude",
      agentType: "claude",
      tty: null,
      cwd: "/Users/test/myproject",
      startTime: null,
    };

    const pane = createPane("%1", "/dev/ttys001");
    matchSessionsToPanes(manager, [proc], [pane]);

    expect(manager.getSession("session-1")?.tmuxPane).toBeNull();
  });
});
