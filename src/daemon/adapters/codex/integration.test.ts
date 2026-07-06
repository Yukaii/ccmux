import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../../sessions";
import { LogWatcher } from "../../watcher";
import { CodexLogAdapter } from "./log-adapter";
import {
  jsonl,
  codexSessionMeta,
  codexEventMsg as eventMsg,
} from "./test-helpers";

type WatcherInternals = {
  handleAdd(path: string): Promise<void>;
  handleChange(path: string): void;
};

const NATIVE_ID = "019c7dd4-ff41-79c0-8270-d030bb51cd90";

function rolloutPath(dir: string): string {
  return join(dir, `rollout-2026-04-17T12-00-00-${NATIVE_ID}.jsonl`);
}

function sessionMeta() {
  return codexSessionMeta({
    id: NATIVE_ID,
    timestamp: "2026-04-17T12:00:00.000Z",
    cwd: "/Users/test/proj",
  });
}

describe("Codex LogWatcher integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-codex-int-"));
    tempDirs.push(dir);
    return dir;
  }

  it("ignores file events when no Codex session has the matching nativeSessionId", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(path, jsonl(sessionMeta()));

    await internals.handleAdd(path);

    expect(manager.getSessions()).toHaveLength(0);
  });

  it("processes the rollout once a pane-tracked session is linked via processPath", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%2",
      cwd: "/Users/test/proj",
      pid: 4321,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
        eventMsg("2026-04-17T12:00:02Z", {
          type: "user_message",
          message: "describe this repo",
        }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);

    const refreshed = manager.getSession(session.id)!;
    expect(refreshed.status).toBe("working");
    expect(refreshed.lastPrompt).toBe("describe this repo");
    expect(refreshed.lastActivityAt).toBe("2026-04-17T12:00:02Z");
  });

  it("settles status to idle on subsequent file change after task_complete", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 5555,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);
    expect(manager.getSession(session.id)?.status).toBe("working");

    appendFileSync(
      path,
      jsonl(eventMsg("2026-04-17T12:00:05Z", { type: "task_complete" })),
    );

    // Drive the change handler; processFile fires after WATCHER_DEBOUNCE_MS.
    // Poll for the expected state instead of sleeping a fixed interval so the
    // test stays responsive on slow CI without inflating local runtime.
    internals.handleChange(path);

    const deadline = Date.now() + 2000;
    let final = manager.getSession(session.id)!;
    while (final.status !== "idle" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      final = manager.getSession(session.id)!;
    }

    expect(final.status).toBe("idle");
    expect(final.lastActivityAt).toBe("2026-04-17T12:00:05Z");
  });

  it("settles to idle on the one-shot link read when the turn already completed", async () => {
    // A fast turn can finish before `linkCodexSessions` discovers the
    // rollout. The link's one-shot `processPath` read is then the ONLY
    // parse this file ever gets (no appends follow), so it must derive
    // the completed-turn idle state, not a mid-turn working state.
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%5",
      cwd: "/Users/test/proj",
      pid: 7777,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", {
          type: "user_message",
          message: "reply with the single word ok",
        }),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "agent_message" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "task_complete" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "token_count" }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);

    const refreshed = manager.getSession(session.id)!;
    expect(refreshed.status).toBe("idle");
    expect(refreshed.lastPrompt).toBe("reply with the single word ok");
    expect(refreshed.lastActivityAt).toBe("2026-04-17T12:00:02Z");
  });

  it("does not remove the session when the rollout file is unlinked", () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals & {
      handleUnlink(path: string): void;
    };

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%4",
      cwd: "/Users/test/proj",
      pid: 9999,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(path, jsonl(sessionMeta()));

    internals.handleUnlink(path);

    expect(manager.hasSession(session.id)).toBe(true);
  });
});
