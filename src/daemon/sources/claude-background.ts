import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { watch, type FSWatcher } from "chokidar";
import { DAEMON_ROSTER, JOBS_DIR } from "../../lib/config";
import type { SessionManager } from "../sessions";
import type { BackgroundInFlight } from "../../types/session";
import {
  deriveBackgroundState,
  type RosterJson,
  type RosterWorker,
  type BackgroundStateJson,
} from "./background-state";

/**
 * Field-level guard for `state.json` `inFlight` (untrusted external JSON):
 * keep only the fields with the documented shape, so downstream consumers
 * (the peek render, `backgroundInFlightEqual`) can trust the types. Returns
 * undefined when nothing valid remains.
 */
function sanitizeInFlight(inFlight: unknown): BackgroundInFlight | undefined {
  if (
    inFlight == null ||
    typeof inFlight !== "object" ||
    Array.isArray(inFlight)
  ) {
    return undefined;
  }
  const raw = inFlight as Record<string, unknown>;
  const clean: BackgroundInFlight = {};
  if (typeof raw.tasks === "number") clean.tasks = raw.tasks;
  if (typeof raw.queued === "number") clean.queued = raw.queued;
  if (Array.isArray(raw.kinds)) {
    clean.kinds = raw.kinds.filter((k): k is string => typeof k === "string");
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * I/O seam for {@link ClaudeBackgroundSource}, injectable so the diff logic
 * is unit-testable without chokidar or the filesystem.
 */
export interface BackgroundSourceDeps {
  /** Parse `~/.claude/daemon/roster.json`, or null if missing/unreadable. */
  readRoster: () => RosterJson | null;
  /** Parse `~/.claude/jobs/<short>/state.json`, or undefined if missing. */
  readState: (short: string) => BackgroundStateJson | undefined;
  now?: () => number;
}

/**
 * Daemon source for Claude Code background/background agents (`claude --bg`
 * / the agent view). These are paneless: a PID, cwd, and JSONL transcript but
 * no tmux pane, so ccmux's pane/process scan never sees them. This source is
 * their SOLE owner: it watches Claude's own `roster.json` (membership) and
 * each `jobs/<short>/state.json` (status), diffs into the `SessionManager`,
 * and is the only thing creating/removing `trackingMode:"background"` rows.
 *
 * Architecture = file hybrid (roster + state.json).
 * Roster membership is the authoritative live set (and the SOLE death
 * signal: a short dropping out of `workers` removes the session); the
 * `state.json` watcher exists because roster mtime does NOT bump on the
 * active->blocked transition, so a roster-only watch would miss "needs input".
 */
export class ClaudeBackgroundSource {
  private rosterWatcher: FSWatcher | null = null;
  private jobsWatcher: FSWatcher | null = null;
  /** Authoritative live membership (`roster.workers`), kept current by every
   * `syncFromRoster`. `handleStateChange` consults it to drop `state.json`
   * events for shorts not currently in the roster (the `jobs/` dir is a
   * historical superset with dead dirs). */
  private currentMembers = new Map<string, RosterWorker>();
  private warnedProto = false;

  constructor(
    private manager: SessionManager,
    private deps: BackgroundSourceDeps = defaultBackgroundSourceDeps(),
  ) {}

  /**
   * Run an initial reconcile, then open both chokidar watchers. The initial
   * `syncFromRoster()` (mirroring `HookManager.start`'s replay) means
   * background sessions exist before live events begin, so the watchers run
   * with `ignoreInitial: true` rather than reprocessing the startup scan.
   */
  async start(): Promise<void> {
    this.syncFromRoster();

    // Watch the PARENT dirs and filter by basename: chokidar single-file
    // watches on a not-yet-existent path are unreliable, and watching the
    // dirs is symmetric across both watchers.
    this.rosterWatcher = watch(dirname(DAEMON_ROSTER), {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      atomic: true,
    });
    for (const evt of ["add", "change", "unlink"] as const) {
      this.rosterWatcher.on(evt, (path) => this.onRosterEvent(path));
    }
    this.rosterWatcher.on("error", (error) =>
      console.error("ClaudeBackgroundSource roster watcher error:", error),
    );

    this.jobsWatcher = watch(JOBS_DIR, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      atomic: true,
    });
    // `state.json` unlink is intentionally ignored: a short dropping from
    // `roster.workers` (caught by the roster watcher) is the death signal.
    for (const evt of ["add", "change"] as const) {
      this.jobsWatcher.on(evt, (path) => this.onJobsEvent(path));
    }
    this.jobsWatcher.on("error", (error) =>
      console.error("ClaudeBackgroundSource jobs watcher error:", error),
    );

    await Promise.all([
      waitForReady(this.rosterWatcher),
      waitForReady(this.jobsWatcher),
    ]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.rosterWatcher?.close(), this.jobsWatcher?.close()]);
    this.rosterWatcher = null;
    this.jobsWatcher = null;
    this.currentMembers.clear();
  }

  /**
   * Full reconcile against `roster.json`. Public so tests can drive a roster
   * change without chokidar. Gates on `proto === 1` (degrades to zero
   * background rows otherwise), refreshes membership, upserts every member,
   * and removes any background session no longer in the roster.
   */
  syncFromRoster(): void {
    const roster = this.deps.readRoster();
    const protoOk = roster?.proto === 1;
    if (roster && !protoOk && !this.warnedProto) {
      this.warnedProto = true;
      console.warn(
        `ccmux: ${DAEMON_ROSTER} proto=${String(roster.proto)} (expected 1); ` +
          "background agents disabled until the schema matches.",
      );
    }

    const workers = protoOk ? (roster?.workers ?? {}) : {};
    // Tolerate a malformed roster entry (null / non-object worker): guarding
    // the shape keeps a stray null from throwing out of a chokidar callback
    // and wedging the daemon.
    this.currentMembers = new Map(
      Object.entries(workers).filter(
        ([, worker]) => worker != null && typeof worker === "object",
      ),
    );

    for (const [short, worker] of this.currentMembers) {
      this.upsert(short, worker);
    }

    // Roster membership is the SOLE death signal for background sessions
    // (cleanupStaleSessions excludes them, so nothing else reaps them).
    for (const session of this.manager.getSessions()) {
      if (
        session.trackingMode === "background" &&
        !this.currentMembers.has(session.id)
      ) {
        this.manager.removeSession(session.id);
      }
    }
  }

  /**
   * Re-derive a single background session from its `state.json`. Public for
   * tests. Ignores events for shorts not in the current roster membership.
   */
  handleStateChange(short: string): void {
    const worker = this.currentMembers.get(short);
    if (!worker) return;
    this.upsert(short, worker);
  }

  private onRosterEvent(path: string): void {
    if (path !== DAEMON_ROSTER) return;
    this.syncFromRoster();
  }

  private onJobsEvent(path: string): void {
    if (basename(path) !== "state.json") return;
    this.handleStateChange(basename(dirname(path)));
  }

  private upsert(short: string, worker: RosterWorker): void {
    const state = this.deps.readState(short);
    const now = this.deps.now?.() ?? Date.now();
    const derived = deriveBackgroundState(worker, state, now);

    const cwd = state?.cwd ?? worker.cwd ?? "";
    // Guard the TYPE, not just falsiness: a truthy non-string `cwd` (schema
    // drift / corrupt file) would throw from `.split("/")` in
    // `createBackgroundSession`, out of this synchronous watcher callback —
    // the same daemon-wedge the `children` guard below prevents.
    if (typeof cwd !== "string" || !cwd) return; // corrects on next write

    // If state.json is transiently unreadable for an EXISTING row, keep its
    // last-known-good values instead of clobbering status/logPath/children
    // with worker-only fallbacks. A new row still creates from worker fields
    // (the pre-first-turn case); the next event re-derives from the file.
    if (state === undefined && this.manager.hasSession(short)) return;

    const nativeSessionId = state?.resumeSessionId ?? worker.sessionId;
    const logPath = state?.linkScanPath ?? null;
    const version = state?.cliVersion ?? worker.cliVersion ?? null;
    const lastPrompt = state?.intent ?? worker.dispatch?.seed?.intent ?? null;
    const lastActivityAt = state?.updatedAt ?? null;
    const backgroundResult = state?.output?.result ?? undefined;
    // Drop null/non-object child entries, and guard the container type:
    // a non-array `children` (undocumented schema) makes `.filter` throw
    // out of the watcher callback, aborting daemon start().
    const backgroundChildren = Array.isArray(state?.children)
      ? state.children.filter((c) => c != null && typeof c === "object")
      : undefined;
    // Guard the type like `children` above, fields included: a non-object
    // `inFlight` (or a non-array `kinds` inside it) from another process's
    // JSON must not reach the peek's field reads or the SessionManager's
    // structural equality (`kinds.every` would throw out of the watcher
    // callback).
    const backgroundInFlight = sanitizeInFlight(state?.inFlight);
    const pid = worker.pid ?? null;

    if (this.manager.hasSession(short)) {
      this.manager.updateSession(short, {
        status: derived.status,
        attentionType: derived.attentionType,
        pendingTool: derived.pendingTool,
        backgroundDetail: derived.backgroundDetail,
        backgroundResult,
        backgroundChildren: backgroundChildren ?? [],
        backgroundInFlight: backgroundInFlight ?? {},
        version: version ?? undefined,
        cwd,
        lastPrompt,
        lastActivityAt: lastActivityAt ?? undefined,
      });
      if (nativeSessionId) {
        this.manager.setNativeSessionId(short, nativeSessionId);
      }
      this.manager.setLogPath(short, logPath);
      this.manager.setPid(short, pid);
    } else {
      this.manager.createBackgroundSession({
        daemonShort: short,
        pid,
        cwd,
        nativeSessionId,
        logPath,
        version,
        status: derived.status,
        attentionType: derived.attentionType,
        pendingTool: derived.pendingTool,
        backgroundDetail: derived.backgroundDetail,
        backgroundResult,
        backgroundChildren,
        backgroundInFlight,
        lastPrompt,
        lastActivityAt,
      });
    }
  }
}

/** Disk-backed readers for the production daemon. */
export function defaultBackgroundSourceDeps(): BackgroundSourceDeps {
  return {
    readRoster: () => readJsonFile<RosterJson>(DAEMON_ROSTER),
    readState: (short) =>
      readJsonFile<BackgroundStateJson>(join(JOBS_DIR, short, "state.json")) ??
      undefined,
  };
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function waitForReady(watcher: FSWatcher): Promise<void> {
  return new Promise((resolve) => watcher.once("ready", () => resolve()));
}
