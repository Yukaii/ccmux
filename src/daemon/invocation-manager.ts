import { EventEmitter } from "events";
import { fail, noInvokeModeMessage } from "./invokers/helpers";
import type { Invoker } from "./invokers/invoker";
import type { InvocationRegistry } from "./invokers/registry";
import type { InvokeInput, InvokeResult } from "./invokers/types";
import type { InvokeErrorKind, InvocationStatus } from "../types";
import type { AgentDef } from "../lib/agents";
import type { SessionManager } from "./sessions";

/**
 * `ccmux invoke` runs through this manager. After the 2.4 dispatch flip,
 * the manager owns coordination (concurrency cap, in-flight tracking,
 * cancel-before-start stash, per-invocation timeout) and delegates the
 * actual work to the `Invoker` the `InvocationRegistry` resolves for the
 * agent. The two invokers are `ClaudeInvoker` (interactive tmux + JSONL)
 * and `SubprocessInvoker` (`Bun.spawn` + stdout/tmpfile/JSONL stdout).
 *
 * It also keeps a status-only sibling store of active + recently-finished
 * invocations (`InvocationRecord`), separate from the `invocations`
 * AbortController map (which is deleted in `finally`, so it cannot hold
 * finished records). `GET /invocations` reads this store and `ccmux
 * invoke list` renders it. The store NEVER holds result text; full output
 * lives in an ephemeral `/tmp` file the subprocess invoker writes at
 * finish (see `subprocess-invoker.ts`).
 *
 * As an `EventEmitter` the manager fires a single `"change"` event
 * carrying a discriminated `InvocationEvent` at admission (`started`) and
 * finish (`finished`), mirroring `SessionManager`'s `"change"` contract.
 * `DaemonServer` subscribes to it and broadcasts each event as an SSE
 * `invocation_started` / `invocation_finished` message.
 */

const PRE_START_CANCEL_TTL_MS = 60_000;
const PRE_START_CANCEL_SWEEP_MS = 30_000;

/**
 * How long a finished `InvocationRecord` lingers in the store before the
 * sweep reaps it. Long enough that a fire-and-poll caller can observe the
 * terminal state via `ccmux invoke list` after the invoke returns, short
 * enough that the store stays bounded. Reuses the same purge-on-access +
 * `.unref()` sweep-timer idiom as the cancel-before-start stash.
 */
const FINISHED_RECORD_TTL_MS = 5 * 60_000;
const FINISHED_RECORD_SWEEP_MS = 60_000;

/**
 * Ceiling on simultaneously-active invocations. Each invocation either
 * holds a tmux session (Claude) or a piped subprocess with unbounded
 * stdout/stderr buffering, so an unbounded `invoke()` rate from a
 * misbehaving local caller is a daemon-OOM and account-quota vector.
 * Chosen well above realistic concurrent CLI usage; raise if a tool
 * legitimately fans out further.
 */
const MAX_CONCURRENT_INVOCATIONS = 16;

/**
 * Re-exported for the daemon-side consumers (`InvocationRecord`, `ccmux
 * invoke list`); canonical definition in `src/types/invocation.ts`. The
 * cancelled-vs-failed semantics live at the `finish()` enforcement site.
 */
export type { InvocationStatus };

/**
 * Status-only record of an active or recently-finished invocation. Held
 * in the sibling store and surfaced over `GET /invocations`. Deliberately
 * carries NO result text: full output lives in an ephemeral `/tmp` file
 * (see `subprocess-invoker.ts`); this store is the lightweight status
 * index `ccmux invoke list` and the board read.
 */
export interface InvocationRecord {
  invocationId: string;
  /** Agent NAME (e.g. "claude", "codex"), not the full `AgentDef`. */
  agent: string;
  cwd: string;
  /** `Date.now()` stamped at admission. Source for the live age and, on
   * the failure path, the only source for `durationMs` (success-only on
   * `InvokeResult`). */
  startedAt: number;
  status: InvocationStatus;
  /** Set at finish. From `InvokeSuccess.durationMs` on success, else
   * computed from `startedAt`. */
  durationMs?: number;
  /** Native session id when extractable (Claude tmux + OpenCode). */
  sessionId?: string;
  /** tmux pane the invoke landed in (Claude tmux path). Back-filled by
   * the server on Claude session promotion via `linkSession`. */
  paneId?: string;
  /** Failure kind, set at finish for `failed` records. */
  kind?: InvokeErrorKind;
}

/**
 * Discriminated payload of the manager's single `"change"` event,
 * mirroring `SessionManager`'s `"change"` contract. `started` fires at
 * admission, `finished` at terminal transition.
 */
export interface InvocationEvent {
  type: "started" | "finished";
  record: InvocationRecord;
}

export class InvocationManager extends EventEmitter {
  private invocations: Map<string, AbortController> = new Map();
  /**
   * Status-only sibling store of active + recently-finished invocations,
   * separate from `invocations` (which is deleted in `finally`). Read by
   * `GET /invocations`. Finished entries are TTL-purged.
   */
  private records: Map<string, InvocationRecord> = new Map();
  /**
   * Invocations whose `cancel()` arrived before `invoke()` ran. Each entry
   * is the timestamp the cancel landed; `invoke()` checks this set on
   * entry so a SIGINT racing the daemon's HTTP queue cannot leak a tmux
   * session or subprocess. Entries older than `PRE_START_CANCEL_TTL_MS`
   * are purged on access plus on a sweep timer.
   */
  private cancelledBeforeStart: Map<string, number> = new Map();

  constructor(
    private sessionManager: SessionManager,
    private registry: InvocationRegistry,
  ) {
    super();

    // Each active Claude invocation attaches two transient `change`
    // listeners inside `ClaudeInvoker` (correlation + turn-end). The
    // daemon adds permanent listeners on top, so concurrency of ~5
    // crosses EventEmitter's default 10-listener threshold and prints
    // `MaxListenersExceededWarning`. Cleanup is correct, so this is noise
    // rather than a leak; raising the ceiling silences it.
    this.sessionManager.setMaxListeners(64);

    // Adversarial spam of `POST /invoke/<id>/cancel` for ids never paired
    // with `invoke()` would let `cancelledBeforeStart` grow until
    // something else triggered a purge. Sweep on a timer so the floor is
    // bounded by call rate × TTL, not by call rate alone. `.unref()` so
    // the timer never keeps the daemon alive on its own.
    setInterval(
      () => this.purgeStalePreStartCancels(),
      PRE_START_CANCEL_SWEEP_MS,
    ).unref();

    // Same idiom for the finished-record store: bound its growth with a
    // TTL sweep on top of the purge-on-access in `listInvocations`.
    setInterval(
      () => this.purgeFinishedRecords(),
      FINISHED_RECORD_SWEEP_MS,
    ).unref();
  }

  /**
   * Resolve the `Invoker` the registry would dispatch to for `agent`.
   * Surfaced for callers (today: `DaemonServer.handleInvoke`) that need to
   * derive capabilities via `capabilitiesFor(agent, invoker)` before
   * handing the request to `invoke()`. Returns `undefined` for custom
   * `ccmux.json` agents that aren't `claude` and lack `invokeMode`; the
   * server short-circuits those with `agent_error`, mirroring the
   * defense-in-depth reject still living inside `invoke()` below.
   */
  getInvokerFor(agent: AgentDef): Invoker | undefined {
    return this.registry.get(agent);
  }

  /**
   * Count of invocations currently executing. Reads the active
   * AbortController map, NOT the finished-record store. `invocations` is
   * private; this is the board's in-flight signal.
   */
  get inFlightCount(): number {
    return this.invocations.size;
  }

  /**
   * Snapshot of active + recently-finished invocation records, newest
   * first by `startedAt`. Purges expired finished records on access so a
   * poller never sees a stale terminal record past its TTL.
   */
  listInvocations(): InvocationRecord[] {
    this.purgeFinishedRecords();
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Single record lookup, for the server's per-id surfaces.
   */
  getInvocation(invocationId: string): InvocationRecord | undefined {
    return this.records.get(invocationId);
  }

  /**
   * Back-fill the session/pane a Claude invoke landed in, so `ccmux
   * invoke list` shows where it ran. Called by the server on Claude
   * session promotion (the enrich-time name match). No-ops if the record
   * has already aged out (the link is cosmetic, not load-bearing).
   */
  linkSession(
    invocationId: string,
    sessionId: string,
    paneId: string | null,
  ): void {
    const record = this.records.get(invocationId);
    if (!record) return;
    record.sessionId = sessionId;
    if (paneId) record.paneId = paneId;
  }

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    // Collision: the registry's invoker may register synchronously into
    // shared state, and a duplicate id would silently overwrite. Reject
    // before any invoker work begins.
    if (this.invocations.has(input.invocationId)) {
      return fail(
        input.invocationId,
        "agent_error",
        "invocationId already in flight",
      );
    }
    if (this.invocations.size >= MAX_CONCURRENT_INVOCATIONS) {
      return fail(
        input.invocationId,
        "agent_error",
        `too many concurrent invocations (max ${MAX_CONCURRENT_INVOCATIONS})`,
      );
    }

    // Cancel-before-start: a CLI SIGINT can race the daemon's HTTP queue
    // and arrive before `invoke()` runs. The stash entry short-circuits
    // before we burn a tmux session or subprocess. Centralized here at
    // 2.4; pre-flip the same check lived inside each invoker subpath, so
    // a pre-cancel for an agent with no `invokeMode` or no Claude binding
    // used to surface as `agent_error` instead of `cancelled`.
    this.purgeStalePreStartCancels();
    if (this.cancelledBeforeStart.has(input.invocationId)) {
      this.cancelledBeforeStart.delete(input.invocationId);
      return fail(input.invocationId, "cancelled", "cancelled");
    }

    const invoker = this.registry.get(input.agent);
    if (!invoker) {
      // Defense-in-depth: `DaemonServer.handleInvoke` already short-
      // circuits the no-invoker case with the same message, so this
      // branch is unreachable via the `POST /invoke` path. It stays as a
      // safety net for any future non-server caller. Message is shared
      // via `noInvokeModeMessage` so CLI matchers keying on `invokeMode`
      // stay aligned across both sites.
      return fail(
        input.invocationId,
        "agent_error",
        noInvokeModeMessage(input.agent),
      );
    }

    const ac = new AbortController();
    this.invocations.set(input.invocationId, ac);

    // Admission point past all rejection guards. Stamp the start time and
    // write the `running` record here (newest-wins: a `.set` overwrites
    // any lingering finished record for a reused id), so only invocations
    // that actually begin execution enter the store. `startedAt` is the
    // sole source for the live board age and the failure-path durationMs.
    const startedAt = Date.now();
    const record: InvocationRecord = {
      invocationId: input.invocationId,
      agent: input.agent.name,
      cwd: input.cwd,
      startedAt,
      status: "running",
    };
    this.records.set(input.invocationId, record);
    this.safeEmit({ type: "started", record });

    const timeoutTimer = setTimeout(() => ac.abort("timeout"), input.timeoutMs);

    try {
      // Capture the result so `finish()` can read success-vs-failure and
      // the success-only durationMs/sessionId/paneId. A bare `finally`
      // sees neither, so the terminal record + `finished` emission live
      // around the await (try/catch), not in `finally`. The single finish
      // site here covers success, failure, timeout, and cancel uniformly
      // (all unwind through this one await), satisfying the exactly-once
      // contract.
      const result = await invoker.invoke(input, ac.signal);
      this.finish(input.invocationId, startedAt, result);
      return result;
    } catch (err) {
      // An invoker that throws (e.g. the SubprocessInvoker precondition
      // for a missing invokeMode) still gets a terminal record so the
      // store never strands a `running` entry. The thrown error is
      // re-surfaced unchanged; the server's own catch maps it to the
      // HTTP response.
      this.finish(input.invocationId, startedAt, {
        success: false,
        invocationId: input.invocationId,
        kind: "unknown",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      this.invocations.delete(input.invocationId);
    }
  }

  /**
   * Flip an admitted invocation's record to its terminal state and emit
   * `finished`. `durationMs` comes from `InvokeSuccess.durationMs` on
   * success; on failure it is computed from `startedAt` (the failure path
   * carries no duration). The `running` record is written at admission and
   * never purged while running, so it is always present here; a missing
   * record (impossible in practice) is a defensive no-op.
   */
  private finish(
    invocationId: string,
    startedAt: number,
    result: InvokeResult,
  ): void {
    // `invoke()` writes the `running` record at admission, before the await
    // whose settlement leads here, so the record is always present at finish
    // (a reused id is rejected by the dup-id guard while in flight, and a
    // running record is never TTL-purged). Guard defensively rather than
    // re-create a malformed empty-`agent` record.
    const record = this.records.get(invocationId);
    if (!record) return;
    if (result.success) {
      record.status = "succeeded";
      record.durationMs = result.durationMs;
      if (result.sessionId) record.sessionId = result.sessionId;
      if (result.paneId) record.paneId = result.paneId;
    } else {
      // A cancel is a first-class outcome, not a failure; every other
      // non-success kind (timeout included) stays `failed`, disambiguated
      // by `kind`.
      record.status = result.kind === "cancelled" ? "cancelled" : "failed";
      record.durationMs = Date.now() - startedAt;
      record.kind = result.kind;
      if (result.paneId) record.paneId = result.paneId;
    }
    this.records.set(invocationId, record);
    this.safeEmit({ type: "finished", record });
  }

  /**
   * Emit a `change` event without letting a listener exception touch
   * invocation lifecycle. `emit` is synchronous, so a throwing subscriber
   * (e.g. the SSE broadcast handler) would otherwise escape `invoke()`
   * before `finish()` and the `finally` that deletes the AbortController,
   * stranding a `running` record and leaking a concurrency slot. Listener
   * errors are logged and swallowed.
   */
  private safeEmit(event: InvocationEvent): void {
    try {
      this.emit("change", event);
    } catch (err) {
      console.error("[invocation-manager] change listener threw:", err);
    }
  }

  /**
   * Best-effort cancel. Aborts the in-flight signal so the invoker can
   * unwind on its next checkpoint and tear down its own resources (the
   * Claude tmux session, the subprocess). HTTP `POST /invoke/:id/cancel`
   * returns as soon as the abort lands, NOT after teardown completes;
   * the original `invoke()` HTTP request is what returns post-teardown
   * with the cancelled result. This is a deliberate delta from the
   * pre-2.4 manager, which awaited C-c + grace + kill before returning
   * from `cancel()`.
   *
   * Returns `true` either way: if the id is genuinely unknown the cancel is
   * stashed for a later `invoke()` to honor.
   */
  cancel(invocationId: string): boolean {
    const ac = this.invocations.get(invocationId);
    if (ac) {
      ac.abort("cancelled");
      return true;
    }
    // No active controller: the id is either already-finished (a terminal
    // record is present) or genuinely not-yet-started (a SIGINT racing the
    // daemon's HTTP queue ahead of `invoke()`). Only stash the latter. The
    // `running` record and its AbortController are created and torn down
    // together, so an absent `ac` with a present record is always terminal.
    // Stashing for a finished id would, if that id were ever reused within
    // `PRE_START_CANCEL_TTL_MS`, falsely pre-cancel the new invoke.
    if (!this.records.has(invocationId)) {
      this.purgeStalePreStartCancels();
      this.cancelledBeforeStart.set(invocationId, Date.now());
    }
    return true;
  }

  private purgeStalePreStartCancels(): void {
    const cutoff = Date.now() - PRE_START_CANCEL_TTL_MS;
    for (const [id, ts] of this.cancelledBeforeStart) {
      if (ts < cutoff) this.cancelledBeforeStart.delete(id);
    }
  }

  private purgeFinishedRecords(): void {
    const cutoff = Date.now() - FINISHED_RECORD_TTL_MS;
    for (const [id, record] of this.records) {
      // Only reap terminal records; a still-running invocation lingers
      // regardless of age (a 30-minute invoke is legitimate).
      if (record.status !== "running" && record.startedAt < cutoff) {
        this.records.delete(id);
      }
    }
  }
}
