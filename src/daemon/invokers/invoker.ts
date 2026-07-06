import type { AgentDef } from "../../lib/agents";
import type { InvokeInput, InvokeResult } from "./types";

/**
 * What an `Invoker` is allowed to do for a given agent. Derived from the
 * pairing of `AgentDef` and `Invoker.kind` via `capabilitiesFor`. Both
 * production capability checks route through this shape:
 * `server.ts:handleInvoke` gates the `hooks_missing` branch on
 * `requiresHooks`, and `SubprocessInvoker.invoke` gates the
 * `does not support --session <id>` reject on `supportsSessionResume`.
 * `capabilitiesFor` is the only place that interprets `AgentDef` fields
 * as invoke-time capabilities.
 */
export interface InvokerCapabilities {
  /**
   * `supportsSessionResume: true` for `claude-interactive` is the invoker's
   * contract (`buildClaudeLaunchCommand` falls back to
   * `<binary> --resume <id>` when `agent.resumeCommand` is unset), not an
   * AgentDef-derived fact. Claude has no `resumeCommand` in BUILTIN_AGENTS
   * yet resume always works. `SubprocessInvoker.invoke` reads this to
   * decide whether `--session <id>` is rejected up front.
   */
  supportsSessionResume: boolean;
  /**
   * Path-driven, not config-driven: every claude-interactive pairing
   * requires hooks for session correlation, regardless of whether a future
   * AgentDef cosmetic refactor removes the `hooks` block. The server's
   * `hooks_missing` check still ANDs this with `adapter.isInstalled()` at
   * runtime; this flag captures the precondition only.
   */
  requiresHooks: boolean;
}

export type InvokerKind = "claude-interactive" | "subprocess";

/**
 * Runs a single `ccmux invoke` request end-to-end. `ClaudeInvoker` (2.2,
 * interactive tmux + JSONL) and `SubprocessInvoker` (2.3, `Bun.spawn`)
 * implement this. Capabilities are derived externally via `capabilitiesFor`
 * so AgentDef stays the only source registering which agent can do what.
 */
export interface Invoker {
  readonly kind: InvokerKind;
  invoke(input: InvokeInput, abortSignal: AbortSignal): Promise<InvokeResult>;
}

/**
 * Pure derivation. Claude-interactive intentionally ignores `agent` because
 * the invoker's contract (resume via fallback, hooks required by path)
 * pins both answers; only the subprocess branch reads AgentDef fields.
 */
export function capabilitiesFor(
  agent: AgentDef,
  invoker: Invoker,
): InvokerCapabilities {
  switch (invoker.kind) {
    case "claude-interactive":
      return {
        supportsSessionResume: true,
        requiresHooks: true,
      };
    case "subprocess":
      return {
        supportsSessionResume: Boolean(agent.invokeMode?.resumeArgs),
        requiresHooks: false,
      };
  }
}
