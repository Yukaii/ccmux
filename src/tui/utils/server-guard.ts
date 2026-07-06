/**
 * Cached same-server check shared by every TUI consumer of a daemon-supplied
 * pane `%N` (see lib/tmux-server.ts for the invariant).
 *
 * PR #100 guarded the mutating consumers (switch, preview-focus send-keys)
 * through App's closure; the read-only consumers (preview capture, search
 * pane cache, sidebar flash) poll on hot loops, so they read a boolean cached
 * here instead of re-deriving the comparison per tick (issue #113). The
 * comparison is socket-level, not pane-level: every `%N` comes from the one
 * daemon, so a single cached verdict covers all sessions.
 *
 * App owns the write side: `setDaemonSocketPath` on every `/server-info`
 * (re)fetch, i.e. on each SSE (re)connect, which also covers a daemon
 * restarted onto a different socket. Fail-open until it resolves, matching
 * `isSameTmuxServer`: the guard refuses a proven cross-server collision, it
 * never blocks on a merely unknown socket.
 */
import { isSameTmuxServer } from "../../lib/tmux-server";

let sameServer = true;

/** Record the daemon's tmux socket and cache the verdict against our own. */
export function setDaemonSocketPath(socketPath: string | null): void {
  sameServer = isSameTmuxServer(socketPath);
}

/** Cached verdict of the last `setDaemonSocketPath`; true (fail-open) before
 *  the first one. Cheap enough for every poll tick. */
export function isSameServerCached(): boolean {
  return sameServer;
}
