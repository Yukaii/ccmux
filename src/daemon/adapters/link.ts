import type { HookAdapter, HookManagerContext } from "../hook-adapter";
import { filterMarkerCache } from "../session-markers";
import { decideMarkerLinks } from "../binder";

/**
 * Per-scan native-id ownership re-derivation for marker-backed agents.
 * Two jobs in one pass:
 *
 * 1. Closes the daemon-startup race: if a hook or plugin writes a marker
 *    before the first process scan creates the pane-tracked ccmux Session,
 *    the initial `onMarkerAdded` finds no session and no-ops. Re-dispatching
 *    here links it on the next scan.
 * 2. Heals mis-links: a session whose `nativeSessionId` matches none of the
 *    markers live on its own pane is holding a foreign (heuristically
 *    grabbed) id. Re-dispatching its pane's freshest marker routes through
 *    `setNativeSessionId(..., { reclaim: true })` in the adapter, which
 *    strips the wrong holder and re-links this session. Pre-Phase-2 only
 *    sessions with NO native id were reconsidered, so a wrong claim could
 *    never self-heal.
 *
 * Sessions already holding one of their pane's marker ids are skipped, so
 * steady state dispatches nothing.
 *
 * Agent-agnostic: dispatch keys off `adapter.agentType`, and any
 * per-server aggregation happens downstream in the adapter's
 * `onMarkerAdded` (OpenCode folds N markers-per-server into one session;
 * Cursor and Pi have one marker per session, so there is nothing to fold).
 */
export async function reconcileSessionMarkerLinks(
  adapter: HookAdapter,
  ctx: HookManagerContext,
  /**
   * Live process start times (ms) for the pid-recycling tripwire: a marker
   * created before its claimed pid's process started is skipped (the pid
   * was recycled). Optional and fail-open — see `decideMarkerLinks`.
   */
  processStartTimeByPid?: ReadonlyMap<number, number | null>,
): Promise<void> {
  if (!adapter.onMarkerAdded) return;

  const sessions = ctx.sessionManager
    .getSessions()
    .filter(
      (s) => s.agentType === adapter.agentType && s.trackingMode === "pane",
    );
  if (sessions.length === 0) return;

  const markers = filterMarkerCache((m) => m.agent_type === adapter.agentType);
  if (markers.length === 0) return;

  // Observation gathering (pid → hosting pane) is the I/O half; the
  // pairing decision itself is the binder's `decideMarkerLinks`.
  const pids = [...new Set(markers.map((m) => m.pid))];
  const panesForPids = await Promise.all(
    pids.map((pid) => ctx.getPaneHostingPid(pid)),
  );
  const paneByPid = new Map<number, string | null>();
  pids.forEach((pid, i) => paneByPid.set(pid, panesForPids[i]?.paneId ?? null));

  const links = decideMarkerLinks(
    sessions.map((s) => ({
      sessionId: s.id,
      tmuxPane: s.tmuxPane,
      nativeSessionId: s.nativeSessionId ?? null,
    })),
    markers,
    paneByPid,
    processStartTimeByPid,
  );
  for (const { marker } of links) {
    await adapter.onMarkerAdded(marker, ctx);
  }
}
