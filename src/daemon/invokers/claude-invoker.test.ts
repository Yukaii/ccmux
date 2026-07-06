import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { CLAUDE_AGENT_DEF } from "../../lib/agents";
import type { LogEntry } from "../../types/log";
import type { Session } from "../../types/session";
import type { InvokeInput, InvokeSuccess } from "./types";
import { ClaudeInvoker, type ClaudeInvokerDeps } from "./claude-invoker";

/**
 * Minimal SessionManager double satisfying `InvokerSessionManager`. Wraps
 * `EventEmitter` so the invoker's `change`-event listener and `off`
 * cleanup behave like the real class.
 */
class FakeSessionManager extends EventEmitter {
  private sessions: Session[] = [];
  addSession(s: Session): void {
    this.sessions.push(s);
  }
  getSessions(): Readonly<Session>[] {
    return this.sessions;
  }
}

function makeInput(overrides: Partial<InvokeInput> = {}): InvokeInput {
  return {
    invocationId: "inv_test",
    agent: CLAUDE_AGENT_DEF,
    prompt: "hello there",
    cwd: "/tmp/test",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_local_uuid",
    tmuxPane: "%9",
    logPath: "/tmp/transcript.jsonl",
    agentType: "claude",
    nativeSessionId: "claude_native_abc",
    cwd: "/tmp/test",
    ...overrides,
  } as Session;
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

interface TestDeps extends ClaudeInvokerDeps {
  sessionManager: FakeSessionManager;
}

/**
 * Default test deps: tmux invocations succeed; the prompt-ready capture
 * shows a transition from "$ " baseline to "❯" glyph so `isPromptReady`
 * succeeds on the first iteration; `getPaneCurrentCommand` returns null
 * so the post-ready "did Claude take over?" check is skipped (specific
 * tests opt back into it). The session manager starts empty; callers add
 * sessions to drive correlation success.
 */
function makeDeps(): TestDeps {
  const sm = new FakeSessionManager();
  let captureCallCount = 0;
  return {
    sessionManager: sm,
    tmux: {
      createDetachedTmuxSession: mock(async () => ({ paneId: "%9" })),
      sendLiteralToPane: mock(async () => true),
      sendPromptToPane: mock(async () => true),
      sendKeyToPane: mock(async () => true),
      capturePane: mock(async () => {
        captureCallCount += 1;
        return captureCallCount === 1 ? "$ " : "❯ ";
      }),
      getPaneCurrentCommand: mock(async () => null),
      killTmuxSession: mock(async () => {}),
    },
    readLogIncremental: mock(async () => ({ entries: [], newOffset: 0 })),
    getLogFileSize: mock(() => 0),
    now: mock(() => 1_000_000_000_000),
  };
}

async function invokeOk(
  deps: ClaudeInvokerDeps,
  input: InvokeInput,
): Promise<InvokeSuccess> {
  const result = await new ClaudeInvoker(deps).invoke(
    input,
    new AbortController().signal,
  );
  if (!result.success) {
    throw new Error(`expected success, got ${result.kind}: ${result.message}`);
  }
  return result;
}

const PROMPT_READY_TIMEOUT_MS = 15_000;

describe("ClaudeInvoker.invoke", () => {
  it("returns immediately when the signal is already aborted", async () => {
    const deps = makeDeps();
    const ac = new AbortController();
    ac.abort("cancelled");
    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
    expect(deps.tmux.createDetachedTmuxSession).not.toHaveBeenCalled();
  });

  it("succeeds on the NEW path, sending prompt before correlating", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());

    let readLogCalls = 0;
    deps.readLogIncremental = mock(async () => {
      readLogCalls += 1;
      if (readLogCalls === 1) {
        return {
          entries: [assistantEntry("hi from claude", "end_turn")] as LogEntry[],
          newOffset: 64,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 64 };
    });

    const result = await invokeOk(deps, makeInput());
    expect(result.text).toBe("hi from claude");
    // Native id, not the ccmux-internal session.id.
    expect(result.sessionId).toBe("claude_native_abc");
    expect(result.paneId).toBe("%9");

    // NEW: prompt is sent before correlation; getLogFileSize is never
    // consulted because logBaseline stays 0.
    expect(deps.tmux.sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(deps.getLogFileSize).not.toHaveBeenCalled();

    // The failure-mode errorRule capture (the only call site that uses
    // CLAUDE_FAILURE_CAPTURE_LINES = 400 lines) must NOT run on a
    // successful turn. Asserting on the specific call argument is more
    // robust than a total-call-count check, which would couple to the
    // pre-launch + prompt-ready iteration count.
    const captureCalls = (deps.tmux.capturePane as ReturnType<typeof mock>).mock
      .calls;
    expect(captureCalls.every(([, lines]) => lines !== 400)).toBe(true);
  });

  it("succeeds on the RESUME path, anchoring readLogIncremental to baseline", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(
      makeSession({ logPath: "/tmp/resume.jsonl" }),
    );
    deps.getLogFileSize = mock(() => 2048);
    deps.readLogIncremental = mock(async (_path: string, offset: number) => {
      if (offset === 2048) {
        return {
          entries: [assistantEntry("resumed reply", "end_turn")] as LogEntry[],
          newOffset: 2200,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 2048 };
    });

    const result = await invokeOk(
      deps,
      makeInput({ sessionId: "claude_native_abc" }),
    );
    expect(result.text).toBe("resumed reply");
    expect(deps.getLogFileSize).toHaveBeenCalledWith("/tmp/resume.jsonl");
    expect(deps.readLogIncremental).toHaveBeenCalledWith(
      "/tmp/resume.jsonl",
      2048,
    );
  });

  it("falls back to offset 0 on RESUME when getLogFileSize throws", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(
      makeSession({ logPath: "/tmp/missing.jsonl" }),
    );
    // Transcript hasn't been written yet — getLogFileSize on a missing
    // file throws. The invoker swallows the throw and reads from offset
    // 0; readLogIncremental still sees everything once the file appears.
    deps.getLogFileSize = mock(() => {
      throw new Error("ENOENT: no such file");
    });
    deps.readLogIncremental = mock(async (_path: string, offset: number) => {
      if (offset === 0) {
        return {
          entries: [
            assistantEntry("late transcript", "end_turn"),
          ] as LogEntry[],
          newOffset: 128,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });

    const result = await invokeOk(
      deps,
      makeInput({ sessionId: "claude_native_abc" }),
    );
    expect(result.text).toBe("late transcript");
    expect(deps.readLogIncremental).toHaveBeenCalledWith(
      "/tmp/missing.jsonl",
      0,
    );
  });

  it("skips readLogIncremental when the correlated session has no logPath", async () => {
    const ac = new AbortController();
    const deps = makeDeps();
    // Staged session enrichment: correlation succeeds before logPath
    // lands. The turn-end loop must skip readLogIncremental on every
    // iteration rather than throwing on the null path.
    deps.sessionManager.addSession(makeSession({ logPath: null }));

    // Fire abort once the loop has had a chance to iterate, so the test
    // doesn't sit forever.
    setTimeout(() => ac.abort("cancelled"), 100);

    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
    expect(deps.readLogIncremental).not.toHaveBeenCalled();
  });

  it("returns agent_error when the prompt-ready capture never matches", async () => {
    const deps = makeDeps();
    // Capture always returns the baseline string so the transition check
    // in `isPromptReady` fails forever. Advance `now()` past the timeout
    // on the third call so the loop exits without 15 seconds of
    // real-time polling. Calls 1 + 2 are tStart and the wait loop's
    // `start` anchor; subsequent calls are the loop-condition check.
    deps.tmux.capturePane = mock(async () => "$ ");
    let nowCalls = 0;
    deps.now = mock(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? 0 : PROMPT_READY_TIMEOUT_MS + 1;
    });
    deps.sessionManager.addSession(makeSession());

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("Claude prompt did not appear");
    }
  });

  it("returns unknown when createDetachedTmuxSession fails", async () => {
    const deps = makeDeps();
    deps.tmux.createDetachedTmuxSession = mock(async () => null);

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("tmux new-session failed");
    }
    // killTmuxSession is still called in the finally even when the new
    // session never came up: tmux is no-op safe on missing names and the
    // unconditional call is the simpler invariant.
    expect(deps.tmux.killTmuxSession).toHaveBeenCalledTimes(1);
  });

  it("returns unknown when sendLiteralToPane fails without abort", async () => {
    const deps = makeDeps();
    deps.tmux.sendLiteralToPane = mock(async () => false);

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("failed to send launch command");
    }
  });

  it("relabels sendLiteralToPane failure to cancelled when racing an abort", async () => {
    const ac = new AbortController();
    const deps = makeDeps();
    deps.tmux.sendLiteralToPane = mock(async () => {
      ac.abort("cancelled");
      return false;
    });

    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
  });

  it("returns agent_error when the shell still owns the pane after readyPattern", async () => {
    const deps = makeDeps();
    // Both pre-launch and post-ready report the same shell command, so
    // the defense-in-depth check fires.
    deps.tmux.getPaneCurrentCommand = mock(async () => "zsh");
    deps.sessionManager.addSession(makeSession());

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toContain("did not take over the pane");
    }
  });

  it("proceeds past the defense check when post-ready getPaneCurrentCommand transiently returns null", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());
    // Pre-launch reports the shell; post-ready returns null (transient
    // tmux display-message hiccup). The check must skip — otherwise a
    // wobbly tmux query would surface a spurious agent_error.
    let cmdCalls = 0;
    deps.tmux.getPaneCurrentCommand = mock(async () => {
      cmdCalls += 1;
      return cmdCalls === 1 ? "zsh" : null;
    });
    let firstRead = true;
    deps.readLogIncremental = mock(async () => {
      if (firstRead) {
        firstRead = false;
        return {
          entries: [assistantEntry("ok", "end_turn")] as LogEntry[],
          newOffset: 0,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });

    const result = await invokeOk(deps, makeInput());
    expect(result.text).toBe("ok");
    // Both pre-launch and post-ready snapshots taken.
    expect(deps.tmux.getPaneCurrentCommand).toHaveBeenCalledTimes(2);
  });

  it("returns unknown when sendPromptToPane fails on the NEW path", async () => {
    const deps = makeDeps();
    deps.tmux.sendPromptToPane = mock(async () => false);
    deps.sessionManager.addSession(makeSession());

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("failed to send prompt");
    }
  });

  it("returns cancelled when correlation is aborted before any session arrives", async () => {
    const ac = new AbortController();
    const deps = makeDeps();
    // No sessions are added and no `change` event is ever emitted, so
    // waitForSessionByPane parks on the abort/timeout race. Abort wins
    // because we fire it during the sendPromptToPane call.
    deps.tmux.sendPromptToPane = mock(async () => {
      ac.abort("cancelled");
      return true;
    });

    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
  });

  it("returns agent_error when waitForSessionByPane hits the natural timeout", async () => {
    // Pin the natural-timeout branch of waitForSessionByPane without the
    // 30s real-time wait. No session is added, no `change` event fires,
    // and no abort happens — only the internal setTimeout resolves, which
    // we shrink via the injected `sessionCorrelationTimeoutMs`.
    const deps = makeDeps();
    deps.sessionCorrelationTimeoutMs = 10;

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("agent_error");
      expect(result.message).toBe(
        "Agent did not produce a session within 0.01s",
      );
      expect(result.paneId).toBe("%9");
    }
  });

  it("sends C-c before killing the tmux session when the turn is cancelled", async () => {
    const ac = new AbortController();
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());

    const callOrder: string[] = [];
    deps.tmux.sendKeyToPane = mock(async () => {
      callOrder.push("sendKey");
      return true;
    });
    deps.tmux.killTmuxSession = mock(async () => {
      callOrder.push("kill");
    });
    let firstRead = true;
    deps.readLogIncremental = mock(async () => {
      if (firstRead) {
        firstRead = false;
        ac.abort("cancelled");
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });

    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("cancelled");
    // C-c first, then kill. The 2.4 manager will rely on this invariant
    // when it switches dispatch to the registry and stops driving paneId
    // itself.
    expect(callOrder).toEqual(["sendKey", "kill"]);
  });

  it("classifies a turn-wait abort as timeout when signal.reason is timeout", async () => {
    const ac = new AbortController();
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());
    let firstRead = true;
    deps.readLogIncremental = mock(async () => {
      if (firstRead) {
        firstRead = false;
        ac.abort("timeout");
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });

    const result = await new ClaudeInvoker(deps).invoke(makeInput(), ac.signal);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("timeout");
  });

  it("maps a rate-limit banner on empty text to rate_limit failure", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());
    // Turn ends with empty assistant content.
    let firstRead = true;
    deps.readLogIncremental = mock(async () => {
      if (firstRead) {
        firstRead = false;
        return {
          entries: [
            {
              type: "assistant",
              message: { content: [], stop_reason: "end_turn" },
            } as unknown as LogEntry,
          ],
          newOffset: 0,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });
    // Failure-mode capture (called only when text === "") returns the
    // chrome region containing the rate-limit phrasing the agent
    // errorRule is anchored on.
    let captureCount = 0;
    deps.tmux.capturePane = mock(async () => {
      captureCount += 1;
      if (captureCount === 1) return "$ ";
      if (captureCount === 2) return "❯ ";
      return "Claude is unavailable\n5-hour limit reached\n";
    });

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe("rate_limit");
  });

  it("returns a successful empty response when text is empty and no errorRule matches", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());
    let firstRead = true;
    deps.readLogIncremental = mock(async () => {
      if (firstRead) {
        firstRead = false;
        return {
          entries: [
            {
              type: "assistant",
              message: { content: [], stop_reason: "end_turn" },
            } as unknown as LogEntry,
          ],
          newOffset: 0,
        };
      }
      return { entries: [] as LogEntry[], newOffset: 0 };
    });

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput(),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.text).toBe("");
  });

  it("returns unknown when sendPromptToPane fails on the RESUME path", async () => {
    const deps = makeDeps();
    deps.sessionManager.addSession(makeSession());
    deps.getLogFileSize = mock(() => 1024);
    deps.tmux.sendPromptToPane = mock(async () => false);

    const result = await new ClaudeInvoker(deps).invoke(
      makeInput({ sessionId: "claude_native_abc" }),
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("failed to send prompt");
    }
  });
});
