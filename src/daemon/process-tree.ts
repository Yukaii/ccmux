/**
 * ProcessTree - Build and query process hierarchy in a single pass.
 * Eliminates N pgrep calls by building tree from one ps command.
 */
import { DaemonPerf } from "./perf";

export interface ProcessNode {
  pid: number;
  ppid: number;
  comm: string;
}

export class ProcessTree {
  private processes = new Map<number, ProcessNode>();
  /** Map of ppid -> child pids (parent->children index) */
  private children = new Map<number, number[]>();
  public readonly builtAt: number;

  private constructor() {
    this.builtAt = Date.now();
  }

  static async build(): Promise<ProcessTree> {
    const tree = new ProcessTree();

    try {
      DaemonPerf.incSubprocessSpawn("ps-tree");
      const proc = Bun.spawn(["ps", "-axo", "pid,ppid,comm"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const lines = output.trim().split("\n").slice(1);

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const comm = parts.slice(2).join(" ");

        if (isNaN(pid) || isNaN(ppid)) continue;

        const node: ProcessNode = { pid, ppid, comm };
        tree.processes.set(pid, node);

        const siblings = tree.children.get(ppid) ?? [];
        siblings.push(pid);
        tree.children.set(ppid, siblings);
      }
    } catch {
      // Return empty tree on error
    }

    return tree;
  }

  getChildPids(parentPid: number): number[] {
    return this.children.get(parentPid) ?? [];
  }

  getProcess(pid: number): ProcessNode | undefined {
    return this.processes.get(pid);
  }

  /**
   * Find an agent process that is a descendant of the given root PID
   * Uses BFS traversal through the in-memory tree (no subprocess spawning)
   */
  findAgentDescendant(rootPid: number, agentPids: Set<number>): number | null {
    const queue = [rootPid];
    const visited = new Set<number>();

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      if (agentPids.has(pid)) {
        return pid;
      }

      const childPids = this.getChildPids(pid);
      queue.push(...childPids);
    }

    return null;
  }

  /**
   * Shell process names to detect running Bash commands
   */
  static readonly SHELL_NAMES = ["bash", "sh", "zsh", "fish"];

  /**
   * Find all shell descendant processes of a given root PID
   * Used to detect when a Bash tool is actively executing
   */
  findShellDescendants(rootPid: number): number[] {
    const shellPids: number[] = [];
    const queue = this.getChildPids(rootPid);
    const visited = new Set<number>();

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const proc = this.getProcess(pid);
      if (proc && ProcessTree.SHELL_NAMES.some((s) => proc.comm.includes(s))) {
        shellPids.push(pid);
      }
      queue.push(...this.getChildPids(pid));
    }
    return shellPids;
  }

  get size(): number {
    return this.processes.size;
  }
}
