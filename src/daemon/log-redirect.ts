import { createWriteStream, mkdirSync, type WriteStream } from "fs";
import { dirname } from "path";
import { format } from "util";
import { LOG_FILE } from "../lib/config";

let redirected = false;

const MAX_BUFFERED_BYTES = 1024 * 1024;

type StderrConsoleMethod = "warn" | "error";
type StdoutConsoleMethod = "log" | "info" | "debug";

export function formatLogLine(
  line: string,
  tag: string,
  isoTimestamp: string,
): string {
  return `[${isoTimestamp}]${tag} ${line}\n`;
}

export function processWriteBuffer(
  buffer: string,
  tag: string,
  now: () => string,
): { lines: string[]; leftover: string } {
  const lines: string[] = [];
  let start = 0;
  let nl = buffer.indexOf("\n", start);
  while (nl !== -1) {
    lines.push(formatLogLine(buffer.substring(start, nl), tag, now()));
    start = nl + 1;
    nl = buffer.indexOf("\n", start);
  }
  return {
    lines,
    leftover: start > 0 ? buffer.substring(start) : buffer,
  };
}

/**
 * Format a `console.log`-style call as one or more tagged log lines.
 * Splits on embedded newlines so `console.log("a\nb")` produces two entries.
 */
export function formatConsoleCall(
  args: unknown[],
  tag: string,
  isoTimestamp: string,
): string {
  const text = format(...args);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return formatLogLine("", tag, isoTimestamp);
  let out = "";
  for (const line of lines) out += formatLogLine(line, tag, isoTimestamp);
  return out;
}

/**
 * Redirect daemon stdout/stderr to LOG_FILE with timestamped line prefixes.
 * Idempotent.
 *
 * Skips in two cases:
 * - `CCMUX_DAEMON_FOREGROUND=1`: developers want live output on the TTY.
 * - `process.stdout` is not a TTY: stdio is already redirected at the OS
 *   level (e.g. `spawnDaemonBackground` attaches fd 1/2 directly to LOG_FILE);
 *   wrapping on top would double-write. Non-TTY stdout reports `isTTY` as
 *   `undefined` in Node/Bun, not `false`, so check `!isTTY` rather than
 *   `=== false`.
 *
 * Patches both the `console` methods and `process.{stdout,stderr}.write`.
 * Bun's `console.log` writes straight to fd 1 without calling
 * `process.stdout.write`, so patching only the stream would miss every
 * `console.log` the daemon emits.
 */
export function redirectStdioToLogFile(): void {
  if (redirected) return;
  if (process.env.CCMUX_DAEMON_FOREGROUND === "1") return;
  if (!process.stdout.isTTY) return;

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const stream = createWriteStream(LOG_FILE, { flags: "a" });
  const now = (): string => new Date().toISOString();

  patchConsoleMethods(["log", "info", "debug"], stream, "", now);
  patchConsoleMethods(["warn", "error"], stream, " [err]", now);

  const flushStdout = wrapWriteStream(process.stdout, stream, "", now);
  const flushStderr = wrapWriteStream(process.stderr, stream, " [err]", now);

  process.on("exit", () => {
    flushStdout();
    flushStderr();
  });

  redirected = true;
}

function patchConsoleMethods(
  methods: ReadonlyArray<StdoutConsoleMethod | StderrConsoleMethod>,
  out: WriteStream,
  tag: string,
  now: () => string,
): void {
  for (const method of methods) {
    console[method] = (...args: unknown[]): void => {
      out.write(formatConsoleCall(args, tag, now()));
    };
  }
}

function wrapWriteStream(
  target: NodeJS.WriteStream,
  out: WriteStream,
  tag: string,
  now: () => string,
): () => void {
  let buffer = "";

  target.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    buffer += chunkToString(chunk);
    const { lines, leftover } = processWriteBuffer(buffer, tag, now);
    buffer = leftover;
    if (buffer.length > MAX_BUFFERED_BYTES) {
      lines.push(formatLogLine(buffer, tag, now()));
      buffer = "";
    }
    let ok = true;
    for (const line of lines) ok = out.write(line) && ok;
    const callback = rest.find(
      (arg): arg is (err?: Error | null) => void => typeof arg === "function",
    );
    if (callback) queueMicrotask(callback);
    return ok;
  }) as typeof target.write;

  return () => {
    if (buffer.length === 0) return;
    out.write(formatLogLine(buffer, tag, now()));
    buffer = "";
  };
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}
