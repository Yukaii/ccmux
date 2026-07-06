import { BACKGROUND_FRESH_THRESHOLD_MS } from "../../lib/config";
import type {
  AttentionType,
  SessionStatus,
  BackgroundChild,
  BackgroundInFlight,
} from "../../types/session";

/**
 * A `roster.workers[short]` entry from `~/.claude/daemon/roster.json`.
 * Every field is optional: the schema is undocumented (research preview), so
 * we tolerate any field going missing and surface what we find.
 */
export interface RosterWorker {
  pid?: number;
  sessionId?: string;
  cliVersion?: string;
  /** ms unix epoch */
  startedAt?: number;
  cwd?: string;
  attempt?: number;
  dispatch?: {
    source?: string;
    isolation?: string;
    seed?: { intent?: string };
  };
}

/** The top-level `roster.json` shape. */
export interface RosterJson {
  proto?: number;
  supervisorPid?: number;
  updatedAt?: number;
  workers?: Record<string, RosterWorker>;
}

/**
 * A `~/.claude/jobs/<short>/state.json` document. Like {@link RosterWorker},
 * every field is optional by design.
 */
export interface BackgroundStateJson {
  /** lifecycle: working | done | stopped | failed | blocked — the LAST
   * COMPLETED turn's outcome, NOT the live axis (that is `tempo`). */
  state?: string;
  /** live axis: active | idle | blocked */
  tempo?: string;
  detail?: string;
  name?: string;
  intent?: string;
  /** pre-rendered "what's blocking" line, present when `tempo:blocked` */
  needs?: string;
  /** structured multiple-choice block, present when `tempo:blocked` */
  block?: { questions?: unknown[] } | null;
  output?: { result?: string } | null;
  children?: BackgroundChild[] | null;
  /** abs path to the JSONL transcript; null until the first turn completes */
  linkScanPath?: string | null;
  /** the live transcript key; equals `basename(linkScanPath)` */
  resumeSessionId?: string;
  sessionId?: string;
  daemonShort?: string;
  cliVersion?: string;
  cwd?: string;
  originCwd?: string;
  /** ISO timestamps */
  createdAt?: string;
  updatedAt?: string;
  firstTerminalAt?: string | null;
  inFlight?: BackgroundInFlight;
}

/** The status fields {@link deriveBackgroundState} resolves. */
export interface DerivedBackgroundState {
  status: SessionStatus;
  attentionType: AttentionType;
  pendingTool: string | null;
  backgroundDetail?: string;
}

/**
 * Pure fold from a background worker's `(roster, state.json)` to ccmux
 * status. No I/O, so it is unit-testable without chokidar.
 *
 * Status axis is `tempo`, NOT `state` (corrected after Step 0). `state.json`
 * is written only at turn boundaries, so `state` holds the last-completed-turn outcome
 * while `tempo` is the live working/waiting signal. `(state:blocked,
 * tempo:active)` therefore means "actively working, previous turn ended
 * blocked" — it is `working`, not `waiting`.
 *
 * Derivation order:
 *   1. `tempo === 'blocked'` → `waiting` (subtype from `block.questions[]` /
 *      `needs`). Catches BOTH documented waiting cases (question + sandbox
 *      gate), which both carry `tempo:blocked`.
 *   2. else `state ∈ {done, stopped, failed}` AND `tempo !== 'active'` →
 *      `idle`. The tempo guard keeps a re-prompted finished worker
 *      (`state:done, tempo:active`) rendering `working`, not idle — `tempo`
 *      is the live axis on this branch too, mirroring step 1.
 *   3. else → `working`, with the frozen-working staleness guard.
 */
export function deriveBackgroundState(
  worker: RosterWorker | undefined,
  state: BackgroundStateJson | undefined,
  now: number,
): DerivedBackgroundState {
  const backgroundDetail = state?.detail ?? state?.name ?? undefined;

  // 1. Live waiting signal.
  if (state?.tempo === "blocked") {
    // `questions` comes from another process's JSON; a non-array value would
    // expose a numeric `.length` and misclassify as a question. Gate the type.
    const questions = state.block?.questions;
    const hasQuestions = Array.isArray(questions) && questions.length > 0;
    const attentionType: AttentionType = hasQuestions
      ? "question"
      : state.needs
        ? "permission"
        : null;
    return {
      status: "waiting",
      attentionType,
      pendingTool: null,
      backgroundDetail,
    };
  }

  // 2. Terminal lifecycle. Finished rows linger as idle until `claude rm`
  //    drops them from the roster. Gate on `tempo` for the same reason step 1
  //    does: `state.json` is written at turn boundaries, so `state` holds the
  //    LAST-completed-turn outcome while `tempo` is the live axis. A finished
  //    worker re-prompted in the agent view reads `(state:done, tempo:active)`
  //    until the new turn's boundary write — that is working, not idle. Keeping
  //    `tempo` authoritative on BOTH branches makes the fold uniform with its
  //    own contract (mirrors the proven `(blocked, active)` → working case).
  const lifecycle = state?.state;
  if (
    state?.tempo !== "active" &&
    (lifecycle === "done" || lifecycle === "stopped" || lifecycle === "failed")
  ) {
    return {
      status: "idle",
      attentionType: null,
      pendingTool: null,
      backgroundDetail,
    };
  }

  // 3. Otherwise working — but a worker frozen at working/active that never
  //    completed a turn (no firstTerminalAt, no linkScanPath) past the
  //    freshness window renders idle. This is gated AFTER the blocked check
  //    so a first-turn block (also linkScanPath-less) still shows waiting.
  const firstTerminalAt = state?.firstTerminalAt ?? null;
  const linkScanPath = state?.linkScanPath ?? null;
  if (firstTerminalAt === null && !linkScanPath) {
    const createdAtMs = resolveCreatedAtMs(state, worker);
    if (
      createdAtMs !== null &&
      now - createdAtMs > BACKGROUND_FRESH_THRESHOLD_MS
    ) {
      return {
        status: "idle",
        attentionType: null,
        pendingTool: null,
        backgroundDetail,
      };
    }
  }

  return {
    status: "working",
    attentionType: null,
    pendingTool: null,
    backgroundDetail,
  };
}

/**
 * Best-effort creation time in ms for the staleness guard. Prefers
 * `state.createdAt` (ISO), falls back to `roster.startedAt` (ms epoch),
 * returns null when neither is parseable (the guard then no-ops → working).
 */
function resolveCreatedAtMs(
  state: BackgroundStateJson | undefined,
  worker: RosterWorker | undefined,
): number | null {
  if (state?.createdAt) {
    const parsed = Date.parse(state.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof worker?.startedAt === "number") return worker.startedAt;
  return null;
}
