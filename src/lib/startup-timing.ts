import { PERF_ENABLED } from "./perf-config";

interface StartupMark {
  label: string;
  ns: number;
}

const NS_PER_MS = 1_000_000;
const marks: StartupMark[] = [];

/**
 * Record a named startup timestamp using Bun.nanoseconds().
 * No-op when PERF_ENABLED is false (zero overhead).
 */
export function markStartup(label: string): void {
  if (!PERF_ENABLED) return;
  marks.push({ label, ns: Bun.nanoseconds() });
}

/** Return all recorded marks (for testing). */
export function getStartupMarks(): readonly StartupMark[] {
  return marks;
}

/** Clear all marks (for testing). */
export function resetStartupMarks(): void {
  marks.length = 0;
}

/**
 * Print a startup waterfall table to stderr showing cumulative and delta times.
 * Automatically called when the `first_data` mark is recorded.
 */
export function reportStartup(): void {
  if (!PERF_ENABLED || marks.length === 0) return;

  const t0 = marks[0].ns;
  const maxLabelLen = Math.max(...marks.map((m) => m.label.length));

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const cumMs = (mark.ns - t0) / NS_PER_MS;
    const deltaMs = i === 0 ? 0 : (mark.ns - marks[i - 1].ns) / NS_PER_MS;
    const label = mark.label.padEnd(maxLabelLen);
    const cumStr = `${cumMs.toFixed(0)}ms`.padStart(6);

    if (i === 0) {
      process.stderr.write(`[startup] ${label}  ${cumStr}\n`);
    } else {
      process.stderr.write(
        `[startup] ${label}  ${cumStr}  (+${deltaMs.toFixed(0)}ms)\n`,
      );
    }
  }

  const totalMs = (marks[marks.length - 1].ns - t0) / NS_PER_MS;
  const separator = "\u2500".repeat(maxLabelLen + 16);
  process.stderr.write(`[startup] ${separator}\n`);
  process.stderr.write(
    `[startup] ${"total".padEnd(maxLabelLen)}  ${`${totalMs.toFixed(0)}ms`.padStart(6)}\n`,
  );
  process.stderr.write("\n");

  marks.length = 0;
}
