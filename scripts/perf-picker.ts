#!/usr/bin/env bun
/**
 * Focused startup benchmark for the ccmux PICKER ONLY.
 * 
 * This measures the exact path a user experiences when pressing the
 * ccmux hotkey: bun parsing → TUI import → framework init → first paint.
 *
 * Run: bun scripts/perf-picker.ts [--runs N]
 *
 * The script:
 *   1. Ensures the daemon is healthy (so daemon-start isn't on the hot path)
 *   2. Launches the picker in a detached tmux session
 *   3. Captures the CCMUX_PERF waterfall
 *   4. Kills the session
 * 
 * Output: A summary table and a JSON result file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PERF_LOG = "/tmp/ccmux-perf-picker.log";
const TMUX_SESSION = "ccmux-perf";
const HEALTH_URL = "http://127.0.0.1:2269/health";
const RESULT_DIR = join(import.meta.dir, "perf-results");

const args = process.argv.slice(2);
const RUNS = parseInt(args[args.indexOf("--runs") + 1] || "", 10) || 5;
const TAG = process.env.CCMUX_PERF_TAG || "current";

// ── Utilities ─────────────────────────────────────────────────
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p50(xs: number[]): string {
  return `${Math.round(median(xs))}ms`;
}
function pMin(xs: number[]): string {
  return `${Math.round(Math.min(...xs))}ms`;
}
function avg(xs: number[]): string {
  return `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms`;
}

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function healthOk(timeoutMs = 200): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch { return false; }
}

async function waitUntil(
  pred: () => Promise<boolean> | boolean,
  maxMs: number,
  stepMs = 30,
): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    if (await pred()) return true;
    await Bun.sleep(stepMs);
  }
  return false;
}

function parseWaterfall(text: string): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const m of text.matchAll(/\[startup\] (\w+)\s+(\d+)ms/g)) {
    marks[m[1]] = parseInt(m[2], 10);
  }
  return marks;
}

// ── Ensure daemon is up ────────────────────────────────────────
console.log("[perf] Checking daemon health...");
if (!(await healthOk())) {
  console.log("[perf] Starting daemon...");
  Bun.spawn(["bun", join(ROOT, "src/index.ts"), "daemon", "start"], {
    cwd: ROOT,
    stdout: Bun.file("/dev/null"),
    stderr: Bun.file("/dev/null"),
  });
  await waitUntil(() => healthOk(), 20000);
  if (!(await healthOk())) {
    console.error("[perf] ERROR: Daemon failed to start");
    process.exit(1);
  }
  console.log("[perf] Daemon healthy.");
}

// ── Benchmark: picker launch ──────────────────────────────────
console.log(`\n[perf] Running ${RUNS} picker launches...\n`);

interface WaterfallResult {
  marks: Record<string, number>;
  failed: boolean;
  log: string;
}

async function runPickerOnce(): Promise<WaterfallResult> {
  rmSync(PERF_LOG, { force: true });
  
  // Launch detached tmux session with the picker
  const cmd = `CCMUX_PERF=1 ${["bun", join(ROOT, "src/index.ts"), "picker"].join(" ")} 2>${PERF_LOG}`;
  
  await sh([
    "tmux", "new-session", "-d", "-s", TMUX_SESSION,
    "-x", "200", "-y", "50",
    cmd,
  ]);
  
  // Wait for waterfall output or failure
  const done = await waitUntil(() => {
    if (!existsSync(PERF_LOG)) return false;
    const log = readFileSync(PERF_LOG, "utf-8");
    return log.includes("[startup] total") || log.includes("Failed");
  }, 15000);
  
  const log = existsSync(PERF_LOG) ? readFileSync(PERF_LOG, "utf-8") : "";
  
  // Send 'q' to quit the picker
  if (done) {
    await sh(["tmux", "send-keys", "-t", TMUX_SESSION, "q"]);
  }
  await Bun.sleep(300);
  
  // Cleanup
  try { await sh(["tmux", "kill-session", "-t", TMUX_SESSION]); } catch {}
  
  return {
    marks: parseWaterfall(log),
    failed: !done || log.includes("Failed"),
    log,
  };
}

// Results collection
const allWaterfalls: WaterfallResult[] = [];
const marksAccum: Record<string, number[]> = {};

for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`  Run ${i + 1}/${RUNS} ... `);
  const result = await runPickerOnce();
  allWaterfalls.push(result);
  
  if (result.failed || !result.marks.total) {
    console.log("FAILED");
    continue;
  }
  
  for (const [key, val] of Object.entries(result.marks)) {
    if (!marksAccum[key]) marksAccum[key] = [];
    marksAccum[key].push(val);
  }
  
  const t = result.marks.total;
  const pi = result.marks.parallel_init ?? 0;
  const fd = result.marks.first_data ?? 0;
  console.log(`total=${t}ms  parallel_init=${pi}ms  first_data=${fd}ms`);
}

// ── Report ─────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  PICKER STARTUP WATERFALL SUMMARY                    ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

if (Object.keys(marksAccum).length === 0) {
  console.log("  No successful runs captured.");
  process.exit(1);
}

const orderedKeys = [
  "cli_parse", "parallel_init", "daemon_ready", 
  "render_start", "store_created", "sse_connected", "first_data", "total"
];

console.log("  Phase              p50       min       avg");
console.log("  ─────────────────  ────────  ────────  ────────");

for (const key of orderedKeys) {
  const xs = marksAccum[key];
  if (!xs || xs.length === 0) continue;
  console.log(`  ${key.padEnd(18)}  ${p50(xs).padStart(7)}  ${pMin(xs).padStart(7)}  ${avg(xs).padStart(7)}`);
}

// ── Breakdown (deltas between phases) ─────────────────────────
console.log("\n  ── Phase deltas ──");
const phases = ["cli_parse", "parallel_init", "daemon_ready", "render_start", "store_created", "sse_connected", "first_data"];
for (let i = 1; i < phases.length; i++) {
  const prev = phases[i - 1];
  const curr = phases[i];
  const prevXs = marksAccum[prev];
  const currXs = marksAccum[curr];
  if (!prevXs || !currXs) continue;
  const delta = median(currXs) - median(prevXs);
  const name = `${prev} → ${curr}`;
  console.log(`  ${name.padEnd(30)} ${String(delta).padStart(5)}ms`);
}

// ── Save results ───────────────────────────────────────────────
const result = {
  tag: TAG,
  date: new Date().toISOString(),
  runs: RUNS,
  successful: allWaterfalls.filter((r) => !r.failed && r.marks.total).length,
  medians: Object.fromEntries(
    Object.entries(marksAccum).map(([k, v]) => [k, median(v)])
  ),
  raw: allWaterfalls
    .filter((r) => r.marks.total)
    .map((r) => r.marks),
};

mkdirSync(RESULT_DIR, { recursive: true });
const outFile = join(
  RESULT_DIR,
  `${TAG}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
);
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\n  Results saved: ${outFile}`);
