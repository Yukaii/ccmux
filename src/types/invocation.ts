/**
 * Shared invocation types. Lives in `src/types` (the leaf both the TUI and
 * the daemon depend on) so the SSE event shapes and the daemon invokers can
 * reference these without `src/types` reaching back into `src/daemon`.
 */

/**
 * Failure kind for a finished invocation. `cancelled` is carried on the
 * `kind` of a `cancelled` record; every other non-success value pairs with
 * a `failed` status.
 */
export type InvokeErrorKind =
  | "rate_limit"
  | "timeout"
  | "agent_error"
  | "hooks_missing"
  | "cancelled"
  | "unknown";

/**
 * Terminal status of a finished invocation (the `running` member of
 * `InvocationStatus` is excluded, since a finished event is never running).
 */
export type FinishedInvocationStatus = "succeeded" | "failed" | "cancelled";

/**
 * Full lifecycle status of an invocation: in-flight (`running`) or one of
 * the terminal outcomes. Single source of truth for the daemon's
 * `InvocationRecord.status`, the board's `originInvocationStatus`, and the
 * invoke status badge.
 */
export type InvocationStatus = "running" | FinishedInvocationStatus;
