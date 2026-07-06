import type { SessionMetadata } from "../../log-adapter";

/**
 * Maximum forward gap (ms) between `proc.startTime` and `rollout.timestamp`
 * for a Codex rollout to match a live process. Codex writes the rollout file
 * lazily on the first turn, so a brand-new pane may briefly have no fresh
 * rollout. The window covers that startup gap without letting unrelated
 * prior-session rollouts in the same cwd win the match.
 */
export const CODEX_LINK_WINDOW_MS = 60 * 1000;

/**
 * Grace (ms) for rollouts whose `session_meta.timestamp` is slightly earlier
 * than `proc.startTime`. Codex always begins a rollout after the process
 * starts, so a true match is forward-in-time; this grace only absorbs
 * sub-second skew between the OS's process accounting and Codex's wall-clock
 * stamp.
 */
export const CODEX_LINK_BACKWARD_GRACE_MS = 5 * 1000;

export interface CodexRolloutCandidate {
  path: string;
  metadata: SessionMetadata;
}

/**
 * Eligibility + cost of pairing a live Codex process with a rollout, for
 * the binder's group-wise assignment. Ineligible (`null`) when
 * the cwds differ or the rollout's timestamp falls outside the forward
 * window (with the small backward grace for clock skew). Otherwise the cost
 * is the forward gap in ms — the closest fresh rollout wins the assignment,
 * and near-ties are refused by the assignment's ambiguity gate rather than
 * guessed here.
 */
export function codexRolloutPairCost(
  proc: { cwd: string; startTime: number },
  rollout: CodexRolloutCandidate,
): number | null {
  if (rollout.metadata.cwd !== proc.cwd) return null;
  const delta = rollout.metadata.timestamp - proc.startTime;
  if (delta < -CODEX_LINK_BACKWARD_GRACE_MS || delta >= CODEX_LINK_WINDOW_MS) {
    return null;
  }
  return Math.max(delta, 0);
}
