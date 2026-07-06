import type { AgentDef } from "../../lib/agents";
import type { InvokeErrorKind } from "../../types";

// Canonical definition lives in `src/types/invocation.ts`; re-exported here
// so the invoker modules can keep importing it from `./types`.
export type { InvokeErrorKind };

/**
 * Input shape for any `Invoker.invoke()` call. The two invoker
 * implementations (`ClaudeInvoker`, `SubprocessInvoker`) read from this
 * type but share no input-specific fields, so the shape is the union of
 * what either path needs. `InvocationManager` builds it once per
 * `POST /invoke` and hands it off after the registry resolves which
 * invoker dispatches.
 */
export interface InvokeInput {
  invocationId: string;
  agent: AgentDef;
  /**
   * The Claude binary to spawn in the tmux path, honoring
   * `preferences.command` so users with wrapper scripts still work.
   * Computed by server.ts and ignored by the subprocess path (which uses
   * `invokeMode.args[0]`).
   */
  claudeBinary?: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  timeoutMs: number;
}

export interface InvokeSuccess {
  success: true;
  invocationId: string;
  /**
   * Native session id, when extractable. Set by the Claude tmux path
   * (from the transcript) and by the OpenCode subprocess path (from
   * the JSONL events). Other subprocess agents either don't expose one
   * non-interactively (cursor, gemini) or hide it in chrome we skip
   * (codex). Resuming a session id we never extracted is fine, the
   * caller passes `--session <id>` explicitly.
   */
  sessionId?: string;
  /** Set only by the Claude tmux path. */
  paneId?: string;
  text: string;
  durationMs: number;
}

export interface InvokeFailure {
  success: false;
  kind: InvokeErrorKind;
  message: string;
  invocationId?: string;
  paneId?: string;
}

export type InvokeResult = InvokeSuccess | InvokeFailure;
