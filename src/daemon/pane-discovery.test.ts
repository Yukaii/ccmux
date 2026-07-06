import { describe, it, expect } from "bun:test";
import { findPaneHostingPid } from "./pane-discovery";
import type { ProcessTree, ProcessNode } from "./process-tree";
import type { TmuxPane } from "../types/session";

describe("findPaneHostingPid", () => {
  const makePane = (paneId: string, panePid: number): TmuxPane => ({
    paneId,
    panePid,
    sessionName: "test",
    windowIndex: 0,
    paneIndex: 0,
    target: `test:0.${paneId.replace("%", "")}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  });

  const makeTree = (nodes: ProcessNode[]): ProcessTree => {
    const map = new Map<number, ProcessNode>();
    for (const n of nodes) map.set(n.pid, n);
    return {
      getProcess: (pid: number) => map.get(pid),
    } as unknown as ProcessTree;
  };

  it("returns the pane whose panePid is a direct ancestor of pid", () => {
    const panes = [makePane("%1", 1000), makePane("%2", 2000)];
    const tree = makeTree([
      { pid: 3000, ppid: 2500, comm: "opencode" },
      { pid: 2500, ppid: 2000, comm: "bash" },
      { pid: 2000, ppid: 1, comm: "zsh" },
    ]);
    expect(findPaneHostingPid(3000, panes, tree)?.paneId).toBe("%2");
  });

  it("returns the pane when the pid IS the pane's panePid", () => {
    const panes = [makePane("%self", 4242)];
    const tree = makeTree([{ pid: 4242, ppid: 1, comm: "zsh" }]);
    expect(findPaneHostingPid(4242, panes, tree)?.paneId).toBe("%self");
  });

  it("returns null when pid is not hosted by any pane", () => {
    const panes = [makePane("%1", 1000)];
    const tree = makeTree([
      { pid: 5000, ppid: 9000, comm: "opencode" },
      { pid: 9000, ppid: 1, comm: "launchd" },
    ]);
    expect(findPaneHostingPid(5000, panes, tree)).toBeNull();
  });

  it("returns null when panes list is empty", () => {
    const tree = makeTree([{ pid: 1, ppid: 0, comm: "init" }]);
    expect(findPaneHostingPid(1, [], tree)).toBeNull();
  });

  it("terminates cleanly on a ppid cycle (shouldn't happen, but safe)", () => {
    const panes = [makePane("%1", 1000)];
    const tree = makeTree([
      { pid: 100, ppid: 200, comm: "a" },
      { pid: 200, ppid: 100, comm: "b" },
    ]);
    expect(findPaneHostingPid(100, panes, tree)).toBeNull();
  });

  it("stops walking at pid <= 1 without matching init", () => {
    // An imaginary pane whose panePid is 1 (init) must NOT be reported
    // as hosting an unrelated process just because the walk bottoms out.
    const panes = [makePane("%init", 1)];
    const tree = makeTree([{ pid: 500, ppid: 1, comm: "detached" }]);
    expect(findPaneHostingPid(500, panes, tree)).toBeNull();
  });
});
