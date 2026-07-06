import { normalizeTty } from "../pane-discovery";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import { findSoftEvictTargets } from "./primitives";
import type {
  Binding,
  ScanObservation,
  SessionSlice,
  ProcessTreeLike,
} from "./types";

/**
 * Working copy of a session slice. The scan ladder's later decisions depend
 * on earlier ones (a pane claimed by P1 evicts same-cwd claimants, changing
 * what P2/P3 see), so the binder simulates the SessionManager's setter
 * semantics on these copies while deciding. The caller then applies the
 * emitted bindings to the real manager in order, replaying the same
 * mutations.
 */
interface WorkingSession {
  id: string;
  agentType: string;
  cwd: string;
  tmuxPane: string | null;
  pid: number | null;
  isBackground: boolean;
}

/**
 * Mirror of `SessionManager.setTmuxPane`'s soft-evict dedupe; the rule
 * itself lives in `findSoftEvictTargets` and is shared with the manager.
 */
function simulateSetTmuxPane(
  sessions: WorkingSession[],
  sessionId: string,
  paneId: string,
): void {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session || session.tmuxPane === paneId) return;

  for (const other of findSoftEvictTargets(sessions, session, paneId)) {
    other.tmuxPane = null;
    other.pid = null;
  }

  session.tmuxPane = paneId;
}

function simulateSetPid(
  sessions: WorkingSession[],
  sessionId: string,
  pid: number,
): void {
  const session = sessions.find((s) => s.id === sessionId);
  if (session) session.pid = pid;
}

/**
 * Heuristic arms of the `assignSessionToPane` ladder (the marker arm runs
 * in its own earlier pass — see `decideScanBindings`):
 *   P2 session already on this pane, missing pid
 *   P3 session whose pid IS this pane's live process, wherever it
 *      currently claims to be
 * Returns the emitted binding, or null when no session matched.
 *
 * P3 deliberately ignores the session's current `tmuxPane` (re-assert
 * every scan): the pane's live process pid is ground truth, so a
 * session holding that pid re-binds here even when it is fully populated
 * with a different (wrong) pane. Before Phase 2 this arm required
 * `tmuxPane === null`, which made a wrong binding with a live pid and a
 * live pane a permanent fixed point.
 */
function decideHeuristicAssignment(
  working: WorkingSession[],
  candidates: WorkingSession[],
  paneId: string,
  processPid: number,
  heuristicProvenance: "tty" | "ancestry",
): Binding | null {
  const existingPaneMatch = candidates.find(
    (s) => s.tmuxPane === paneId && s.pid === null,
  );
  if (existingPaneMatch) {
    simulateSetPid(working, existingPaneMatch.id, processPid);
    return {
      sessionId: existingPaneMatch.id,
      paneId,
      pid: processPid,
      provenance: heuristicProvenance,
      confidence: "probable",
      nativeSessionId: null,
    };
  }

  const pidMatch = candidates.find((s) => s.pid === processPid);
  if (pidMatch) {
    simulateSetTmuxPane(working, pidMatch.id, paneId);
    return {
      sessionId: pidMatch.id,
      paneId,
      pid: processPid,
      provenance: heuristicProvenance,
      confidence: "probable",
      nativeSessionId: null,
    };
  }

  return null;
}

/** Mirror of `getSessionsByCwd(cwd, agentType)` + background exclusion. */
function candidatesFor(
  working: WorkingSession[],
  cwd: string,
  agentType: string,
): WorkingSession[] {
  return working.filter(
    (s) => s.cwd === cwd && s.agentType === agentType && !s.isBackground,
  );
}

function findAgentInTree(
  panePid: number,
  agentProcesses: readonly ProcessInfo[],
  processTree: ProcessTreeLike,
): ProcessInfo | null {
  const agentPids = new Set(agentProcesses.map((p) => p.pid));
  const foundPid = processTree.findAgentDescendant(panePid, agentPids);

  if (foundPid !== null) {
    return agentProcesses.find((p) => p.pid === foundPid) ?? null;
  }
  return null;
}

/** A pane resolved to its live agent process (tty join or ancestry). */
interface PaneProc {
  pane: TmuxPane;
  proc: ProcessInfo;
  provenance: "tty" | "ancestry";
}

/**
 * Ladder 1 (per-scan pane↔process↔session binding), pure decision form of
 * the former `matchSessionsToPanes` body, in two passes:
 *
 * 1. **Marker claims** (authoritative) settle across ALL panes first.
 * 2. **Heuristic arms** (P2 pane-holder, P3 pid) run for the remaining
 *    panes over the post-marker working state.
 *
 * The split enforces the `marker > heuristic` tie-break structurally:
 * in the old single interleaved pass, a session whose STALE
 * pid matched one pane while its marker matched another was emitted twice,
 * and whichever binding applied last — a function of pane iteration order —
 * won, letting a stale tty claim override an authoritative marker claim.
 * With markers settled first, the marker bind updates the working copy's
 * pane/pid, so the stale claim simply no longer matches anything.
 */
export function decideScanBindings(obs: ScanObservation): Binding[] {
  const working: WorkingSession[] = obs.sessions.map((s: SessionSlice) => ({
    ...s,
  }));
  const bindings: Binding[] = [];

  // Pre-index processes by normalized TTY for O(1) lookup
  const processByTty = new Map<string, ProcessInfo>();
  for (const p of obs.processes) {
    const tty = normalizeTty(p.tty);
    if (tty) processByTty.set(tty, p);
  }

  // Resolve each pane's live agent process once.
  const paneProcs: PaneProc[] = [];
  for (const pane of obs.panes) {
    const paneTty = normalizeTty(pane.tty);
    if (!paneTty) continue;

    const agentProcess = processByTty.get(paneTty);
    if (agentProcess?.cwd) {
      paneProcs.push({ pane, proc: agentProcess, provenance: "tty" });
      continue;
    }

    if (!agentProcess && obs.processTree) {
      const treeAgentProcess = findAgentInTree(
        pane.panePid,
        obs.processes,
        obs.processTree,
      );
      if (treeAgentProcess?.cwd) {
        paneProcs.push({
          pane,
          proc: treeAgentProcess,
          provenance: "ancestry",
        });
      }
    }
  }

  // Sessions bound this scan never bind again. The working-model
  // updates make a re-match nearly impossible already; the guard closes the
  // one residual: two panes ancestry-resolved to the SAME agent process
  // (neither tty-matched), where the pid arm would emit the session twice.
  const boundSessionIds = new Set<string>();

  // Pass 1: marker claims (P1, authoritative).
  const markerBoundPanes = new Set<string>();
  for (const { pane, proc } of paneProcs) {
    const candidates = candidatesFor(working, proc.cwd!, proc.agentType).filter(
      (s) => !boundSessionIds.has(s.id),
    );
    const markerMatch = candidates.find(
      (s) => obs.markerPidBySessionId.get(s.id) === proc.pid,
    );
    if (!markerMatch) continue;

    simulateSetTmuxPane(working, markerMatch.id, pane.paneId);
    simulateSetPid(working, markerMatch.id, proc.pid);
    bindings.push({
      sessionId: markerMatch.id,
      paneId: pane.paneId,
      pid: proc.pid,
      provenance: "marker",
      confidence: "authoritative",
      nativeSessionId: null,
    });
    markerBoundPanes.add(pane.paneId);
    boundSessionIds.add(markerMatch.id);
  }

  // Pass 2: heuristic arms for the panes markers didn't claim.
  for (const { pane, proc, provenance } of paneProcs) {
    if (markerBoundPanes.has(pane.paneId)) continue;

    const candidates = candidatesFor(working, proc.cwd!, proc.agentType).filter(
      (s) => !boundSessionIds.has(s.id),
    );
    const binding = decideHeuristicAssignment(
      working,
      candidates,
      pane.paneId,
      proc.pid,
      provenance,
    );
    if (binding) {
      bindings.push(binding);
      boundSessionIds.add(binding.sessionId);
    }
  }

  return bindings;
}
