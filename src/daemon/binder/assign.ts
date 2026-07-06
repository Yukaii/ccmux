/**
 * Group-wise optimal assignment: replaces the
 * greedy closest-match-with-exclusion-set loops. A same-cwd group of sessions
 * and candidates (proc/pane pairs, or codex rollouts) is solved as one small
 * assignment problem, which removes the order-dependence that let one wrong
 * guess cascade into a full permutation.
 *
 * Groups are tiny (n ≤ 5 in practice), so the solver enumerates injective
 * assignments outright. Enumeration also gives the runner-up costs needed for
 * the D3 ambiguity refusal for free — a Hungarian solver would not.
 */

/** D2 — the audit-era 600s history-correlation tolerance, kept as the cap. */
export const ASSIGN_TOLERANCE_MS = 600_000;

/**
 * D1 — clock-skew epsilon: a session timestamp may precede its process's
 * start by at most this much (ps etime is 1s-resolution and derived from
 * `Date.now()`, so sub-second skew between the two clocks is normal).
 */
export const ASSIGN_DIRECTION_SKEW_MS = 2_000;

/**
 * D3 — refusal band: when the runner-up assignment is within this of the
 * best, the choice is `ps etime` jitter, not signal. ±1–2s per the audit.
 */
export const ASSIGN_AMBIGUITY_MS = 2_000;

/**
 * Cap on group size — ELIGIBLE sessions, or candidates — before the solver
 * refuses the whole group. Applied after the D1/D2 gates thin the pool:
 * callers legitimately feed large raw pools (every history session of a
 * long-lived cwd, every stale transcript sharing a cwd) of which only the
 * few live ones survive eligibility. Enumeration at 8×8 is still trivial
 * (~10⁵ assignments); real eligible groups are ≤ 5, so hitting this means
 * the observation itself is suspect.
 */
export const ASSIGN_MAX_GROUP = 8;

export type UnboundReason =
  /** No eligible candidate: no usable timestamps (D4), all candidates fail
   * the direction constraint (D1), or none within tolerance (D2). */
  | "no-signal"
  /** Runner-up assignment within the jitter band (D3). */
  | "ambiguous"
  /** Eligible, but every eligible candidate went to a clearly-better session. */
  | "outcompeted"
  /** Group exceeded ASSIGN_MAX_GROUP; heuristic binding refused wholesale. */
  | "group-too-large";

export interface GroupAssignment {
  /** sessionIndex → candidateIndex, confidently bound pairs only. */
  bound: Map<number, number>;
  /** sessionIndex → reason, for every session not in `bound`. */
  unbound: Map<number, UnboundReason>;
  /** True when the group blew the size cap (caller should log it). */
  overflow: boolean;
}

/**
 * D1+D2+D7 cost for timestamp-correlated candidates: the smallest forward
 * gap from the candidate's start time to ANY of the session's activity
 * timestamps. Scanning all timestamps (not just the first) is what makes a
 * resumed session correlate to today's run instead of its original prompt:
 * today's entries sit just after today's process start, while the
 * days-old first entry fails the direction constraint for today's process.
 *
 * Returns null (ineligible) when the candidate has no usable start time
 * (D4 — a no-signal candidate never wins by default) or no timestamp falls
 * inside the [-skew, tolerance] window (D1/D2).
 */
export function forwardGapCost(
  timestamps: readonly number[],
  candidateStartMs: number | null | undefined,
  opts?: { toleranceMs?: number; skewMs?: number },
): number | null {
  if (candidateStartMs == null) return null;
  const toleranceMs = opts?.toleranceMs ?? ASSIGN_TOLERANCE_MS;
  const skewMs = opts?.skewMs ?? ASSIGN_DIRECTION_SKEW_MS;

  let best: number | null = null;
  for (const ts of timestamps) {
    const gap = ts - candidateStartMs;
    if (gap < -skewMs || gap > toleranceMs) continue;
    // Clamp skew-negative gaps to zero so costs stay comparable magnitudes.
    const cost = Math.max(gap, 0);
    if (best === null || cost < best) best = cost;
  }
  return best;
}

interface EnumerationState {
  bestCost: number;
  bestPartner: Int32Array;
  /** For each session, best K-cardinality cost with a DIFFERENT partner. */
  altCost: Float64Array;
}

/**
 * Solve one group. `cost(s, c)` returns the pairing cost in ms, or null when
 * the pair is ineligible (D1/D2/D4/R1 gates — the caller owns eligibility).
 *
 * Output policy:
 * - Maximal cardinality first (bind as many sessions as the evidence
 *   allows), minimal total cost among those. Deliberate consequence: a
 *   session can be bound to an eligible-but-distant candidate (up to the
 *   D2 tolerance) because its own closest candidate belongs to another
 *   session — that is exactly AT-D6's correct outcome, so no per-session
 *   "regret" gate is applied; the tolerance cap bounds the worst case and
 *   markers + per-scan re-assert heal a wrong forced fill.
 * - A bound session whose best alternative assignment (different partner,
 *   including unbound-with-someone-else-bound) is within `ambiguityMs` of
 *   the optimum is `"ambiguous"` and unbound (D3). Exact ties therefore
 *   always refuse, which is what makes the result independent of session
 *   iteration order (AT-D6).
 * - No re-solve after ambiguity removal: a candidate freed by an ambiguity
 *   refusal is exactly the pane whose ownership is in doubt, so handing it
 *   to a third session would contradict the refusal.
 */
export function assignGroup(
  sessionCount: number,
  candidateCount: number,
  cost: (sessionIndex: number, candidateIndex: number) => number | null,
  opts?: { ambiguityMs?: number; maxGroupSize?: number },
): GroupAssignment {
  const ambiguityMs = opts?.ambiguityMs ?? ASSIGN_AMBIGUITY_MS;
  const maxGroupSize = opts?.maxGroupSize ?? ASSIGN_MAX_GROUP;

  const bound = new Map<number, number>();
  const unbound = new Map<number, UnboundReason>();

  // Materialize the eligible cost matrix once. The size cap is checked on
  // the ELIGIBLE counts (below), not the raw pools: callers feed every
  // history session / stale transcript / live proc of a cwd, and the D1/D2
  // gates are what reduce those to the handful of live contenders.
  const matrix: (number | null)[][] = [];
  const eligible: number[] = [];
  const eligibleCandidates = new Set<number>();
  for (let s = 0; s < sessionCount; s++) {
    const row: (number | null)[] = [];
    let any = false;
    for (let c = 0; c < candidateCount; c++) {
      const v = cost(s, c);
      row.push(v);
      if (v !== null) {
        any = true;
        eligibleCandidates.add(c);
      }
    }
    matrix.push(row);
    if (any) {
      eligible.push(s);
    } else {
      unbound.set(s, "no-signal");
    }
  }

  if (
    eligible.length > maxGroupSize ||
    eligibleCandidates.size > maxGroupSize
  ) {
    for (const s of eligible) unbound.set(s, "group-too-large");
    return { bound, unbound, overflow: true };
  }

  if (eligible.length === 0) return { bound, unbound, overflow: false };

  // Pass 1: find the maximal cardinality K over eligible sessions.
  // Pass 2: over all K-cardinality assignments, track the best total cost,
  // its partner vector, and per-session best alternative-partner costs.
  const partner = new Int32Array(sessionCount).fill(-1);
  const taken = new Array<boolean>(candidateCount).fill(false);

  let maxCardinality = 0;
  const countPass = (idx: number, count: number): void => {
    if (idx === eligible.length) {
      if (count > maxCardinality) maxCardinality = count;
      return;
    }
    // Prune: even binding every remaining session can't beat the max.
    if (count + (eligible.length - idx) <= maxCardinality) return;
    const s = eligible[idx];
    for (let c = 0; c < candidateCount; c++) {
      if (taken[c] || matrix[s][c] === null) continue;
      taken[c] = true;
      countPass(idx + 1, count + 1);
      taken[c] = false;
    }
    countPass(idx + 1, count);
  };
  countPass(0, 0);

  const state: EnumerationState = {
    bestCost: Infinity,
    bestPartner: new Int32Array(sessionCount).fill(-1),
    altCost: new Float64Array(sessionCount).fill(Infinity),
  };

  const collectPass = (idx: number, count: number, total: number): void => {
    if (count + (eligible.length - idx) < maxCardinality) return;
    if (idx === eligible.length) {
      if (count !== maxCardinality) return;
      if (total < state.bestCost) {
        // The old best becomes an alternative for every session whose
        // partner differs; recompute lazily via the alt pass below instead.
        state.bestCost = total;
        state.bestPartner.set(partner);
      }
      return;
    }
    const s = eligible[idx];
    for (let c = 0; c < candidateCount; c++) {
      if (taken[c] || matrix[s][c] === null) continue;
      taken[c] = true;
      partner[s] = c;
      collectPass(idx + 1, count + 1, total + matrix[s][c]!);
      partner[s] = -1;
      taken[c] = false;
    }
    collectPass(idx + 1, count, total);
  };
  collectPass(0, 0, 0);

  // Pass 3: per-session best alternative. A second enumeration keeps pass 2
  // simple; group sizes make the extra walk irrelevant.
  const altPass = (idx: number, count: number, total: number): void => {
    if (count + (eligible.length - idx) < maxCardinality) return;
    if (idx === eligible.length) {
      if (count !== maxCardinality) return;
      for (const s of eligible) {
        if (partner[s] !== state.bestPartner[s] && total < state.altCost[s]) {
          state.altCost[s] = total;
        }
      }
      return;
    }
    const s = eligible[idx];
    for (let c = 0; c < candidateCount; c++) {
      if (taken[c] || matrix[s][c] === null) continue;
      taken[c] = true;
      partner[s] = c;
      altPass(idx + 1, count + 1, total + matrix[s][c]!);
      partner[s] = -1;
      taken[c] = false;
    }
    altPass(idx + 1, count, total);
  };
  altPass(0, 0, 0);

  for (const s of eligible) {
    const c = state.bestPartner[s];
    if (c === -1) {
      // Unbound in the optimum, but if an alternative assignment binding
      // this session costs within the jitter band, the tie itself is the
      // ambiguity: label it so, symmetrically with the winner (otherwise
      // WHICH of two exact-tied sessions reads "ambiguous" — and earns a
      // visible unbound row — would depend on enumeration order).
      unbound.set(
        s,
        state.altCost[s] - state.bestCost <= ambiguityMs
          ? "ambiguous"
          : "outcompeted",
      );
      continue;
    }
    if (state.altCost[s] - state.bestCost <= ambiguityMs) {
      unbound.set(s, "ambiguous");
      continue;
    }
    bound.set(s, c);
  }

  return { bound, unbound, overflow: false };
}
