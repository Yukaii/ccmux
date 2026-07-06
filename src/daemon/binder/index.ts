/**
 * The binder: one module owning every session↔pane/process matching
 * decision. Decision functions are pure —
 * observations in, bindings/actions out; all I/O lives in the callers.
 *
 * Phase 1 (consolidation): the five former ladders live here as
 * per-role decision functions with their original policies intact.
 * Phase 2 (re-verification): bindings re-assert every scan, marker pids
 * verify against the pane's live process, and destructive transitions
 * (unbind / remove) carry two-scan hysteresis.
 * Phase 3 (group-wise assignment, refuse-to-guess): heuristic matching is
 * solved per same-cwd group by `assign.ts` with direction/tolerance
 * eligibility and ambiguity refusal — a session the evidence
 * cannot place is visibly unbound, never guessed.
 */
export * from "./types";
export * from "./primitives";
export {
  assignGroup,
  forwardGapCost,
  ASSIGN_TOLERANCE_MS,
  ASSIGN_DIRECTION_SKEW_MS,
  ASSIGN_AMBIGUITY_MS,
  ASSIGN_MAX_GROUP,
  type GroupAssignment,
  type UnboundReason,
} from "./assign";
export { decideScanBindings } from "./scan";
export {
  decideStaleCleanup,
  type CleanupObservation,
  type CleanupSessionSlice,
  type CleanupDecision,
} from "./cleanup";
export {
  decideNewSessionPane,
  decideReplaceHeuristic,
  decideInitialClaudeBatch,
  encodingDriftWarning,
} from "./claude-log";
export { decideMigrationBindings } from "./migrate";
export {
  decideCodexRolloutLinks,
  decideMarkerLinks,
  type CodexLinkCandidate,
} from "./links";
