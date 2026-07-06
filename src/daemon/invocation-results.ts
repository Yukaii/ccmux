import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidInvocationId } from "../lib/invoke-helpers";

/**
 * Ephemeral per-invocation full-output store. The subprocess invoker
 * already buffers the complete stdout/stderr in memory (today discarded
 * once the final turn is extracted); at finish it writes that here, keyed
 * by invocation id, so `ccmux invoke result <id>` can return more than
 * the summary-sized final turn the invoke returns inline.
 *
 * Stored under a per-daemon-process directory created with `mkdtempSync`
 * (mode 0700, random path component), NOT a deterministic
 * `/tmp/<prefix><id>` path. A deterministic path is a symlink-clobber /
 * disclosure vector once a caller can choose a predictable invocation id
 * (`ccmux invoke --id inv_step1`): a co-tenant on a shared host could
 * pre-plant a symlink at the path and the daemon would follow it on write
 * (verified: `Bun.write` follows an existing symlink). A 0700 dir only the
 * daemon user can traverse closes that vector, mirroring how the prompt
 * tmpfile is already hardened with `mkdtemp` in `subprocess-invoker.ts`.
 *
 * Deliberately ephemeral: lost on restart (a fresh dir per process),
 * reboot, or the OS's `/tmp` reap. `read` returns a clean miss (`null`)
 * rather than throwing when the file is gone, so `result` no-ops cleanly.
 * The durable successor (a per-invoke store under `~/.config/ccmux/`) is
 * the later swap if mid-life reaps ever bite a days-later read.
 *
 * The id reaches a filesystem path on both write and read, so callers MUST
 * pass an `INVOCATION_ID_PATTERN`-validated id (no path separators); the
 * helpers below encode the path consistently for both sides so they can
 * never diverge.
 */

const RESULT_FILE_SUFFIX = ".log";

/**
 * Per-invocation result cap. The subprocess invoker buffers unbounded
 * stdout/stderr; without a ceiling a runaway agent emitting gigabytes
 * would write a multi-GB file and OOM the daemon when `result` reads it
 * back. 5 MiB is far above any realistic final-turn-plus-error-chrome
 * output. Measured in UTF-16 code units (`string.length`); for the
 * near-ASCII output agents produce this tracks bytes closely enough for a
 * robustness cap. The reserve leaves room for the truncation marker so the
 * written payload stays at/under the cap (and the read-side cap can never
 * sever the marker).
 */
const MAX_RESULT_CHARS = 5 * 1024 * 1024;
const TRUNCATION_RESERVE = 64;

/**
 * Lazily-created, per-daemon-process result directory (0700). `mkdtempSync`
 * creates it atomically with 0700 perms and a random suffix, so neither it
 * nor its name can be a pre-planted symlink the writer would follow.
 * Memoized so the writer and reader share one directory for the life of
 * the process.
 */
let resultDir: string | undefined;
function getResultDir(): string {
  if (resultDir === undefined) {
    resultDir = mkdtempSync(join(tmpdir(), "ccmux-invoke-results-"));
  }
  return resultDir;
}

/**
 * Path of the result file for an invocation. A single source of truth so
 * the writer (invoker) and reader (server) can never compute it
 * differently. The id is expected to already match `INVOCATION_ID_PATTERN`,
 * so it contains no path separators and stays inside the 0700 dir.
 */
export function invocationResultPath(invocationId: string): string {
  // Defense-in-depth: the path-traversal guard travels with the path
  // construction, so a future caller that forgets to validate can't turn a
  // crafted id into an out-of-dir write/read. Both current callers (the CLI
  // and the server's result handler) already validate; this makes the
  // invariant local instead of trusting every call site.
  if (!isValidInvocationId(invocationId)) {
    throw new Error(`invalid invocationId: ${invocationId}`);
  }
  return join(getResultDir(), `${invocationId}${RESULT_FILE_SUFFIX}`);
}

/**
 * Persist an invocation's full captured output, truncating to the cap.
 * Best-effort: a full or read-only result dir must never fail an
 * otherwise-good invoke, so write errors are swallowed (matching
 * `removeTmpDir`'s contract).
 */
export async function writeInvocationResult(
  invocationId: string,
  output: string,
): Promise<void> {
  try {
    const payload =
      output.length > MAX_RESULT_CHARS
        ? output.slice(0, MAX_RESULT_CHARS - TRUNCATION_RESERVE) +
          `\n...[truncated, ${output.length} chars total]\n`
        : output;
    await Bun.write(invocationResultPath(invocationId), payload);
  } catch {
    // Best-effort backup; a write failure is not worth failing the invoke.
  }
}

/**
 * Read an invocation's full captured output, or `null` when the file is
 * gone (reaped, never written, or written by a since-restarted daemon).
 * Reap-tolerant by contract: callers surface a clean "no longer available"
 * miss on `null`, never an error. Defensively re-bounded to the cap in case
 * a file was produced by some other means.
 */
export async function readInvocationResult(
  invocationId: string,
): Promise<string | null> {
  // Reap-tolerant by contract: never throw. An invalid id (which would make
  // `invocationResultPath` throw) is treated as a clean miss, same as a gone
  // file.
  if (!isValidInvocationId(invocationId)) return null;
  const file = Bun.file(invocationResultPath(invocationId));
  if (!(await file.exists())) return null;
  try {
    const text = await file.text();
    return text.length > MAX_RESULT_CHARS
      ? text.slice(0, MAX_RESULT_CHARS)
      : text;
  } catch {
    return null;
  }
}
