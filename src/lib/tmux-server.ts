/**
 * Pure helpers for the single-server invariant.
 *
 * tmux pane ids (`%N`) are unique only within one server and collide across
 * servers (each numbers from `%0`). The daemon scans one server and exposes its
 * `#{socket_path}` via `GET /server-info`; consumers compare their own server
 * before targeting a pane, refusing a cross-server `%N` rather than switching or
 * sending keys to the wrong pane.
 *
 * Dependency-free so both the TUI and the CLI can import it.
 */

/**
 * This client's tmux socket, from the first field of `$TMUX`
 * (`<socket_path>,<pid>,<session>`), or null when not inside tmux.
 */
export function currentTmuxSocket(): string | null {
  return process.env.TMUX?.split(",")[0] ?? null;
}

/**
 * True unless we can prove the target pane is on a different server than the
 * daemon that produced its `%N`. Fail-open when either socket is unknown: the
 * guard is a safety net against a second-server collision, not a gate that
 * blocks use when the socket is simply unavailable.
 */
export function isSameTmuxServer(daemonSocket: string | null): boolean {
  const mine = currentTmuxSocket();
  if (!mine || !daemonSocket) return true;
  return mine === daemonSocket;
}
