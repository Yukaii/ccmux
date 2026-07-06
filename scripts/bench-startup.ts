#!/usr/bin/env bun
/**
 * Repeatable startup benchmark for ccmux. Run before and after perf changes
 * and diff the JSON outputs in scripts/bench-results/.
 *
 * Measures:
 *   1. cli_boot        - `<runner> --version` wall time (bun process boot + CLI parse)
 *   2. warm_picker     - CCMUX_PERF waterfall with the daemon already healthy
 *   3. cold_daemon     - daemon spawn -> PID file -> /health responding
 *   4. cold_picker     - picker launched with the daemon dead (records the
 *                        success/failure outcome of the auto-start race)
 *
 * Usage: bun scripts/bench-startup.ts [--runs N] [--label name]
 *
 * Side effects: stops and restarts the local ccmux daemon several times.
 * Open sidebars/pickers will briefly show their reconnecting state.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const HEALTH_URL = "http://127.0.0.1:2269/health";
const PID_FILE = join(process.env.HOME ?? "~", ".config", "ccmux", "ccmux.pid");
const PERF_LOG = "/tmp/ccmux-bench-perf.log";
const TMUX_SESSION = "ccmux-bench";

const args = process.argv.slice(2);
const RUNS = parseInt(args[args.indexOf("--runs") + 1] || "", 10) || 5;
const LABEL =
  args[args.indexOf("--label") + 1] && args.includes("--label")
    ? args[args.indexOf("--label") + 1]
    : "baseline";

const SOURCE_RUNNER = ["bun", join(ROOT, "src/index.ts")];
const DIST_RUNNER = existsSync(join(ROOT, "dist/index.js"))
  ? ["bun", join(ROOT, "dist/index.js")]
  : null;

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

async function healthOk(timeoutMs = 250): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(
  pred: () => Promise<boolean> | boolean,
  maxMs: number,
  stepMs = 20,
): Promise<number | null> {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    if (await pred()) return performance.now() - start;
    await Bun.sleep(stepMs);
  }
  return null;
}

async function stopDaemon(): Promise<void> {
  await sh([...SOURCE_RUNNER, "daemon", "stop"]);
  await waitUntil(async () => !(await healthOk(100)), 5000, 50);
  // let the released socket settle before respawning
  await Bun.sleep(300);
}

async function ensureDaemonUp(): Promise<void> {
  if (await healthOk()) return;
  const logFd = Bun.file("/dev/null");
  Bun.spawn([...SOURCE_RUNNER, "daemon", "start"], {
    cwd: ROOT,
    stdout: logFd,
    stderr: logFd,
  });
  const t = await waitUntil(() => healthOk(100), 20000, 50);
  if (t === null) throw new Error("daemon did not become healthy in 20s");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fmtRuns(xs: number[]): string {
  return `${xs.map((x) => Math.round(x)).join(", ")}  (median ${Math.round(median(xs))}ms)`;
}

function parseWaterfall(text: string): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const m of text.matchAll(/\[startup\] (\w+)\s+(\d+)ms/g)) {
    marks[m[1]] = parseInt(m[2], 10);
  }
  return marks;
}

async function killBenchTmux(): Promise<void> {
  await sh(["tmux", "kill-session", "-t", TMUX_SESSION]);
}

/** Launch the picker in a detached tmux session (no interactive shell, so no
 * zshrc cost) and wait for either the perf waterfall or a startup failure. */
async function runPickerOnce(
  runner: string[],
  maxMs: number,
): Promise<{ marks: Record<string, number>; failed: boolean; log: string }> {
  rmSync(PERF_LOG, { force: true });
  const cmd = `CCMUX_PERF=1 ${runner.join(" ")} picker 2>${PERF_LOG}`;
  await sh([
    "tmux",
    "new-session",
    "-d",
    "-s",
    TMUX_SESSION,
    "-x",
    "200",
    "-y",
    "50",
    cmd,
  ]);
  await waitUntil(
    () => {
      if (!existsSync(PERF_LOG)) return false;
      const log = readFileSync(PERF_LOG, "utf-8");
      return log.includes("[startup] total") || log.includes("Failed to start");
    },
    maxMs,
    50,
  );
  const log = existsSync(PERF_LOG) ? readFileSync(PERF_LOG, "utf-8") : "";
  await sh(["tmux", "send-keys", "-t", TMUX_SESSION, "q"]);
  await Bun.sleep(200);
  await killBenchTmux();
  return {
    marks: parseWaterfall(log),
    failed: log.includes("Failed to start"),
    log,
  };
}

interface Results {
  label: string;
  date: string;
  runs: number;
  cli_boot_ms: Record<string, number[]>;
  warm_picker: Record<string, { parallel_init: number[]; total: number[] }>;
  cold_daemon: {
    pid_file_ms: number[];
    health_ms: number[];
    full_boot_ms: number[];
  };
  cold_picker: {
    outcome: string;
    elapsed_ms: number | null;
    total_mark: number | null;
  }[];
}

const results: Results = {
  label: LABEL,
  date: new Date().toISOString(),
  runs: RUNS,
  cli_boot_ms: {},
  warm_picker: {},
  cold_daemon: { pid_file_ms: [], health_ms: [], full_boot_ms: [] },
  cold_picker: [],
};

const runners: [string, string[]][] = [["source", SOURCE_RUNNER]];
if (DIST_RUNNER) runners.push(["dist", DIST_RUNNER]);
// What the user's PATH/hotkey actually invokes (bin/ccmux picks dist vs src).
const WRAPPER = join(process.env.HOME ?? "~", ".bun", "bin", "ccmux");
if (existsSync(WRAPPER)) runners.push(["wrapper", [WRAPPER]]);

// ---- 1. CLI boot ------------------------------------------------------------
console.log(`\n=== 1. CLI boot (\`--version\` wall time, ${RUNS} runs) ===`);
for (const [name, runner] of runners) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await sh([...runner, "--version"]);
    times.push(performance.now() - t);
  }
  results.cli_boot_ms[name] = times;
  console.log(`${name.padEnd(8)} ${fmtRuns(times)}`);
}

// ---- 2. Warm picker ---------------------------------------------------------
console.log(
  `\n=== 2. Warm picker waterfall (daemon healthy, ${RUNS} runs) ===`,
);
await ensureDaemonUp();
for (const [name, runner] of runners) {
  const parallelInit: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { marks } = await runPickerOnce(runner, 10000);
    if (marks.total === undefined) {
      console.log(`${name} run ${i + 1}: no waterfall captured, skipping`);
      continue;
    }
    parallelInit.push(marks.parallel_init ?? 0);
    total.push(marks.total);
  }
  results.warm_picker[name] = { parallel_init: parallelInit, total };
  console.log(`${name.padEnd(8)} parallel_init ${fmtRuns(parallelInit)}`);
  console.log(`${"".padEnd(8)} total         ${fmtRuns(total)}`);
}

// ---- 3. Cold daemon boot ----------------------------------------------------
console.log(
  `\n=== 3. Cold daemon boot (spawn -> /health -> fully booted, ${RUNS} runs) ===`,
);
const DAEMON_LOG = "/tmp/ccmux-bench-daemon.log";
for (let i = 0; i < RUNS; i++) {
  await stopDaemon();
  rmSync(DAEMON_LOG, { force: true });
  const fd = openSync(DAEMON_LOG, "a");
  const t0 = performance.now();
  Bun.spawn([...SOURCE_RUNNER, "daemon", "start"], {
    cwd: ROOT,
    stdout: fd,
    stderr: fd,
  });
  const pidT = await waitUntil(() => existsSync(PID_FILE), 10000, 10);
  const healthT =
    (await waitUntil(() => healthOk(100), 20000, 20)) !== null
      ? performance.now() - t0
      : NaN;
  // "Daemon started" logs after hydration + the initial scan complete:
  // the daemon is serving full session data from this point.
  const fullT =
    (await waitUntil(
      () =>
        readFileSync(DAEMON_LOG, "utf-8").includes("Daemon started with PID"),
      30000,
      25,
    )) !== null
      ? performance.now() - t0
      : NaN;
  closeSync(fd);
  results.cold_daemon.pid_file_ms.push(pidT ?? NaN);
  results.cold_daemon.health_ms.push(healthT);
  results.cold_daemon.full_boot_ms.push(fullT);
  console.log(
    `run ${i + 1}: pid_file ${Math.round(pidT ?? NaN)}ms, health ${Math.round(healthT)}ms, full_boot ${Math.round(fullT)}ms`,
  );
}
console.log(
  `health median: ${Math.round(median(results.cold_daemon.health_ms))}ms, full_boot median: ${Math.round(median(results.cold_daemon.full_boot_ms))}ms`,
);

// ---- 4. Cold picker (auto-start race) ---------------------------------------
const coldPickerRuns = Math.min(RUNS, 3);
console.log(
  `\n=== 4. Cold picker (daemon dead at launch, ${coldPickerRuns} runs) ===`,
);
for (let i = 0; i < coldPickerRuns; i++) {
  await stopDaemon();
  const t0 = performance.now();
  const { marks, failed } = await runPickerOnce(SOURCE_RUNNER, 20000);
  const elapsed = performance.now() - t0;
  const outcome = failed
    ? "FAILED (gave up before daemon healthy)"
    : marks.total !== undefined
      ? "ok"
      : "no output";
  results.cold_picker.push({
    outcome,
    elapsed_ms: Math.round(elapsed),
    total_mark: marks.total ?? null,
  });
  console.log(
    `run ${i + 1}: ${outcome}, wall ${Math.round(elapsed)}ms` +
      (marks.total !== undefined ? `, waterfall total ${marks.total}ms` : ""),
  );
  // the spawned daemon may still be booting; let it finish before next cycle
  await waitUntil(() => healthOk(100), 20000, 100);
}

// ---- save -------------------------------------------------------------------
await ensureDaemonUp();
const outDir = join(ROOT, "scripts", "bench-results");
mkdirSync(outDir, { recursive: true });
const outFile = join(
  outDir,
  `${LABEL}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
);
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nResults saved to ${outFile}`);
console.log("Daemon restarted and healthy.");
