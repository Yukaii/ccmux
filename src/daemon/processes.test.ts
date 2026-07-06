import { describe, it, expect, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  parseElapsedTime,
  isCodexPluginHostCwd,
  discoverAgentProcesses,
  discoverAgentProcessesOrThrow,
  ProcessDiscoveryError,
} from "./processes";
import { CODEX_DIR } from "../lib/config";
import { CLAUDE_AGENT_DEF } from "../lib/agents";

describe("parseElapsedTime", () => {
  it("should parse MM:SS format", () => {
    expect(parseElapsedTime("00:05")).toBe(5);
    expect(parseElapsedTime("01:30")).toBe(90);
    expect(parseElapsedTime("59:59")).toBe(3599);
  });

  it("should parse HH:MM:SS format", () => {
    expect(parseElapsedTime("01:00:00")).toBe(3600);
    expect(parseElapsedTime("01:30:15")).toBe(5415);
    expect(parseElapsedTime("23:59:59")).toBe(86399);
  });

  it("should parse DD-HH:MM:SS format", () => {
    expect(parseElapsedTime("1-00:00:00")).toBe(86400);
    expect(parseElapsedTime("2-05:30:00")).toBe(192600);
    expect(parseElapsedTime("7-12:30:45")).toBe(649845);
  });

  it("should handle invalid input", () => {
    expect(parseElapsedTime("")).toBeNull();
    expect(parseElapsedTime("??")).toBeNull();
    expect(parseElapsedTime("-")).toBeNull();
    expect(parseElapsedTime("invalid")).toBeNull();
  });

  it("should handle whitespace", () => {
    expect(parseElapsedTime("  00:05  ")).toBe(5);
    expect(parseElapsedTime("\t01:30\n")).toBe(90);
  });
});

describe("isCodexPluginHostCwd", () => {
  it("matches a cwd under the codex plugins dir", () => {
    expect(
      isCodexPluginHostCwd(
        join(
          CODEX_DIR,
          "plugins",
          "cache",
          "openai-bundled",
          "computer-use",
          "1.0.793",
        ),
      ),
    ).toBe(true);
  });

  it("does not match a normal project cwd", () => {
    expect(isCodexPluginHostCwd(join(homedir(), "Code", "ccmux"))).toBe(false);
  });

  it("does not match a sibling dir sharing the plugins prefix", () => {
    expect(isCodexPluginHostCwd(join(CODEX_DIR, "plugins-backup", "x"))).toBe(
      false,
    );
  });

  it("does not match the plugins dir itself with no trailing path", () => {
    expect(isCodexPluginHostCwd(join(CODEX_DIR, "plugins"))).toBe(false);
  });

  it("handles a null cwd", () => {
    expect(isCodexPluginHostCwd(null)).toBe(false);
  });
});

describe("agent discovery failure semantics (fail-closed)", () => {
  const originalBunSpawn = Bun.spawn;

  afterEach(() => {
    Bun.spawn = originalBunSpawn;
  });

  // Simulate `ps` producing `stdout` and exiting with `exitCode`. Only the
  // `ps` call is intercepted; a throwing spawn simulates a spawn exception.
  function mockPs(opts: {
    stdout?: string;
    exitCode?: number;
    throwOnSpawn?: boolean;
  }) {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === "ps") {
        if (opts.throwOnSpawn) throw new Error("EAGAIN: resource unavailable");
        return {
          stdout: new Blob([opts.stdout ?? ""]).stream(),
          stderr: new Blob([""]).stream(),
          exited: Promise.resolve(opts.exitCode ?? 0),
        };
      }
      // lsof (cwd batch) — return nothing; irrelevant to these cases.
      return {
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
  }

  it("throws ProcessDiscoveryError when ps exits non-zero", async () => {
    mockPs({ stdout: "", exitCode: 1 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("throws ProcessDiscoveryError when ps produces no output", async () => {
    // ps always prints a header, so empty output means it did not run.
    mockPs({ stdout: "", exitCode: 0 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("throws ProcessDiscoveryError when the ps spawn itself throws", async () => {
    mockPs({ throwOnSpawn: true });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("returns [] (does NOT throw) for a genuinely-empty agent list", async () => {
    // ps ran fine (header only) but no line matches an agent.
    mockPs({ stdout: "  PID TTY      TIME     COMMAND\n", exitCode: 0 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).resolves.toEqual([]);
  });

  it("fail-soft discoverAgentProcesses swallows a hard ps failure as []", async () => {
    mockPs({ stdout: "", exitCode: 1 });
    await expect(discoverAgentProcesses([CLAUDE_AGENT_DEF])).resolves.toEqual(
      [],
    );
  });
});
