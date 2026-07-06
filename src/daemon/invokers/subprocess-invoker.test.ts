import { describe, expect, it, mock } from "bun:test";
import { getBuiltinAgent } from "../../lib/agents-test-helpers";
import type { InvokeInput } from "./types";
import {
  SubprocessInvoker,
  type SpawnedProcess,
  type SubprocessInvokerDeps,
} from "./subprocess-invoker";

function makeInput(overrides: Partial<InvokeInput> = {}): InvokeInput {
  return {
    invocationId: "inv_sub_test",
    agent: getBuiltinAgent("cursor"),
    prompt: "hello",
    cwd: "/tmp/test",
    timeoutMs: 60_000,
    ...overrides,
  };
}

/**
 * Structural fake of Bun's `Subprocess`. Tests build one per scenario:
 * stdout/stderr are emitted as a single chunk via `Response().body`,
 * `exited` resolves with the given code (optionally after a delay so the
 * abort handler can race the natural exit), and `kill` records the
 * signal so order-of-call assertions work.
 */
function fakeProc(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  exitedAfter?: Promise<void>;
  killLog?: string[];
}): SpawnedProcess {
  const exited = opts.exitedAfter
    ? opts.exitedAfter.then(() => opts.exitCode ?? 0)
    : Promise.resolve(opts.exitCode ?? 0);
  return {
    stdin: { write: mock(() => undefined), end: mock(() => undefined) },
    stdout: new Response(opts.stdout ?? "").body,
    stderr: new Response(opts.stderr ?? "").body,
    exited,
    kill: mock((sig?: number | NodeJS.Signals) => {
      if (opts.killLog) opts.killLog.push(String(sig ?? "SIGTERM"));
    }),
  };
}

/**
 * Default test deps: `spawn` returns a never-exiting proc so each test
 * must override with `fakeProc(...)` for the scenario it exercises.
 * Tmpfile lifecycle uses in-memory bookkeeping so we can assert
 * remove was called without touching real fs.
 */
function makeDeps(overrides: Partial<SubprocessInvokerDeps> = {}): {
  deps: SubprocessInvokerDeps;
  removedDirs: string[];
} {
  const removedDirs: string[] = [];
  const base: SubprocessInvokerDeps = {
    spawn: mock(() => {
      throw new Error("test must override `spawn`");
    }),
    createTmpDir: mock(async () => ({
      dir: "/tmp/ccmux-fake/xyz",
      tmpfile: "/tmp/ccmux-fake/xyz/last-message.txt",
    })),
    removeTmpDir: mock(async (dir: string) => {
      removedDirs.push(dir);
    }),
    extractResponse: mock(async (_mode, ctx) => ctx.stdout.replace(/\n+$/, "")),
    writeResult: mock(async () => {}),
    now: mock(() => 1_000_000_000_000),
  };
  return { deps: { ...base, ...overrides }, removedDirs };
}

describe("SubprocessInvoker.invoke", () => {
  it("rejects sessionId when the agent has no resumeArgs (gemini)", async () => {
    const { deps } = makeDeps();
    const invoker = new SubprocessInvoker(deps);
    const result = await invoker.invoke(
      makeInput({ agent: getBuiltinAgent("gemini"), sessionId: "x" }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("does not support --session");
    }
    // Spawn must NOT have been called for a precondition reject.
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("returns immediately when the signal is already aborted", async () => {
    const { deps } = makeDeps();
    const ac = new AbortController();
    ac.abort("cancelled");
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput(),
      ac.signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("succeeds on the stdout path (cursor)", async () => {
    const { deps } = makeDeps();
    const proc = fakeProc({ stdout: "cursor reply\n", exitCode: 0 });
    deps.spawn = mock(() => proc);
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({
        agent: getBuiltinAgent("cursor"),
        prompt: "the user prompt",
      }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.text).toBe("cursor reply");
    // No tmpfile is created for the stdout output kind.
    expect(deps.createTmpDir).not.toHaveBeenCalled();
    // The prompt is piped to stdin verbatim. Original invokeSubprocess
    // relied on this; the original tests didn't pin it because they
    // spawned a real subprocess. The extract should pin it.
    expect(proc.stdin.write).toHaveBeenCalledWith("the user prompt");
    expect(proc.stdin.end).toHaveBeenCalled();
    // Pin the spawn options too, for the same reason as stdin. 2.4 will
    // delete the manager's copy; this lock-in catches an accidental drop
    // of cwd/pipe-config/env during the consolidation.
    expect(deps.spawn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        cwd: "/tmp/test",
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      }),
    );
  });

  it("passes the prompt as the -p arg and does NOT pipe it to stdin (gemini)", async () => {
    const { deps } = makeDeps();
    const proc = fakeProc({ stdout: "ok\n", exitCode: 0 });
    deps.spawn = mock(() => proc);
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("gemini"), prompt: "say ok" }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    // gemini reads the prompt from `-p`, so it rides in argv, not stdin.
    expect(deps.spawn).toHaveBeenCalledWith(
      ["gemini", "-p", "say ok"],
      expect.objectContaining({ stdin: "pipe" }),
    );
    // stdin is still closed (EOF) but the prompt is NOT written to it.
    expect(proc.stdin.write).not.toHaveBeenCalled();
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("rejects an oversized prompt before spawn when it rides in argv (gemini)", async () => {
    const { deps } = makeDeps();
    // > MAX_ARGV_PROMPT_BYTES (120 KiB): fail clean instead of execve E2BIG.
    const huge = "x".repeat(121 * 1024);
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("gemini"), prompt: huge }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("capped at");
    }
    // Precondition reject: the subprocess is never started.
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("does NOT size-cap a large stdin prompt (cursor pipes via stdin)", async () => {
    const { deps } = makeDeps();
    const proc = fakeProc({ stdout: "ok\n", exitCode: 0 });
    deps.spawn = mock(() => proc);
    // Same size rejected for gemini: stdin has no per-arg limit, so the cap
    // must be argv-only.
    const huge = "x".repeat(121 * 1024);
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("cursor"), prompt: huge }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    expect(deps.spawn).toHaveBeenCalled();
    expect(proc.stdin.write).toHaveBeenCalledWith(huge);
  });

  it("succeeds on the tmpfile path (codex) and cleans up the tmp dir", async () => {
    const { deps, removedDirs } = makeDeps();
    deps.spawn = mock(() => fakeProc({ stdout: "", exitCode: 0 }));
    deps.extractResponse = mock(async (_mode, ctx) => {
      // codex writes to tmpfile, not stdout.
      expect(ctx.tmpfilePath).toBe("/tmp/ccmux-fake/xyz/last-message.txt");
      return "codex tmpfile reply";
    });
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("codex") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.text).toBe("codex tmpfile reply");
    expect(removedDirs).toEqual(["/tmp/ccmux-fake/xyz"]);
  });

  it("extracts session id from opencode JSONL stdout when present", async () => {
    const { deps } = makeDeps();
    const opencodeStdout = [
      JSON.stringify({ type: "session.created", sessionID: "ses_xyz" }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "opencode reply" },
      }),
      "",
    ].join("\n");
    deps.spawn = mock(() => fakeProc({ stdout: opencodeStdout, exitCode: 0 }));
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("opencode") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.sessionId).toBe("ses_xyz");
    }
  });

  it("prefers the extracted opencode sessionId over input.sessionId (`??` precedence)", async () => {
    const { deps } = makeDeps();
    const opencodeStdout = [
      JSON.stringify({ type: "session.created", sessionID: "ses_new" }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "opencode reply" },
      }),
      "",
    ].join("\n");
    deps.spawn = mock(() => fakeProc({ stdout: opencodeStdout, exitCode: 0 }));
    const result = await new SubprocessInvoker(deps).invoke(
      // Pass a sessionId so resumeArgs are used AND the `??` precedence is
      // observable: extracted "ses_new" must win over input "ses_old".
      makeInput({ agent: getBuiltinAgent("opencode"), sessionId: "ses_old" }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.sessionId).toBe("ses_new");
  });

  it("falls back to input.sessionId when the agent does not expose one in stdout", async () => {
    const { deps } = makeDeps();
    deps.spawn = mock(() => fakeProc({ stdout: "cursor reply", exitCode: 0 }));
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({
        agent: getBuiltinAgent("cursor"),
        sessionId: "passed_through",
      }),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.sessionId).toBe("passed_through");
  });

  it("maps a rate-limit banner to rate_limit even when exit code is non-zero", async () => {
    const { deps } = makeDeps();
    // Codex prints the rate-limit banner THEN exits non-zero. errorRules
    // must win so the user sees the actionable cause, not "exit code 1".
    deps.spawn = mock(() =>
      fakeProc({
        stdout: "",
        stderr: "rate limit reached\n",
        exitCode: 1,
      }),
    );
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("codex") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("rate_limit");
      // Locks the match to the actual stderr substring so swapping the
      // agent (and its errorRules) wouldn't silently pass.
      expect(result.message.toLowerCase()).toContain("rate limit");
    }
  });

  it("reports stderr detail when the subprocess exits non-zero with no errorRule match", async () => {
    const { deps } = makeDeps();
    deps.spawn = mock(() =>
      fakeProc({
        stdout: "",
        stderr: "boom: invalid flag --whatever\n",
        exitCode: 2,
      }),
    );
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("cursor") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("boom: invalid flag --whatever");
    }
  });

  it("falls back to exit code when neither stderr nor stdout has detail", async () => {
    const { deps } = makeDeps();
    deps.spawn = mock(() => fakeProc({ exitCode: 42 }));
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("cursor") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.message).toContain("exit code 42");
  });

  it("treats empty text + non-empty stderr as agent_error (opencode shape)", async () => {
    const { deps } = makeDeps();
    deps.spawn = mock(() =>
      fakeProc({
        stdout: "",
        stderr: "NotFoundError: session ses_missing\n",
        exitCode: 0,
      }),
    );
    deps.extractResponse = mock(async () => "");
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("opencode") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("produced no response");
      expect(result.message).toContain("NotFoundError");
    }
  });

  it.each([
    { reason: "cancelled" as const, expected: "cancelled" as const },
    { reason: "timeout" as const, expected: "timeout" as const },
  ])(
    "classifies a mid-flight abort with reason=$reason as $expected",
    async ({ reason, expected }) => {
      const { deps } = makeDeps();
      const ac = new AbortController();
      let unblockExit!: () => void;
      const exitedAfter = new Promise<void>((resolve) => {
        unblockExit = resolve;
      });
      deps.spawn = mock(() => {
        // Abort during spawn so the abort handler fires; unblock the
        // never-exiting proc so `Promise.all` returns. Verifies the
        // post-`Promise.all` reason inspection at the bottom of `invoke`
        // (the `if (signal.aborted)` recheck after stdout/stderr/exit
        // resolve), not the pre-spawn short-circuit at the top.
        queueMicrotask(() => {
          ac.abort(reason);
          unblockExit();
        });
        return fakeProc({ exitCode: 130, exitedAfter });
      });

      const result = await new SubprocessInvoker(deps).invoke(
        makeInput(),
        ac.signal,
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.kind).toBe(expected);
    },
  );

  it("cleans up the tmp dir in finally when extractResponse throws", async () => {
    const { deps, removedDirs } = makeDeps();
    deps.spawn = mock(() => fakeProc({ stdout: "", exitCode: 0 }));
    deps.extractResponse = mock(async () => {
      throw new Error("transient read failure");
    });
    const result = await new SubprocessInvoker(deps).invoke(
      makeInput({ agent: getBuiltinAgent("codex") }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toContain("transient read failure");
    }
    // tmp dir is still removed even though we hit the catch branch.
    expect(removedDirs).toEqual(["/tmp/ccmux-fake/xyz"]);
  });

  it("throws on the precondition violation when invokeMode is missing", async () => {
    const { deps } = makeDeps();
    // Build an agent fixture with no invokeMode; this is the contract
    // the 2.4 registry enforces (only agents-with-invokeMode dispatch
    // here). An unrecoverable throw is honest; returning agent_error
    // would pretend a programmer error is user-recoverable.
    const claudeMissingInvoke = getBuiltinAgent("claude");
    expect(claudeMissingInvoke.invokeMode).toBeUndefined();
    await expect(
      new SubprocessInvoker(deps).invoke(
        makeInput({ agent: claudeMissingInvoke }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("dispatched for agent without invokeMode");
  });
});
