import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchErrorRules } from "../../lib/invoke-helpers";
import { writeInvocationResult } from "../invocation-results";
import {
  CANCEL_GRACE_MS,
  ERROR_CHROME_TAIL_LINES,
  MAX_ARGV_PROMPT_BYTES,
} from "./constants";
import {
  abortToFailure,
  buildSubprocessArgv,
  extractSubprocessResponse,
  extractSubprocessSessionId,
  fail,
  subprocessPromptInArgs,
} from "./helpers";
import { capabilitiesFor, type Invoker } from "./invoker";
import type { InvokeInput, InvokeResult } from "./types";

/**
 * Minimal surface of `Bun.spawn`'s `Subprocess` that the invoker reads.
 * Tests pass a structural fake so neither real spawn nor real I/O is
 * needed. Production wraps `Bun.spawn` directly via the default deps.
 */
export interface SpawnedProcess {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Injected spawn function. Default wraps `Bun.spawn`; tests pass a fake
 * returning a `SpawnedProcess` so neither a real subprocess nor real I/O
 * is needed.
 */
type SpawnFn = (
  argv: string[],
  options: {
    cwd: string;
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
    env: typeof process.env;
  },
) => SpawnedProcess;

/**
 * Dependencies the invoker reads. Production builds these via
 * `defaultSubprocessInvokerDeps()` (real spawn, real tmpfs, real clock);
 * tests pass structural fakes to pin behavior without I/O.
 */
export interface SubprocessInvokerDeps {
  spawn: SpawnFn;
  /**
   * Bundled tmpfile lifecycle so tests don't have to fake four separate
   * fs primitives (mkdtemp/rm/tmpdir/join). The default implementation
   * lives in `defaultSubprocessInvokerDeps`.
   */
  createTmpDir: () => Promise<{ dir: string; tmpfile: string }>;
  removeTmpDir: (dir: string) => Promise<void>;
  extractResponse: typeof extractSubprocessResponse;
  /**
   * Persist the invocation's full stdout/stderr to the ephemeral
   * `/tmp` result store, keyed by id, for `ccmux invoke result <id>`.
   * Best-effort (swallows errors). Injectable so tests can assert the
   * write happened without touching real `/tmp`.
   */
  writeResult: (invocationId: string, output: string) => Promise<void>;
  now: () => number;
}

/**
 * Combine captured stdout and stderr into the single blob written to the
 * `/tmp` result store. stderr is appended under a labeled separator only
 * when non-empty, so a clean run reads as plain stdout.
 */
function formatCapturedOutput(stdoutText: string, stderrText: string): string {
  if (stderrText.trim() === "") return stdoutText;
  return `${stdoutText}\n--- stderr ---\n${stderrText}`;
}

export function defaultSubprocessInvokerDeps(): SubprocessInvokerDeps {
  return {
    // Bun.spawn's Subprocess type carries extra fields (pid, resourceUsage)
    // and richer pipe types than SpawnedProcess; narrow to the surface
    // the invoker actually reads.
    spawn: (argv, options) =>
      Bun.spawn(argv, options) as unknown as SpawnedProcess,
    createTmpDir: async () => {
      const dir = await mkdtemp(join(tmpdir(), "ccmux-invoke-"));
      return { dir, tmpfile: join(dir, "last-message.txt") };
    },
    removeTmpDir: async (dir) => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
    extractResponse: extractSubprocessResponse,
    writeResult: writeInvocationResult,
    now: () => Date.now(),
  };
}

/**
 * Subprocess invoker for agents whose `invokeMode` is configured. Pipes
 * stdin (prompt), captures stdout + stderr in parallel, applies
 * `errorRules` to the combined tail, and extracts the response text per
 * `mode.output.kind`. No tmux, no daemon session correlation.
 *
 * The abort handler kills `proc` directly (SIGTERM, then SIGKILL after a
 * grace period) rather than using ClaudeInvoker's flag-and-finally
 * pattern: subprocess has an in-flight handle to kill, ClaudeInvoker
 * doesn't (its work happens inside tmux). The classification of
 * cancelled vs timeout happens AFTER `proc.exited` resolves, because the
 * stdout/stderr/exit Promise.all blocks the await chain until then.
 */
export class SubprocessInvoker implements Invoker {
  readonly kind = "subprocess" as const;

  constructor(private deps: SubprocessInvokerDeps) {}

  async invoke(input: InvokeInput, signal: AbortSignal): Promise<InvokeResult> {
    // Precondition the registry enforces in 2.4: SubprocessInvoker is
    // only dispatched for agents with `invokeMode` set. An unrecoverable
    // throw is honest; returning `agent_error` would pretend a
    // programmer error is user-recoverable.
    const mode = input.agent.invokeMode;
    if (!mode) {
      throw new Error(
        `SubprocessInvoker dispatched for agent without invokeMode: ${input.agent.name}`,
      );
    }

    if (
      input.sessionId &&
      !capabilitiesFor(input.agent, this).supportsSessionResume
    ) {
      return fail(
        input.invocationId,
        "agent_error",
        `${input.agent.name} does not support --session <id>`,
      );
    }

    if (signal.aborted) return abortToFailure(input.invocationId, signal);

    // An argv-borne prompt (`{prompt}`, e.g. gemini's `-p`) is one execve
    // arg, OS-bounded unlike stdin. Reject oversized here (after the abort
    // check, so cancel wins) rather than hit a Linux-only E2BIG.
    const promptInArgs = subprocessPromptInArgs(mode, input.sessionId);
    if (promptInArgs) {
      const promptBytes = Buffer.byteLength(input.prompt, "utf8");
      if (promptBytes > MAX_ARGV_PROMPT_BYTES) {
        return fail(
          input.invocationId,
          "agent_error",
          `${input.agent.name} prompt is ${Math.ceil(promptBytes / 1024)} KiB; ` +
            `prompts passed as a command-line argument are capped at ` +
            `${MAX_ARGV_PROMPT_BYTES / 1024} KiB. Shorten the prompt.`,
        );
      }
    }

    const tStart = this.deps.now();
    let tmpDir: string | null = null;

    try {
      let tmpfilePath: string | null = null;
      if (mode.output.kind === "tmpfile") {
        const tmp = await this.deps.createTmpDir();
        tmpDir = tmp.dir;
        tmpfilePath = tmp.tmpfile;
      }

      const argv = buildSubprocessArgv(mode, {
        sessionId: input.sessionId,
        tmpfile: tmpfilePath,
        prompt: input.prompt,
      });

      // Hooks still fire during invoke (each agent's SessionStart hook
      // writes a marker file the daemon's HookManager picks up). With no
      // tmux pane to correlate against, the marker stays orphaned until
      // `cleanupStaleMarkers` sweeps it once the subprocess exits. No
      // correctness impact, but worth a comment before someone tries to
      // "fix" the orphan.
      const proc = this.deps.spawn(argv, {
        cwd: input.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const onAbort = () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already exited
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already exited
          }
        }, CANCEL_GRACE_MS).unref();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Prompt rode in argv (gemini `-p`): writing stdin too re-creates
        // the old hang. Still `.end()` below so the child sees EOF.
        if (!promptInArgs) proc.stdin.write(input.prompt);
        proc.stdin.end();
      } catch {
        // Process exited before stdin closed; the exit-code branch
        // below classifies the failure.
      }

      // Read stdout/stderr concurrently with `exited` so neither pipe
      // can backpressure the subprocess into a deadlock on a large
      // response.
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      signal.removeEventListener("abort", onAbort);

      // Persist the full captured output before any early return so the
      // error/abort/timeout cases are covered too, not just success.
      // The invoke returns only the summary-sized final turn over stdout;
      // this is the backup `ccmux invoke result <id>` pulls. Written here
      // (before the abort check) so a cancel still saves partial output.
      // Outside the tmpDir that `removeTmpDir` nukes in `finally`.
      await this.deps.writeResult(
        input.invocationId,
        formatCapturedOutput(stdoutText, stderrText),
      );

      if (signal.aborted) {
        return abortToFailure(input.invocationId, signal);
      }

      // errorRules win over exit-code classification: codex/opencode
      // print their rate-limit banner THEN exit non-zero. Generic
      // "exited with code N" would mask the actionable cause.
      const errorRules = input.agent.errorRules ?? [];
      if (errorRules.length > 0) {
        const tail = `${stdoutText}\n${stderrText}`
          .split("\n")
          .slice(-ERROR_CHROME_TAIL_LINES)
          .join("\n");
        const errorMatch = matchErrorRules(tail, errorRules);
        if (errorMatch) {
          return fail(input.invocationId, errorMatch.kind, errorMatch.message);
        }
      }

      if (exitCode !== 0) {
        const detail =
          stderrText.trim() || stdoutText.trim() || `exit code ${exitCode}`;
        return fail(
          input.invocationId,
          "agent_error",
          `${input.agent.name} exited with: ${detail}`,
        );
      }

      const text = await this.deps.extractResponse(mode, {
        stdout: stdoutText,
        tmpfilePath,
      });

      // OpenCode exits 0 even when it couldn't run the prompt. For
      // example, `--session <id>` against a missing session prints
      // `NotFoundError` to stderr and produces no model output. Without
      // this guard the CLI returns an empty success that looks like
      // "model said nothing."
      if (text === "" && stderrText.trim() !== "") {
        return fail(
          input.invocationId,
          "agent_error",
          `${input.agent.name} produced no response: ${stderrText.trim()}`,
        );
      }

      return {
        success: true,
        invocationId: input.invocationId,
        sessionId:
          extractSubprocessSessionId(mode, stdoutText) ?? input.sessionId,
        text,
        durationMs: this.deps.now() - tStart,
      };
    } catch (err) {
      return fail(
        input.invocationId,
        "unknown",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // Cleanup is awaited (not fire-and-forget) so it stays deterministic in
      // tests and surfaces cleanup bugs in the result instead of as a stray
      // unhandled rejection. Default `removeTmpDir` still swallows errors,
      // so a transient unlink failure cannot mask a successful invoke.
      if (tmpDir) {
        await this.deps.removeTmpDir(tmpDir);
      }
    }
  }
}
