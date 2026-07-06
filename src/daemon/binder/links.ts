import {
  codexRolloutPairCost,
  type CodexRolloutCandidate,
} from "../adapters/codex/link";
import { assignGroup } from "./assign";
import type { MarkerLinkSessionSlice, MarkerSlice } from "./types";

/** A pane-tracked codex session eligible for heuristic rollout linking. */
export interface CodexLinkCandidate {
  sessionId: string;
  cwd: string;
  startTime: number;
}

/**
 * Skew for the marker pid-recycling tripwire: a marker may claim a process
 * that started at most this much after the marker was written (absorbs the
 * 1s resolution of `ps etime`-derived start times plus clock skew).
 */
const MARKER_PID_RECYCLE_SKEW_MS = 2_000;

/**
 * Ladder 5a (codex rollout links), group-wise. All candidate
 * sessions and in-window rollouts are solved as one assignment: eligibility
 * and cost come from `codexRolloutPairCost` (cwd equality + the forward
 * window), so cross-cwd pairs never bind and the former greedy
 * claim-in-candidate-order loop — where an early candidate could take a
 * later candidate's rollout for good — dissolves. Ambiguous or no-signal
 * sessions get no link: unlinked is the acceptable, self-correcting state
 * (the marker pass enriches authoritatively in hooks mode).
 *
 * Rollouts are pre-filtered to those eligible for at least one candidate,
 * keeping the assignment group at concurrent-session scale rather than
 * `scanCodexRollouts`' 200-file history scale.
 */
export function decideCodexRolloutLinks(
  candidates: readonly CodexLinkCandidate[],
  rollouts: readonly CodexRolloutCandidate[],
): { sessionId: string; rollout: CodexRolloutCandidate }[] {
  if (candidates.length === 0) return [];

  const eligibleRollouts = rollouts.filter((r) =>
    candidates.some((c) => codexRolloutPairCost(c, r) !== null),
  );
  if (eligibleRollouts.length === 0) return [];

  const result = assignGroup(
    candidates.length,
    eligibleRollouts.length,
    (s, c) => codexRolloutPairCost(candidates[s], eligibleRollouts[c]),
  );

  const links: { sessionId: string; rollout: CodexRolloutCandidate }[] = [];
  for (const [s, c] of result.bound) {
    links.push({
      sessionId: candidates[s].sessionId,
      rollout: eligibleRollouts[c],
    });
  }
  return links;
}

/** Freshness key for picking a pane's representative marker. */
function markerFreshness(marker: MarkerSlice): number {
  return marker.state_timestamp ?? marker.timestamp ?? 0;
}

/**
 * Pid-recycling tripwire: a marker created BEFORE its
 * claimed process started cannot belong to that process — the OS recycled
 * the pid onto an unrelated newcomer. Fires only on positive evidence:
 * a marker without a creation timestamp, a pid absent from the map, or a
 * null start time all pass (fail-open), so agents whose markers omit
 * `timestamp` and boots with partial process info keep linking.
 */
function isRecycledPid(
  marker: MarkerSlice,
  processStartTimeByPid?: ReadonlyMap<number, number | null>,
): boolean {
  if (marker.timestamp == null) return false;
  const procStart = processStartTimeByPid?.get(marker.pid);
  if (procStart == null) return false;
  return marker.timestamp * 1000 + MARKER_PID_RECYCLE_SKEW_MS < procStart;
}

/**
 * Ladder 5b (marker → pane session), the per-scan native-id ownership
 * re-derivation. For each pane-bound session, look at the
 * live markers hosted by ITS OWN pane:
 *
 * - The session already holds one of those marker ids → verified owner,
 *   no link emitted (steady state stays cheap; a pane hosting several
 *   sequential markers — e.g. cursor chats — keeps the id the event path
 *   chose rather than flapping between them).
 * - Otherwise (unlinked, or holding an id that none of its pane's markers
 *   carry — a heuristic mis-link) → emit the pane's freshest marker so the
 *   caller re-dispatches `onMarkerAdded`, whose reclaim re-routes the id.
 *
 * Markers tripped by the pid-recycling check are excluded up front: they
 * neither anchor a "verified owner" nor win freshest-marker.
 *
 * Pre-Phase-2 this pass only considered sessions with NO native id
 * (first marker per pane, first-wins), so a wrongly-held id was never
 * re-examined and the authoritative marker path stayed blocked forever.
 */
export function decideMarkerLinks<M extends MarkerSlice>(
  sessions: readonly MarkerLinkSessionSlice[],
  markers: readonly M[],
  paneIdByPid: ReadonlyMap<number, string | null>,
  processStartTimeByPid?: ReadonlyMap<number, number | null>,
): { sessionId: string; marker: M }[] {
  const markersByPane = new Map<string, M[]>();
  for (const marker of markers) {
    if (isRecycledPid(marker, processStartTimeByPid)) continue;
    const paneId = paneIdByPid.get(marker.pid);
    if (!paneId) continue;
    const bucket = markersByPane.get(paneId);
    if (bucket) {
      bucket.push(marker);
    } else {
      markersByPane.set(paneId, [marker]);
    }
  }

  const links: { sessionId: string; marker: M }[] = [];
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const paneMarkers = markersByPane.get(session.tmuxPane);
    if (!paneMarkers || paneMarkers.length === 0) continue;
    if (
      session.nativeSessionId !== null &&
      paneMarkers.some((m) => m.session_id === session.nativeSessionId)
    ) {
      continue;
    }
    const freshest = paneMarkers.reduce((a, b) =>
      markerFreshness(b) > markerFreshness(a) ? b : a,
    );
    links.push({ sessionId: session.sessionId, marker: freshest });
  }

  return links;
}
