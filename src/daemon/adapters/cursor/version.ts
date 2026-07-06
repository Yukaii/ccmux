import { spawn } from "child_process";

/**
 * Parse a cursor-agent version string into a [year, month, day] tuple.
 * Cursor ships versions like `2026.04.17-787b533` — year.month.day
 * followed by a commit suffix. Anything else (stable future renames,
 * older semver-style versions) returns null so callers fall back to a
 * non-blocking warning rather than a hard error.
 */
export function parseCursorVersion(s: string): [number, number, number] | null {
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * First Cursor release that shipped the hooks feature ccmux depends on.
 * Older cursor-agent silently ignores unknown entries in `hooks.json`
 * (no error, no warning), so ccmux would appear "installed" but produce
 * zero markers. The gate warns loudly when an old cursor is detected.
 */
export const MIN_CURSOR_VERSION: [number, number, number] = [2026, 1, 16];

function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Shell out to `cursor-agent --version` and decide whether it meets the
 * hooks-support minimum. Returns a tri-state: ok/missing/too-old.
 *
 * Async because `cursor-agent --version` takes ~0.5s; a synchronous spawn
 * here stalls the daemon's event loop (and previously its whole boot).
 *
 * - `ok: true` — version parses and is >= MIN_CURSOR_VERSION.
 * - `ok: true, detected: null` — version doesn't parse. Treated as
 *   best-effort pass because a future Cursor rename shouldn't block
 *   install, only warn.
 * - `ok: false, error: "..."` — binary missing or too old.
 */
export async function cursorVersionMeetsHookRequirement(): Promise<{
  ok: boolean;
  detected: string | null;
  error: string | null;
}> {
  let out: { status: number | null; stdout: string };
  try {
    out = await new Promise((resolve, reject) => {
      const child = spawn("cursor-agent", ["--version"], { timeout: 3000 });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      // Drain stderr: an unread pipe that fills would block the child
      // and stall `close` until the timeout.
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout }));
    });
  } catch {
    return {
      ok: false,
      detected: null,
      error: "cursor-agent not on PATH",
    };
  }

  if (out.status !== 0) {
    return {
      ok: false,
      detected: null,
      error: "cursor-agent not on PATH",
    };
  }

  const detected = out.stdout.trim() || null;
  if (!detected) {
    return { ok: true, detected: null, error: null };
  }

  const parsed = parseCursorVersion(detected);
  if (!parsed) {
    return { ok: true, detected, error: null };
  }

  if (compareVersions(parsed, MIN_CURSOR_VERSION) < 0) {
    return {
      ok: false,
      detected,
      error: `cursor-agent ${detected} is older than required ${MIN_CURSOR_VERSION.join(".")}. Hooks were introduced in that release; older versions silently ignore hooks.json entries.`,
    };
  }

  return { ok: true, detected, error: null };
}
