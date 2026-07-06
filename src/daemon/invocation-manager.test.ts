import { describe, it, expect, setSystemTime } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationManager, type InvocationEvent } from "./invocation-manager";
import {
  buildClaudeLaunchCommand,
  buildSubprocessArgv,
  extractOpencodeJsonText,
  extractSubprocessResponse,
  extractSubprocessSessionId,
  isPromptReady,
  scanForTurnEnd,
  subprocessPromptInArgs,
} from "./invokers/helpers";
import type { Invoker } from "./invokers/invoker";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import type { InvokeInput, InvokeResult } from "./invokers/types";
import { SessionManager } from "./sessions";
import type { AgentDef, BUILTIN_AGENTS, InvokeMode } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import type { LogEntry } from "../types/log";

function makeManager(
  opts: {
    claude?: Invoker;
    subprocess?: Invoker;
  } = {},
): InvocationManager {
  const registry = new InvocationRegistry(
    opts.claude ?? stubInvoker("claude-interactive"),
    opts.subprocess ?? stubInvoker("subprocess"),
  );
  return new InvocationManager(new SessionManager(), registry);
}

function assistantEntry(text: string, stopReason: "end_turn" | null): LogEntry {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
      stop_reason: stopReason ?? undefined,
    },
  } as unknown as LogEntry;
}

function turnDurationEntry(): LogEntry {
  return {
    type: "system",
    subtype: "turn_duration",
  } as unknown as LogEntry;
}

function userEntry(text: string): LogEntry {
  return {
    type: "user",
    message: { content: [{ type: "text", text }] },
  } as unknown as LogEntry;
}

describe("scanForTurnEnd", () => {
  // The Finding 1 bug: when --session resumes an existing transcript, the
  // pre-prompt entries already contain a prior turn's end marker. Callers
  // must scope `entries` to the current turn (via readLogIncremental from
  // a pre-prompt byte offset). scanForTurnEnd itself walks whatever it's
  // handed; these tests pin its behavior against the two shapes a caller
  // can pass in.
  it("returns null while the turn is still in flight", () => {
    const inFlight: LogEntry[] = [
      userEntry("explain rate limits"),
      assistantEntry("partial...", null),
    ];
    expect(scanForTurnEnd(inFlight)).toBeNull();
  });

  it("returns the assistant text adjacent to the end marker", () => {
    const entries: LogEntry[] = [
      userEntry("explain rate limits"),
      assistantEntry("Rate limits cap requests over time.", "end_turn"),
    ];
    expect(scanForTurnEnd(entries)).toEqual({
      text: "Rate limits cap requests over time.",
    });
  });

  it("treats turn_duration as a turn-end marker", () => {
    const entries: LogEntry[] = [
      assistantEntry("done", null),
      turnDurationEntry(),
    ];
    expect(scanForTurnEnd(entries)?.text).toBe("done");
  });

  it("does not return prior-turn text when only the prior end is in scope", () => {
    // Simulates the post-fix shape: caller passes only the current turn's
    // entries (via baseline-anchored readLogIncremental). When the new
    // assistant reply hasn't arrived yet, scanForTurnEnd returns null
    // instead of regurgitating an end marker that belongs to a previous
    // turn.
    const currentTurnInFlight: LogEntry[] = [userEntry("next turn")];
    expect(scanForTurnEnd(currentTurnInFlight)).toBeNull();
  });
});

describe("InvocationManager.cancel", () => {
  it("returns true and stashes the id when cancel arrives before invoke", () => {
    const mgr = makeManager();
    expect(mgr.cancel("inv_doesnotexist")).toBe(true);
  });

  it("short-circuits a subsequent invoke for a pre-cancelled id", async () => {
    const mgr = makeManager();
    mgr.cancel("inv_precancelled");

    const result = await mgr.invoke({
      invocationId: "inv_precancelled",
      agent: getBuiltinAgent("gemini"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("cancelled");
    }
  });

  it("short-circuits as cancelled, not agent_error, when the pre-cancelled id targets a no-invokeMode agent", async () => {
    // Post-2.4 the pre-cancel check runs BEFORE registry.get(). Pre-flip
    // this same sequence (cancel then invoke a custom agent without
    // invokeMode) surfaced as `agent_error` because the no-invoker branch
    // ran first. The cancel-wins ordering is arguably more honest; this
    // test pins it so a future reorder can't silently regress it.
    const mgr = makeManager();
    const stub = {
      name: "no-invoke",
      shortCode: "NI",
      processMatch: /no-invoke/,
      terminalRules: [],
    } as unknown as (typeof BUILTIN_AGENTS)[number];

    mgr.cancel("inv_precancel_noinvoke");
    const result = await mgr.invoke({
      invocationId: "inv_precancel_noinvoke",
      agent: stub,
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("cancelled");
    }
  });

  it("aborts the in-flight invocation's signal with reason=cancelled", () => {
    // After 2.4, cancel() just calls signal.abort("cancelled") and
    // returns immediately. The invoker (ClaudeInvoker / SubprocessInvoker)
    // owns the rest of the teardown (C-c + grace + kill for Claude;
    // SIGTERM then SIGKILL for subprocess) in its own finally / abort
    // handler. The teardown side effects are pinned in those invokers'
    // own test suites; here we only pin the manager's contract.
    const mgr = makeManager();
    type ManagerInternals = {
      invocations: Map<string, AbortController>;
    };
    const ac = new AbortController();
    (mgr as unknown as ManagerInternals).invocations.set("inv_inflight", ac);

    expect(mgr.cancel("inv_inflight")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("cancelled");
  });

  it("does not stash a pre-start cancel for an already-finished id, so a reused id is not falsely pre-cancelled", () => {
    // Regression for the cancel-stash guard: cancelling an id whose
    // invocation already FINISHED (a terminal record is present, but no
    // AbortController) must be a pure no-op, never a stashed pre-start
    // cancel. Stashing it would, if the same id were reused within
    // PRE_START_CANCEL_TTL_MS, falsely short-circuit the new invoke as
    // cancelled at admission. A genuinely unknown id must still stash.
    const mgr = makeManager();
    type ManagerInternals = {
      records: Map<string, unknown>;
      cancelledBeforeStart: Map<string, number>;
    };
    const internals = mgr as unknown as ManagerInternals;
    internals.records.set("inv_finished", {
      invocationId: "inv_finished",
      agent: "codex",
      cwd: "/tmp",
      startedAt: 1,
      status: "succeeded",
    });

    expect(mgr.cancel("inv_finished")).toBe(true);
    // Finished id: NOT stashed (the guard).
    expect(internals.cancelledBeforeStart.has("inv_finished")).toBe(false);
    // Genuinely unknown id: still stashed (pre-start cancel preserved).
    expect(mgr.cancel("inv_never_seen")).toBe(true);
    expect(internals.cancelledBeforeStart.has("inv_never_seen")).toBe(true);
  });
});

describe("InvocationManager.invoke validation", () => {
  // Seed the private invocations map to simulate "another invocation is
  // already in flight" or "the cap is full" without firing real work.
  type ManagerInternals = {
    invocations: Map<string, AbortController>;
  };

  function seed(mgr: InvocationManager, id: string): void {
    (mgr as unknown as ManagerInternals).invocations.set(
      id,
      new AbortController(),
    );
  }

  it("rejects a duplicate invocationId", async () => {
    const mgr = makeManager();
    seed(mgr, "inv_dup");

    const result = await mgr.invoke({
      invocationId: "inv_dup",
      agent: getBuiltinAgent("gemini"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toMatch(/already in flight/);
    }
  });

  it("rejects when the concurrent-invocation cap is reached", async () => {
    const mgr = makeManager();
    for (let i = 0; i < 16; i++) seed(mgr, `inv_cap${i}`);

    const result = await mgr.invoke({
      invocationId: "inv_overflow",
      agent: getBuiltinAgent("gemini"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toMatch(/too many concurrent invocations/);
    }
  });

  it("rejects --session for an agent whose invokeMode lacks resumeArgs", async () => {
    // Post-2.4 this reject lives in `SubprocessInvoker.invoke` (the precondition
    // runs synchronously, before any `Bun.spawn`). Dispatch through the registry
    // with the real subprocess invoker pins the integration shape; the
    // SubprocessInvoker unit suite pins the precondition itself.
    const { SubprocessInvoker, defaultSubprocessInvokerDeps } =
      await import("./invokers/subprocess-invoker");
    const mgr = makeManager({
      subprocess: new SubprocessInvoker(defaultSubprocessInvokerDeps()),
    });

    const result = await mgr.invoke({
      invocationId: "inv_geminisess",
      agent: getBuiltinAgent("gemini"),
      prompt: "hi",
      cwd: process.cwd(),
      sessionId: "some-id",
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toMatch(/--session/);
    }
  });

  it("rejects a non-claude agent without invokeMode", async () => {
    const mgr = makeManager();
    // Stub agent shaped like a custom ccmux.json declaration that
    // didn't set invokeMode. The registry's `get()` returns undefined
    // for this; the manager surfaces it with the word "invokeMode" so
    // existing CLI error matchers keep working.
    const stub = {
      name: "no-invoke",
      shortCode: "NI",
      processMatch: /no-invoke/,
      terminalRules: [],
    } as unknown as (typeof BUILTIN_AGENTS)[number];

    const result = await mgr.invoke({
      invocationId: "inv_noinvoke1",
      agent: stub,
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toMatch(/invokeMode/);
    }
  });
});

describe("InvocationManager registry dispatch", () => {
  it("dispatches through the registry-resolved invoker with the input's signal", async () => {
    // Pin that the manager does NOT inspect agent shape itself, instead
    // routing through the registry. The recorder reads the agent type
    // it was handed and confirms the signal is wired.
    let recordedKind: Invoker["kind"] | undefined;
    let signalAtCall: AbortSignal | undefined;
    const recorder: Invoker = {
      kind: "claude-interactive",
      invoke: async (
        input: InvokeInput,
        signal: AbortSignal,
      ): Promise<InvokeResult> => {
        recordedKind = "claude-interactive";
        signalAtCall = signal;
        return {
          success: true,
          invocationId: input.invocationId,
          text: "ok",
          durationMs: 0,
        };
      },
    };
    const mgr = makeManager({ claude: recorder });

    const result = await mgr.invoke({
      invocationId: "inv_dispatch",
      agent: getBuiltinAgent("claude"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(recordedKind).toBe("claude-interactive");
    expect(signalAtCall).toBeDefined();
    expect(signalAtCall?.aborted).toBe(false);
  });

  it("aborts the in-flight signal with reason=cancelled when cancel races dispatch", async () => {
    // The invoker observes the abort during its own work and returns
    // a cancelled result via its `signal.reason` reading. Pins the
    // manager → invoker signal plumbing end-to-end.
    let observedReason: unknown;
    const recorder: Invoker = {
      kind: "claude-interactive",
      invoke: async (
        input: InvokeInput,
        signal: AbortSignal,
      ): Promise<InvokeResult> => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        observedReason = signal.reason;
        return {
          success: false,
          invocationId: input.invocationId,
          kind: "cancelled",
          message: "cancelled",
        };
      },
    };
    const mgr = makeManager({ claude: recorder });

    const invokePromise = mgr.invoke({
      invocationId: "inv_cancel_race",
      agent: getBuiltinAgent("claude"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    queueMicrotask(() => {
      mgr.cancel("inv_cancel_race");
    });

    const result = await invokePromise;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
    expect(observedReason).toBe("cancelled");
  });
});

describe("extractOpencodeJsonText", () => {
  it("returns empty string for empty input", () => {
    expect(extractOpencodeJsonText("")).toBe("");
  });

  it("concatenates text parts from sequential events", () => {
    const lines = [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Hello" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: ", world" } }),
      JSON.stringify({ type: "step_finish", part: {} }),
    ].join("\n");
    expect(extractOpencodeJsonText(lines)).toBe("Hello, world");
  });

  it("skips malformed JSON lines without throwing", () => {
    const lines = [
      "not-json{",
      JSON.stringify({ type: "text", part: { type: "text", text: "OK" } }),
    ].join("\n");
    expect(extractOpencodeJsonText(lines)).toBe("OK");
  });

  it("skips non-text events and tool-call events", () => {
    const lines = [
      JSON.stringify({ type: "tool_call", part: { name: "Bash" } }),
      JSON.stringify({ type: "text", part: { type: "tool_use" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "done" } }),
    ].join("\n");
    expect(extractOpencodeJsonText(lines)).toBe("done");
  });

  it("strips trailing newlines", () => {
    const event = JSON.stringify({
      type: "text",
      part: { type: "text", text: "trailing\n\n" },
    });
    expect(extractOpencodeJsonText(event)).toBe("trailing");
  });
});

describe("isPromptReady", () => {
  const claudePattern = getBuiltinAgent("claude").readyPattern;
  if (!claudePattern) throw new Error("claude readyPattern missing");

  it("returns true when no pattern is configured (skip-wait fallback)", () => {
    // No readyPattern on a hypothetical future tmux-path agent means
    // we don't gate the prompt-send on a TUI check; the downstream
    // session-correlation wait is the safety net.
    expect(isPromptReady("anything", "baseline", undefined)).toBe(true);
  });

  it("returns false when capture equals baseline (shell-prompt collision)", () => {
    // The bug we just fixed: user's shell prompt is `❯ ` (Starship,
    // Pure, Spaceship themes). Without the baseline check, the bare
    // pre-launch pane satisfies Claude's default readyPattern instantly
    // and ccmux sends the prompt before the agent has started.
    const shellPrompt = "~/code/project   main\n❯ ";
    expect(isPromptReady(shellPrompt, shellPrompt, claudePattern)).toBe(false);
  });

  it("returns true when capture differs and a line matches the pattern", () => {
    const baseline = "~/code/project   main\n❯ ";
    const claudeUi = [
      " ▐▛███▜▌   Claude Code v2.1.143",
      "❯ ",
      "──────────",
    ].join("\n");
    expect(isPromptReady(claudeUi, baseline, claudePattern)).toBe(true);
  });

  it("returns false when capture differs but no line matches yet", () => {
    // Claude is mid-launch: splash banner visible, prompt line not yet
    // rendered. We must keep polling, not return ready.
    const baseline = "~/code/project   main\n❯ ";
    const splashOnly = [
      " ▐▛███▜▌   Claude Code v2.1.143",
      "▝▜█████▛▘  Opus 4.7 (1M context)",
    ].join("\n");
    expect(isPromptReady(splashOnly, baseline, claudePattern)).toBe(false);
  });

  it("resets lastIndex for /g-flagged user-supplied patterns", () => {
    // A power user could put `/❯/g` in ccmux.json. Without
    // `lastIndex = 0` between lines, `.test()` advances state after
    // matching `❯` on the first early line, and on the second poll
    // (or even the next .some() iteration with a longer capture)
    // would skip past a real later match. Place the matching glyph
    // late in a multi-line capture and run twice to force any stale
    // lastIndex to bite.
    const stickyPattern = /❯/g;
    const baseline = "shell";
    const capture = ["intro line one", "intro line two", "❯ ready"].join("\n");
    expect(isPromptReady(capture, baseline, stickyPattern)).toBe(true);
    // Without the reset, the second call inherits the lastIndex from
    // the first call's match (now past the `❯`) and returns false.
    expect(isPromptReady(capture, baseline, stickyPattern)).toBe(true);
  });
});

const claudeAgent: AgentDef = getBuiltinAgent("claude");
const codexAgent: AgentDef = getBuiltinAgent("codex");
const opencodeAgent: AgentDef = getBuiltinAgent("opencode");
const geminiAgent: AgentDef = getBuiltinAgent("gemini");

describe("buildClaudeLaunchCommand", () => {
  // The NEW vs RESUME branch, the claudeBinary override, and the
  // resumeCommand template all flow through this one string-build.
  // Wrong substitution here means the wrong process gets typed into
  // the tmux pane, which is then `Enter`-submitted into the shell.

  function inputFor(
    overrides: {
      claudeBinary?: string;
      sessionId?: string;
      agent?: AgentDef;
    } = {},
  ) {
    return {
      invocationId: "inv_test",
      agent: overrides.agent ?? claudeAgent,
      claudeBinary: overrides.claudeBinary,
      prompt: "p",
      cwd: "/",
      sessionId: overrides.sessionId,
      timeoutMs: 1000,
    };
  }

  it("returns the binary alone on the NEW path", () => {
    expect(buildClaudeLaunchCommand(inputFor())).toBe("claude");
  });

  it("honors a custom claudeBinary on the NEW path", () => {
    expect(
      buildClaudeLaunchCommand(inputFor({ claudeBinary: "/my/wrapper" })),
    ).toBe("/my/wrapper");
  });

  it("falls back to `<binary> --resume <id>` when agent has no resumeCommand", () => {
    // Built-in Claude defines no resumeCommand; the function appends
    // `--resume <id>` to whichever binary is in effect. A custom binary
    // is honored on this path.
    expect(buildClaudeLaunchCommand(inputFor({ sessionId: "abc-123" }))).toBe(
      "claude --resume abc-123",
    );
    expect(
      buildClaudeLaunchCommand(
        inputFor({ sessionId: "abc-123", claudeBinary: "/my/wrapper" }),
      ),
    ).toBe("/my/wrapper --resume abc-123");
  });

  it("substitutes {id} when agent defines resumeCommand", () => {
    // Custom agents (or future Claude config) can pin the resume shape.
    // The {id} placeholder must be replaced exactly once.
    const customAgent = {
      ...claudeAgent,
      resumeCommand: "claude continue --session {id}",
    };
    expect(
      buildClaudeLaunchCommand(
        inputFor({ sessionId: "abc-123", agent: customAgent }),
      ),
    ).toBe("claude continue --session abc-123");
  });
});

describe("buildSubprocessArgv", () => {
  // Wrong argv here means we spawn the wrong agent flags - typically
  // either a missing -o tmpfile (codex returns empty), a missing
  // --session (resume becomes a fresh turn), or a literal `{id}` left
  // in the argv (the agent rejects it). Pin per-built-in.

  it("returns mode.args verbatim when no session id", () => {
    if (!codexAgent.invokeMode) throw new Error("codex invokeMode missing");
    const argv = buildSubprocessArgv(codexAgent.invokeMode, {
      tmpfile: "/tmp/x",
    });
    expect(argv).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "-o",
      "/tmp/x",
    ]);
  });

  it("uses mode.resumeArgs when session id is set and resumeArgs exist", () => {
    if (!codexAgent.invokeMode) throw new Error("codex invokeMode missing");
    const argv = buildSubprocessArgv(codexAgent.invokeMode, {
      sessionId: "sid-9",
      tmpfile: "/tmp/x",
    });
    expect(argv).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "-o",
      "/tmp/x",
      "resume",
      "sid-9",
    ]);
  });

  it("falls back to mode.args when session id is set but resumeArgs is missing", () => {
    // Gemini has no resumeArgs. A caller that passes a sessionId
    // anyway (the daemon rejects this earlier, but defense in depth
    // matters) gets the args path with `{id}` untouched - the agent
    // will surface the error, not ccmux.
    if (!geminiAgent.invokeMode) throw new Error("gemini invokeMode missing");
    const argv = buildSubprocessArgv(geminiAgent.invokeMode, {
      sessionId: "sid-9",
      tmpfile: null,
    });
    expect(argv).toEqual(["gemini", "-p", ""]);
  });

  it("substitutes {prompt} placeholder with the prompt text (gemini)", () => {
    if (!geminiAgent.invokeMode) throw new Error("gemini invokeMode missing");
    const argv = buildSubprocessArgv(geminiAgent.invokeMode, {
      tmpfile: null,
      prompt: "reply with ok",
    });
    expect(argv).toEqual(["gemini", "-p", "reply with ok"]);
  });

  it("substitutes {id} placeholder in opencode resumeArgs", () => {
    if (!opencodeAgent.invokeMode) {
      throw new Error("opencode invokeMode missing");
    }
    const argv = buildSubprocessArgv(opencodeAgent.invokeMode, {
      sessionId: "ses_abc",
      tmpfile: null,
    });
    expect(argv).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--session",
      "ses_abc",
    ]);
  });

  it("substitutes empty string for placeholders when ctx omits them", () => {
    const mode: InvokeMode = {
      args: [
        "myagent",
        "--tmpfile",
        "{tmpfile}",
        "--id",
        "{id}",
        "-p",
        "{prompt}",
      ],
      output: { kind: "stdout" },
    };
    const argv = buildSubprocessArgv(mode, { tmpfile: null });
    expect(argv).toEqual(["myagent", "--tmpfile", "", "--id", "", "-p", ""]);
  });
});

describe("subprocessPromptInArgs", () => {
  it("is true for gemini (prompt rides in `-p {prompt}`)", () => {
    if (!geminiAgent.invokeMode) throw new Error("gemini invokeMode missing");
    expect(subprocessPromptInArgs(geminiAgent.invokeMode)).toBe(true);
  });

  it("is false for codex (prompt goes via stdin, no {prompt} arg)", () => {
    if (!codexAgent.invokeMode) throw new Error("codex invokeMode missing");
    expect(subprocessPromptInArgs(codexAgent.invokeMode)).toBe(false);
  });

  it("is false for opencode (prompt goes via stdin, no {prompt} arg)", () => {
    if (!opencodeAgent.invokeMode) {
      throw new Error("opencode invokeMode missing");
    }
    // Resume path too (sessionId -> resumeArgs): still no {prompt}.
    expect(subprocessPromptInArgs(opencodeAgent.invokeMode, "ses_abc")).toBe(
      false,
    );
  });

  it("reads `{prompt}` from resumeArgs on the resume path (sessionId set)", () => {
    // Pins the resume branch selectBaseArgs shares with buildSubprocessArgv.
    const mode: InvokeMode = {
      args: ["myagent", "run"],
      resumeArgs: ["myagent", "resume", "{id}", "-p", "{prompt}"],
      output: { kind: "stdout" },
    };
    expect(subprocessPromptInArgs(mode, "sid-1")).toBe(true);
    expect(subprocessPromptInArgs(mode)).toBe(false); // fresh -> args
  });

  it("ignores `{prompt}` in resumeArgs on the fresh path", () => {
    const mode: InvokeMode = {
      args: ["myagent", "run", "-p", "{prompt}"],
      resumeArgs: ["myagent", "resume", "{id}"],
      output: { kind: "stdout" },
    };
    expect(subprocessPromptInArgs(mode, "sid-1")).toBe(false);
    expect(subprocessPromptInArgs(mode)).toBe(true);
  });
});

describe("extractSubprocessResponse", () => {
  // Three output kinds × two trailing-newline shapes. Trailing-newline
  // stripping is part of the contract: `ccmux invoke claude "..."` is
  // designed to feed `$(...)` and similar, where a stray `\n` corrupts
  // the substitution.

  const stdoutMode: InvokeMode = {
    args: ["x"],
    output: { kind: "stdout" },
  };
  const tmpfileMode: InvokeMode = {
    args: ["x", "{tmpfile}"],
    output: { kind: "tmpfile" },
  };
  const opencodeMode: InvokeMode = {
    args: ["x"],
    output: { kind: "opencode-json" },
  };

  it("returns trimmed stdout for kind=stdout", async () => {
    expect(
      await extractSubprocessResponse(stdoutMode, {
        stdout: "Hello, world\n\n",
        tmpfilePath: null,
      }),
    ).toBe("Hello, world");
  });

  it("returns trimmed tmpfile contents for kind=tmpfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccmux-extract-test-"));
    const path = join(dir, "last.txt");
    try {
      await writeFile(path, "final answer\n\n");
      expect(
        await extractSubprocessResponse(tmpfileMode, {
          stdout: "ignored",
          tmpfilePath: path,
        }),
      ).toBe("final answer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty string when the tmpfile is missing", async () => {
    expect(
      await extractSubprocessResponse(tmpfileMode, {
        stdout: "ignored",
        tmpfilePath: "/tmp/this/path/does/not/exist-ccmux",
      }),
    ).toBe("");
  });

  it("returns empty string when tmpfilePath is null", async () => {
    expect(
      await extractSubprocessResponse(tmpfileMode, {
        stdout: "ignored",
        tmpfilePath: null,
      }),
    ).toBe("");
  });

  it("aggregates JSONL text events for kind=opencode-json", async () => {
    const stdout = [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Hi " } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "there" } }),
    ].join("\n");
    expect(
      await extractSubprocessResponse(opencodeMode, {
        stdout,
        tmpfilePath: null,
      }),
    ).toBe("Hi there");
  });
});

describe("extractSubprocessSessionId", () => {
  // Only opencode-json exposes a session id in stdout. Cursor/Gemini's
  // subprocess output has no field for it. The CLI doesn't read the
  // returned id today, but a stale or wrong value here would mislead
  // anyone debugging by `curl`ing /invoke directly.

  const opencodeMode: InvokeMode = {
    args: ["opencode", "run"],
    output: { kind: "opencode-json" },
  };
  const stdoutMode: InvokeMode = {
    args: ["x"],
    output: { kind: "stdout" },
  };
  const tmpfileMode: InvokeMode = {
    args: ["x"],
    output: { kind: "tmpfile" },
  };

  it("returns the first sessionID from opencode JSONL stdout", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_first" }),
      JSON.stringify({ type: "text", sessionID: "ses_second" }),
    ].join("\n");
    expect(extractSubprocessSessionId(opencodeMode, stdout)).toBe("ses_first");
  });

  it("returns undefined when no event carries a sessionID", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: "hi" } });
    expect(extractSubprocessSessionId(opencodeMode, stdout)).toBeUndefined();
  });

  it("skips malformed JSON lines without throwing", () => {
    const stdout = [
      "not-json{",
      JSON.stringify({ type: "step", sessionID: "ses_skipped" }),
    ].join("\n");
    expect(extractSubprocessSessionId(opencodeMode, stdout)).toBe(
      "ses_skipped",
    );
  });

  it("returns undefined for non-opencode output kinds", () => {
    // stdout/tmpfile agents (cursor/gemini/codex) never expose a
    // session id in the captured output.
    const stdout = JSON.stringify({ sessionID: "would-be-leaked" });
    expect(extractSubprocessSessionId(stdoutMode, stdout)).toBeUndefined();
    expect(extractSubprocessSessionId(tmpfileMode, stdout)).toBeUndefined();
  });
});

describe("InvocationManager store + finish", () => {
  // Drive a real InvocationManager through invoke() with inline invokers we
  // fully control (resolve/throw/gate), then assert the status-store
  // transitions. These pin the heart of the invocation store: the
  // exactly-once finish contract, the success/failure/cancel branch,
  // newest-wins on id reuse, TTL purge, and linkSession.
  function makeInput(invocationId: string): InvokeInput {
    return {
      invocationId,
      agent: getBuiltinAgent("claude"),
      prompt: "hi",
      cwd: process.cwd(),
      timeoutMs: 1000,
    };
  }

  function invokerReturning(result: InvokeResult): Invoker {
    return { kind: "claude-interactive", invoke: async () => result };
  }

  // Reset any fake clock the purge test installs so later suites see real time.
  function resetClock(): void {
    setSystemTime();
  }

  it("records a succeeded terminal state and emits started+finished exactly once", async () => {
    const mgr = makeManager({
      claude: invokerReturning({
        success: true,
        invocationId: "inv_ok",
        sessionId: "sess-1",
        paneId: "%5",
        text: "done",
        durationMs: 123,
      }),
    });
    const events: InvocationEvent[] = [];
    mgr.on("change", (e: InvocationEvent) => events.push(e));

    await mgr.invoke(makeInput("inv_ok"));

    const record = mgr.getInvocation("inv_ok");
    expect(record?.status).toBe("succeeded");
    expect(record?.durationMs).toBe(123);
    expect(record?.sessionId).toBe("sess-1");
    expect(record?.paneId).toBe("%5");
    expect(events.map((e) => e.type)).toEqual(["started", "finished"]);
    expect(mgr.inFlightCount).toBe(0);
  });

  it("inFlightCount reflects an active invocation and drops to 0 at finish", async () => {
    // Dedicated coverage for the `inFlightCount` getter, which reads the
    // active AbortController map (not the finished-record store). A
    // deferred-release invoker holds the invocation in flight so we can
    // observe the count as 1 mid-flight; other tests only assert the
    // post-finish 0.
    let release: (r: InvokeResult) => void = () => {};
    const mgr = makeManager({
      claude: {
        kind: "claude-interactive",
        invoke: async () =>
          new Promise<InvokeResult>((r) => {
            release = r;
          }),
      },
    });

    expect(mgr.inFlightCount).toBe(0);
    const pending = mgr.invoke(makeInput("inv_inflight_count"));
    expect(mgr.inFlightCount).toBe(1);

    release({
      success: true,
      invocationId: "inv_inflight_count",
      text: "x",
      durationMs: 1,
    });
    await pending;
    expect(mgr.inFlightCount).toBe(0);
  });

  it("records a failed terminal state with kind + computed durationMs", async () => {
    const mgr = makeManager({
      claude: invokerReturning({
        success: false,
        invocationId: "inv_fail",
        kind: "agent_error",
        message: "boom",
      }),
    });
    await mgr.invoke(makeInput("inv_fail"));
    const record = mgr.getInvocation("inv_fail");
    expect(record?.status).toBe("failed");
    expect(record?.kind).toBe("agent_error");
    expect(typeof record?.durationMs).toBe("number");
  });

  it("maps a cancelled result to status cancelled, not failed", async () => {
    // Regression guard for the cancel-status fix.
    const mgr = makeManager({
      claude: invokerReturning({
        success: false,
        invocationId: "inv_cancel",
        kind: "cancelled",
        message: "cancelled",
      }),
    });
    await mgr.invoke(makeInput("inv_cancel"));
    const record = mgr.getInvocation("inv_cancel");
    expect(record?.status).toBe("cancelled");
    expect(record?.kind).toBe("cancelled");
  });

  it("leaves a terminal (not running) record and re-throws when the invoker throws", async () => {
    const mgr = makeManager({
      claude: {
        kind: "claude-interactive",
        invoke: async () => {
          throw new Error("kaboom");
        },
      },
    });
    const events: InvocationEvent[] = [];
    mgr.on("change", (e: InvocationEvent) => events.push(e));

    await expect(mgr.invoke(makeInput("inv_throw"))).rejects.toThrow("kaboom");

    const record = mgr.getInvocation("inv_throw");
    expect(record).toBeDefined();
    expect(record?.status).toBe("failed");
    expect(events.map((e) => e.type)).toEqual(["started", "finished"]);
    // The finally ran: the slot is freed even on the throw path.
    expect(mgr.inFlightCount).toBe(0);
  });

  it("does not let a throwing change listener strand a running record or leak a slot", async () => {
    // safeEmit must swallow listener exceptions so finish()/finally still
    // run — otherwise a future SSE handler that throws would permanently
    // strand a `running` record and burn a concurrency slot.
    const mgr = makeManager({
      claude: invokerReturning({
        success: true,
        invocationId: "inv_listener",
        text: "ok",
        durationMs: 1,
      }),
    });
    mgr.on("change", () => {
      throw new Error("listener blew up");
    });

    await mgr.invoke(makeInput("inv_listener"));

    expect(mgr.getInvocation("inv_listener")?.status).toBe("succeeded");
    expect(mgr.inFlightCount).toBe(0);
  });

  it("overwrites a finished record on id reuse (newest-wins)", async () => {
    let call = 0;
    let resolveSecond: (r: InvokeResult) => void = () => {};
    const invoker: Invoker = {
      kind: "claude-interactive",
      invoke: async (input: InvokeInput) => {
        call += 1;
        if (call === 1) {
          return {
            success: true,
            invocationId: input.invocationId,
            text: "first",
            durationMs: 1,
          };
        }
        return new Promise<InvokeResult>((r) => {
          resolveSecond = r;
        });
      },
    };
    const mgr = makeManager({ claude: invoker });

    await mgr.invoke(makeInput("inv_reuse"));
    expect(mgr.getInvocation("inv_reuse")?.status).toBe("succeeded");

    // First is no longer in flight (finally deleted it), so the second is
    // admitted and its running record overwrites the finished one.
    const second = mgr.invoke(makeInput("inv_reuse"));
    expect(mgr.getInvocation("inv_reuse")?.status).toBe("running");

    resolveSecond({
      success: true,
      invocationId: "inv_reuse",
      text: "second",
      durationMs: 2,
    });
    await second;
    expect(mgr.getInvocation("inv_reuse")?.status).toBe("succeeded");
  });

  it("linkSession sets sessionId/paneId on a present record and no-ops on a missing id", async () => {
    let release: (r: InvokeResult) => void = () => {};
    const mgr = makeManager({
      claude: {
        kind: "claude-interactive",
        invoke: async () =>
          new Promise<InvokeResult>((r) => {
            release = r;
          }),
      },
    });

    const pending = mgr.invoke(makeInput("inv_link"));
    mgr.linkSession("inv_link", "sess-9", "%7");
    expect(mgr.getInvocation("inv_link")?.sessionId).toBe("sess-9");
    expect(mgr.getInvocation("inv_link")?.paneId).toBe("%7");

    expect(() => mgr.linkSession("inv_absent", "s", "%1")).not.toThrow();
    expect(mgr.getInvocation("inv_absent")).toBeUndefined();

    release({
      success: true,
      invocationId: "inv_link",
      text: "x",
      durationMs: 1,
    });
    await pending;
  });

  it("purges a terminal record past TTL but keeps a running one", async () => {
    const t0 = 1_700_000_000_000;
    setSystemTime(new Date(t0));
    try {
      let call = 0;
      let releaseLong: (r: InvokeResult) => void = () => {};
      const invoker: Invoker = {
        kind: "claude-interactive",
        invoke: async (input: InvokeInput) => {
          call += 1;
          if (call === 1) {
            return {
              success: true,
              invocationId: input.invocationId,
              text: "x",
              durationMs: 1,
            };
          }
          return new Promise<InvokeResult>((r) => {
            releaseLong = r;
          });
        },
      };
      const mgr = makeManager({ claude: invoker });

      await mgr.invoke(makeInput("inv_terminal")); // finished at t0
      const long = mgr.invoke(makeInput("inv_running")); // stays running
      expect(mgr.getInvocation("inv_terminal")?.status).toBe("succeeded");
      expect(mgr.getInvocation("inv_running")?.status).toBe("running");

      // Advance past FINISHED_RECORD_TTL_MS (5 min); listInvocations purges.
      setSystemTime(new Date(t0 + 6 * 60_000));
      const ids = mgr.listInvocations().map((r) => r.invocationId);
      expect(ids).not.toContain("inv_terminal");
      expect(ids).toContain("inv_running");

      resetClock();
      releaseLong({
        success: true,
        invocationId: "inv_running",
        text: "y",
        durationMs: 1,
      });
      await long;
    } finally {
      resetClock();
    }
  });
});
