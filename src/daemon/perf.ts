/**
 * Daemon-side performance instrumentation.
 * Gated behind CCMUX_PERF=1 (zero overhead when disabled).
 *
 * Reporter cadence: counters accumulate across `reportInterval` scans
 * (default 5) and are printed as PER-SCAN AVERAGES, then reset. The
 * counters (markers, paneCaptures, subprocesses, matching) are summed
 * over the window before division; do not interpret a single line as
 * "this many in the last scan".
 *
 * Usage:
 *   CCMUX_PERF=1 ccmux daemon start
 *   tail -f ~/.config/ccmux/ccmux.log | grep '\[perf\]'
 */

const PERF_ENABLED = process.env.CCMUX_PERF === "1";
const NS_PER_MS = 1_000_000;

// --- Counters ---
let markerReads = 0;
let markerBatchReads = 0;
let paneCaptures = 0;
let paneCaptureNs = 0;
let findIterations = 0;
const subprocessCounts = new Map<string, number>();

// --- Scan timing ---
let scanCount = 0;
let scanTotalNs = 0;
let scanMaxNs = 0;

// --- Marker cleanup timing ---
let cleanupTotalNs = 0;
let cleanupMaxNs = 0;
let cleanupCount = 0;

// --- Reporter ---
let reportInterval = 5;

function reset(): void {
  markerReads = 0;
  markerBatchReads = 0;
  paneCaptures = 0;
  paneCaptureNs = 0;
  findIterations = 0;
  subprocessCounts.clear();
  scanCount = 0;
  scanTotalNs = 0;
  scanMaxNs = 0;
  cleanupTotalNs = 0;
  cleanupMaxNs = 0;
  cleanupCount = 0;
}

export const DaemonPerf = {
  // --- Counters ---

  incMarkerReads(): void {
    if (!PERF_ENABLED) return;
    markerReads++;
  },

  incMarkerBatchReads(): void {
    if (!PERF_ENABLED) return;
    markerBatchReads++;
  },

  incSubprocessSpawn(label: string): void {
    if (!PERF_ENABLED) return;
    subprocessCounts.set(label, (subprocessCounts.get(label) ?? 0) + 1);
  },

  incPaneCapture(): void {
    if (!PERF_ENABLED) return;
    paneCaptures++;
  },

  incFindIterations(count: number): void {
    if (!PERF_ENABLED) return;
    findIterations += count;
  },

  // --- Timers ---

  scanStart(): number {
    if (!PERF_ENABLED) return 0;
    return Bun.nanoseconds();
  },

  scanEnd(startNs: number): void {
    if (!PERF_ENABLED) return;
    const elapsed = Bun.nanoseconds() - startNs;
    scanCount++;
    scanTotalNs += elapsed;
    if (elapsed > scanMaxNs) scanMaxNs = elapsed;
  },

  markerCleanupStart(): number {
    if (!PERF_ENABLED) return 0;
    return Bun.nanoseconds();
  },

  markerCleanupEnd(startNs: number): void {
    if (!PERF_ENABLED) return;
    const elapsed = Bun.nanoseconds() - startNs;
    cleanupCount++;
    cleanupTotalNs += elapsed;
    if (elapsed > cleanupMaxNs) cleanupMaxNs = elapsed;
  },

  paneCaptureStart(): number {
    if (!PERF_ENABLED) return 0;
    return Bun.nanoseconds();
  },

  paneCaptureEnd(startNs: number): void {
    if (!PERF_ENABLED) return;
    paneCaptureNs += Bun.nanoseconds() - startNs;
  },

  // --- Reporter ---

  startReporter(intervalCycles: number): void {
    if (!PERF_ENABLED) return;
    reportInterval = intervalCycles;
    console.log("[perf] daemon instrumentation enabled");
  },

  /**
   * Call at end of each scan cycle. Prints PER-SCAN-AVERAGED summary
   * every N cycles, then resets all counters. Counters that are spawned
   * per scan (subprocesses, marker reads, etc.) are divided by `scanCount`
   * before printing so a reader can interpret each line as "what one
   * average scan looked like" without mental math on the window size.
   * Note: `paneCaptures` avgMs is per-capture wall-clock-while-contending
   * (Promise.all fan-out), not a serial cost.
   */
  report(): void {
    if (!PERF_ENABLED) return;
    if (scanCount < reportInterval) return;

    const avgScanMs = scanTotalNs / scanCount / NS_PER_MS;
    const maxScanMs = scanMaxNs / NS_PER_MS;
    console.log(
      `[perf] scan: avg=${avgScanMs.toFixed(1)}ms max=${maxScanMs.toFixed(1)}ms count=${scanCount} (avgs below are per-scan, over these ${scanCount} scans)`,
    );

    console.log(
      `[perf] markers: reads/scan=${(markerReads / scanCount).toFixed(1)} batchReads/scan=${(markerBatchReads / scanCount).toFixed(1)}`,
    );

    if (cleanupCount > 0) {
      const avgCleanupMs = cleanupTotalNs / cleanupCount / NS_PER_MS;
      const maxCleanupMs = cleanupMaxNs / NS_PER_MS;
      console.log(
        `[perf] cleanup: avg=${avgCleanupMs.toFixed(1)}ms max=${maxCleanupMs.toFixed(1)}ms`,
      );
    }

    console.log(
      `[perf] matching: findIterations/scan=${(findIterations / scanCount).toFixed(1)}`,
    );

    const subprocs = [...subprocessCounts.entries()]
      .map(([k, v]) => `${k}=${(v / scanCount).toFixed(1)}`)
      .join(" ");
    console.log(`[perf] subprocesses/scan: ${subprocs || "(none)"}`);

    if (paneCaptures > 0) {
      const totalCaptureMs = paneCaptureNs / NS_PER_MS;
      const avgCaptureMs = totalCaptureMs / paneCaptures;
      console.log(
        `[perf] paneCaptures: count/scan=${(paneCaptures / scanCount).toFixed(1)} avgMs/capture=${avgCaptureMs.toFixed(1)} (wall-clock-while-contending, Promise.all fan-out)`,
      );
    } else {
      console.log(`[perf] paneCaptures: count/scan=0.0`);
    }

    console.log("");
    reset();
  },
};
