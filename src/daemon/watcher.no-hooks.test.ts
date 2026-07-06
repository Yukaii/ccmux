import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "./sessions";
import { LogWatcher } from "./watcher";
import { ClaudeLogAdapter } from "./adapters/claude/log-adapter";

type WatcherInternals = {
  runtimeMode: "claude-with-hooks" | "claude-no-hooks";
  handleAdd(path: string): Promise<void>;
  handleUnlink(path: string): void;
};

function makeUserEntry(timestamp: string) {
  return JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp,
    message: { role: "user", content: "Continue" },
  });
}

describe("LogWatcher no-hooks Claude handling", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not remove pane-first Claude sessions when a no-hooks log disappears", () => {
    const manager = new SessionManager();
    const adapter = new ClaudeLogAdapter(manager);
    const watcher = new LogWatcher(adapter, manager);
    const internals = watcher as unknown as WatcherInternals;
    internals.runtimeMode = "claude-no-hooks";

    manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/Users/test/proj",
      pid: 12345,
    });

    internals.handleUnlink("/tmp/550e8400-e29b-41d4-a716-446655440000.jsonl");

    expect(manager.hasSession("claude_pane1")).toBe(true);
    expect(manager.getSession("claude_pane1")?.logPath).toBeNull();
  });

  it("does not let an unmatched historical Claude log steal a live pane", async () => {
    const manager = new SessionManager();
    const adapter = new ClaudeLogAdapter(manager);
    const watcher = new LogWatcher(adapter, manager);
    const internals = watcher as unknown as WatcherInternals;
    internals.runtimeMode = "claude-no-hooks";

    manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/Users/test/proj",
      pid: 12345,
      nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    const dir = mkdtempSync(join(tmpdir(), "ccmux-watcher-"));
    tempDirs.push(dir);
    const unrelatedSessionId = "11111111-2222-4333-8444-555555555555";
    const unrelatedLogPath = join(dir, `${unrelatedSessionId}.jsonl`);
    writeFileSync(unrelatedLogPath, makeUserEntry(new Date().toISOString()));

    await internals.handleAdd(unrelatedLogPath);

    expect(manager.getSessions()).toHaveLength(1);
    const session = manager.getSession("claude_pane1");
    expect(session?.tmuxPane).toBe("%1");
    expect(session?.nativeSessionId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(session?.logPath).toBeNull();
  });
});
