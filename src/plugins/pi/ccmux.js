// ccmux-extension v__CCMUX_VERSION__
// pi extension shipped by ccmux. Writes marker files into the ccmux
// session-pids dir so the daemon can correlate pi sessions to tmux panes.
// Installed + uninstalled via `ccmux setup --agent pi`.
// Source: github.com/epilande/ccmux
//
// pi auto-discovers both *.ts and *.js extensions and loads them via jiti,
// so this plain-JS file runs unchanged under whichever runtime (node or
// bun) launched pi. Authored as JS (not TS) so it stays out of ccmux's own
// TypeScript compilation, mirroring src/plugins/opencode/plugin.js.

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * @typedef {object} MarkerState
 * @property {"idle"|"working"} [state]
 * @property {string} [directory]
 * @property {string} [transcript_path]
 * @property {string} [last_prompt]
 */

/**
 * @typedef {object} MakeExtensionOptions
 * @property {string} markersDir   Absolute path to ccmux marker directory.
 * @property {string} version      ccmux version string (for the sentinel line).
 * @property {() => number} [now]  Injected clock, ms epoch. Defaults to Date.now.
 */

/**
 * Build a pi extension bound to the given markers dir.
 *
 * pi runs ONE session per process. A session switch (`/new`, `/resume`)
 * emits `session_shutdown` for the old session, reloads extensions, then
 * emits `session_start` for the new one, so markers (keyed by session id)
 * never overlap and need no OpenCode-style aggregation. We still key all
 * bookkeeping by session id so a re-bound instance can't cross-contaminate.
 *
 * @param {MakeExtensionOptions} opts
 */
export function makeExtension({ markersDir, version, now = Date.now }) {
  const AGENT_TYPE = "pi";

  /**
   * Last-written marker state per session, so a `state` flip preserves the
   * `directory`/`transcript_path`/`last_prompt` captured at session_start.
   * @type {Map<string, MarkerState>}
   */
  const sessionState = new Map();
  /**
   * Serialize tmp+rename writes so events firing in the same tick
   * (before_agent_start -> agent_start) can't race on disk.
   * @type {Promise<void>}
   */
  let writeChain = Promise.resolve();

  function markerPath(sessionId) {
    return join(markersDir, `${AGENT_TYPE}-${sessionId}.json`);
  }

  async function atomicWrite(path, body) {
    const tmp = `${path}.tmp.${process.pid}.${now()}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  function buildMarkerBody(sessionId, state) {
    const ts = Math.floor(now() / 1000);
    return JSON.stringify({
      agent_type: AGENT_TYPE,
      pid: process.pid,
      session_id: sessionId,
      timestamp: ts,
      state_timestamp: ts,
      ...state,
    });
  }

  /** Chain a write so concurrent handlers serialize on disk. */
  function queue(updater) {
    const next = writeChain.then(updater).catch((err) => {
      console.error("[ccmux-extension] write failed", err);
    });
    writeChain = next;
    return next;
  }

  /**
   * Merge `patch` into the session's state and flush a fresh marker.
   * @param {string} sessionId
   * @param {MarkerState} patch
   */
  function writeMerged(sessionId, patch) {
    const merged = { ...(sessionState.get(sessionId) ?? {}), ...patch };
    sessionState.set(sessionId, merged);
    return atomicWrite(
      markerPath(sessionId),
      buildMarkerBody(sessionId, merged),
    );
  }

  async function removeMarker(sessionId) {
    sessionState.delete(sessionId);
    try {
      await unlink(markerPath(sessionId));
    } catch (err) {
      // ENOENT is expected when we never wrote a marker for this session.
      if (err && err.code !== "ENOENT") {
        console.error("[ccmux-extension] unlink failed", err);
      }
    }
  }

  /** Resolve the active session id from the read-only session manager. */
  function sessionIdOf(ctx) {
    try {
      const id = ctx?.sessionManager?.getSessionId();
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  function transcriptOf(ctx) {
    try {
      const file = ctx?.sessionManager?.getSessionFile();
      return typeof file === "string" && file ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** @param {any} pi */
  function ccmuxExtension(pi) {
    // session_start fires at launch (reason "startup") with the session id,
    // transcript path, and cwd all already resolved, so the marker carries
    // full identity immediately (unlike Codex, whose marker waits for the
    // first turn).
    pi.on("session_start", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      await mkdir(markersDir, { recursive: true });
      return queue(() =>
        writeMerged(sessionId, {
          state: "idle",
          directory: ctx.cwd,
          transcript_path: transcriptOf(ctx),
        }),
      );
    });

    // Fires after the user submits, before the agent loop. Carries the
    // prompt text, which ccmux surfaces as the session's last prompt.
    pi.on("before_agent_start", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const prompt =
        typeof event?.prompt === "string" ? event.prompt.trim() : "";
      if (!prompt) return;
      return queue(() =>
        writeMerged(sessionId, { last_prompt: prompt.slice(0, 1024) }),
      );
    });

    // agent_start / agent_end bracket one full user prompt (the whole
    // agentic loop, including every internal turn/tool call), so they are
    // the flicker-free working<->idle signal. turn_start/turn_end repeat
    // within a prompt and would bounce the row to idle mid-response.
    pi.on("agent_start", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return queue(() => writeMerged(sessionId, { state: "working" }));
    });

    pi.on("agent_end", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return queue(() => writeMerged(sessionId, { state: "idle" }));
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return queue(() => removeMarker(sessionId));
    });
  }

  // Carry the installed version as metadata (parity with the OpenCode
  // plugin). pi ignores unknown properties on the default-exported factory.
  ccmuxExtension.version = version;
  return ccmuxExtension;
}

const ccmuxExtension = makeExtension({
  markersDir: "__CCMUX_MARKERS_DIR__",
  version: "__CCMUX_VERSION__",
});

export default ccmuxExtension;
