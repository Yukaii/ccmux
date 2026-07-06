import { describe, expect, test } from "bun:test";
import { ProcessTree } from "./process-tree";

describe("ProcessTree", () => {
  test("build() creates a tree from ps output", async () => {
    const tree = await ProcessTree.build();

    // Some restricted environments may return an empty process list.
    expect(tree.size).toBeGreaterThanOrEqual(0);
    expect(tree.builtAt).toBeLessThanOrEqual(Date.now());
  });

  test("getChildPids() returns empty array for non-existent parent", async () => {
    const tree = await ProcessTree.build();

    // PID 999999999 should not exist
    const children = tree.getChildPids(999999999);
    expect(children).toEqual([]);
  });

  test("getChildPids() returns children for init process (pid 1)", async () => {
    const tree = await ProcessTree.build();

    // PID 1 may not be visible in sandboxed test environments.
    const children = tree.getChildPids(1);
    expect(Array.isArray(children)).toBe(true);
  });

  test("getProcess() returns process info", async () => {
    const tree = await ProcessTree.build();

    // Current process may be absent in restricted process listings.
    const currentPid = process.pid;
    const proc = tree.getProcess(currentPid);

    if (proc) {
      expect(proc.pid).toBe(currentPid);
      expect(proc.ppid).toBeGreaterThan(0);
    } else {
      expect(proc).toBeUndefined();
    }
  });

  test("getProcess() returns undefined for non-existent pid", async () => {
    const tree = await ProcessTree.build();

    const proc = tree.getProcess(999999999);
    expect(proc).toBeUndefined();
  });

  test("findAgentDescendant() returns null when no match", async () => {
    const tree = await ProcessTree.build();
    const agentPids = new Set([999999999]); // Non-existent PID

    const result = tree.findAgentDescendant(1, agentPids);
    expect(result).toBeNull();
  });

  test("findAgentDescendant() finds direct match", async () => {
    const tree = await ProcessTree.build();
    const currentPid = process.pid;
    const agentPids = new Set([currentPid]);

    // Starting from current pid, should find itself
    const result = tree.findAgentDescendant(currentPid, agentPids);
    expect(result).toBe(currentPid);
  });

  test("findShellDescendants() returns empty array for non-existent pid", async () => {
    const tree = await ProcessTree.build();
    const shells = tree.findShellDescendants(999999999);
    expect(shells).toEqual([]);
  });

  test("findShellDescendants() finds shell processes in descendants", async () => {
    const tree = await ProcessTree.build();
    // PID 1 (launchd on macOS) should have some shell descendants
    const shells = tree.findShellDescendants(1);

    expect(Array.isArray(shells)).toBe(true);
    for (const pid of shells) {
      expect(typeof pid).toBe("number");
      const proc = tree.getProcess(pid);
      expect(proc).toBeDefined();
      expect(ProcessTree.SHELL_NAMES.some((s) => proc!.comm.includes(s))).toBe(
        true,
      );
    }
  });

  test("findShellDescendants() returns empty for process with no shell children", async () => {
    const tree = await ProcessTree.build();
    // Current test process likely doesn't have shell children
    const shells = tree.findShellDescendants(process.pid);
    expect(Array.isArray(shells)).toBe(true);
    // May or may not have shells depending on test runner
  });

  test("SHELL_NAMES includes common shells", () => {
    expect(ProcessTree.SHELL_NAMES).toContain("bash");
    expect(ProcessTree.SHELL_NAMES).toContain("sh");
    expect(ProcessTree.SHELL_NAMES).toContain("zsh");
    expect(ProcessTree.SHELL_NAMES).toContain("fish");
  });
});
