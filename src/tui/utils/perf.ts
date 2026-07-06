import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { CliRenderer } from "@opentui/core";
import { PERF_ENABLED } from "../../lib/perf-config";

export { PERF_ENABLED };

// --- Memo tracking ---

const memoCounters = new Map<string, number>();

/**
 * When CCMUX_PERF=1, wraps createMemo with an invocation counter.
 * When disabled, returns a plain createMemo (zero overhead).
 */
export function trackedMemo<T>(
  name: string,
  fn: () => T,
  options?: { equals?: false | ((prev: T, next: T) => boolean) },
): Accessor<T> {
  if (!PERF_ENABLED) return createMemo(fn, undefined, options);
  memoCounters.set(name, 0);
  return createMemo(
    () => {
      memoCounters.set(name, (memoCounters.get(name) ?? 0) + 1);
      return fn();
    },
    undefined,
    options,
  );
}

export function getMemoCounters(): Map<string, number> {
  return memoCounters;
}

export function resetMemoCounters(): void {
  for (const key of memoCounters.keys()) {
    memoCounters.set(key, 0);
  }
}

// --- Timer tracking ---

let activeTimerCount = 0;

export function trackInterval(fn: () => void, ms: number): Timer {
  if (PERF_ENABLED) activeTimerCount++;
  return setInterval(fn, ms);
}

export function untrackInterval(id: Timer): void {
  if (PERF_ENABLED) activeTimerCount--;
  clearInterval(id);
}

export function getActiveTimerCount(): number {
  return activeTimerCount;
}

// --- Periodic reporter ---

let reporterInterval: Timer | null = null;

export function startPerfReporter(
  renderer: CliRenderer,
  intervalSec = 5,
): void {
  if (!PERF_ENABLED) return;

  renderer.setGatherStats(true);

  reporterInterval = trackInterval(() => {
    const stats = renderer.getStats();
    const memos = [...memoCounters.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

    process.stderr.write(
      `[perf] FPS: ${stats.fps} | avgFrame: ${stats.averageFrameTime.toFixed(1)}ms | maxFrame: ${stats.maxFrameTime.toFixed(1)}ms\n`,
    );
    process.stderr.write(`[perf] memos: ${memos}\n`);
    process.stderr.write(`[perf] activeTimers: ${activeTimerCount}\n`);
    process.stderr.write(`\n`);

    renderer.resetStats();
    resetMemoCounters();
  }, intervalSec * 1000);
}

export function stopPerfReporter(): void {
  if (reporterInterval) {
    untrackInterval(reporterInterval);
    reporterInterval = null;
  }
}
