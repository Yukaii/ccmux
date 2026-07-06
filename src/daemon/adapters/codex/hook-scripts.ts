/**
 * Bash templates for the three Codex hook scripts installed by
 * `CodexHookAdapter.install()`. Kept as pure string-returning functions so
 * tests can snapshot and shell-exec them without touching the filesystem
 * layout of the adapter.
 *
 * Contract — read before touching these scripts:
 *
 * - **Every failure path `exit 0` with empty stdout.** Codex interprets
 *   `exit 2` + stderr content on `PermissionRequest` as a Deny decision,
 *   which would silently block the user's tool approvals. We apply the
 *   same posture to `SessionStart` and `Stop` for consistency and so a
 *   misbehaving hook can never interfere with the user's workflow.
 *
 * - **No `set -e`.** A failing jq or ps in the middle of the script must
 *   not abort the whole handler — the defensive `|| exit 0` gates exist
 *   to swallow those failures and keep Codex's own flow unblocked.
 *
 * - **Payload fields are snake_case.** The upstream Rust structs in
 *   `codex-rs/hooks/src/schema.rs` don't apply `rename_all = "camelCase"`
 *   to the *input* structs (only outputs), so stdin uses `.session_id`,
 *   `.transcript_path`, `.tool_name`, `.tool_input.command`.
 */

/** SessionStart: writes the PID marker. */
export function renderSessionStartScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Codex SessionStart hook. Writes PID marker so the daemon can bind
# this pane to the real Codex session id and transcript path.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"
mkdir -p "$MARKERS_DIR" 2>/dev/null || exit 0

INPUT=$(cat)
# One jq spawn extracts every payload field we care about, shell-quoted via
# @sh so eval is injection-safe even on hostile values.
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "SESSION_ID=\\(.session_id // "")",
  @sh "TRANSCRIPT_PATH=\\(.transcript_path // "")"
' 2>/dev/null)"
[ -n "$SESSION_ID" ] || exit 0

CODEX_TTY=$(ps -p $PPID -o tty= 2>/dev/null | tr -d ' ')

MARKER_FILE="$MARKERS_DIR/codex-$SESSION_ID.json"
jq -nc \\
  --arg pid "$PPID" \\
  --arg tty "\${CODEX_TTY:-unknown}" \\
  --arg session_id "$SESSION_ID" \\
  --arg transcript_path "$TRANSCRIPT_PATH" \\
  '{agent_type: "codex", pid: ($pid|tonumber), tty: $tty, session_id: $session_id, transcript_path: (if $transcript_path == "" then null else $transcript_path end), state: "idle", state_timestamp: now, timestamp: now}' \\
  > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}

/** Stop: fires at the end of every Codex turn. Refreshes marker state to idle. */
export function renderStopScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Codex Stop hook. Codex has no permission-prompt hook in older
# versions, so Stop is the authoritative "turn complete / back to idle"
# signal. Safe no-op when the marker doesn't exist yet.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$SESSION_ID" ] || exit 0

MARKER_FILE="$MARKERS_DIR/codex-$SESSION_ID.json"
[ -f "$MARKER_FILE" ] || exit 0

jq '. + {state: "idle", state_timestamp: now, pending_tool: null, permission_context: null}' \\
  "$MARKER_FILE" > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}

/**
 * PermissionRequest: fires when Codex is about to ask the user to approve
 * a tool call. Marks the session as waiting_permission so the sidebar can
 * render an attention indicator.
 *
 * CRITICAL: Codex treats `exit 2` + stderr from this hook as a Deny
 * decision. A crashing hook would silently block the user from approving
 * tools. Every branch must exit 0 with empty stdout.
 */
export function renderPermissionRequestScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Codex PermissionRequest hook. Flags the session as waiting for
# user approval so the sidebar shows an attention indicator.
# Contract: exit 0 on every path, never write to stdout/stderr. An
# exit 2 with stderr is interpreted by Codex as Deny.
MARKERS_DIR="${markersDir}"

INPUT=$(cat)
# One jq spawn extracts every payload field, shell-quoted via @sh so eval
# is injection-safe. Keeps us well under Codex's 1s hook budget on the
# user-approval path.
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "SESSION_ID=\\(.session_id // "")",
  @sh "TOOL_NAME=\\(.tool_name // "")",
  @sh "COMMAND=\\(.tool_input.command // "")"
' 2>/dev/null)"
[ -n "$SESSION_ID" ] || exit 0

MARKER_FILE="$MARKERS_DIR/codex-$SESSION_ID.json"
[ -f "$MARKER_FILE" ] || exit 0

jq --arg tool "$TOOL_NAME" --arg ctx "$COMMAND" \\
  '. + {state: "waiting_permission", state_timestamp: now, pending_tool: (if $tool == "" then null else $tool end), permission_context: (if $ctx == "" then null else $ctx end)}' \\
  "$MARKER_FILE" > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}
