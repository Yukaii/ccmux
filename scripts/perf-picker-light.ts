#!/usr/bin/env bun
/**
 * Benchmark the lightweight picker startup time.
 * 
 * Usage: bun scripts/perf-picker-light.ts [--runs N]
 * 
 * Compared to scripts/perf-picker.ts which benchmarks the full TUI picker,
 * this tests the raw-ANSI picker at src/picker-light/main.ts.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PERF_LOG = "/tmp/ccmux-perf-light.log";
const TMUX_SESSION = "ccmux-perf-light";
const HEALTH_URL = "http://127.0.0.1:2269/health";
const RESULT_DIR = join(import.meta.dir, "perf-results");

const args = process.argv.slice(2);
const RUNS = parseInt(args[args.indexOf("--runs") + 1] || "", 10) || 5;

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
console.log("[perf-light] Checking daemon health...");
if (!(await healthOk())) {
  console.log("[perf-light] Starting daemon...");
  Bun.spawn(["bun", join(ROOT, "src/index.ts"), "daemon", "start"], {
    cwd: ROOT,
    stdout: Bun.file("/dev/null"),
    stderr: Bun.file("/dev/null"),
  });
  await waitUntil(() => healthOk(), 20000);
  if (!(await healthOk())) {
    console.error("[perf-light] ERROR: Daemon failed to start");
    process.exit(1);
  }
  console.log("[perf-light] Daemon healthy.");
}

// ── Benchmark light picker ─────────────────────────────────────
console.log(`\n[perf-light] Running ${RUNS} light picker launches...\n`);

const marksAccum: Record<string, number[]> = {};

for (let i = 0; i < RUNS; i++) {
  rmSync(PERF_LOG, { force: true });
  
  const pickerPath = join(ROOT, "src/picker-light/main.ts");
  const cmd = `CCMUX_PERF=1 bun ${pickerPath} 2>${PERF_LOG}`;
  
  process.stdout.write(`  Run ${i + 1}/${RUNS} ... `);
  
  // Launch in detached tmux session so we can read keystrokes
  await sh([
    "tmux", "new-session", "-d", "-s", TMUX_SESSION,
    "-x", "200", "-y", "50",
    cmd,
  ]);
  
  // Wait for the picker to render, then quit
  const started = await waitUntil(() => {
    if (!existsSync(PERF_LOG)) return false;
    const log = readFileSync(PERF_LOG, "utf-8");
    return log.includes("[startup] first_render") || log.includes("Error");
  }, 5000);
  
  if (started) {
    // Send 'q' to quit
    await sh(["tmux", "send-keys", "-t", TMUX_SESSION, "q"]);
    await Bun.sleep(200);
  }
  
  const log = existsSync(PERF_LOG) ? readFileSync(PERF_LOG, "utf-8") : "";
  
  // Cleanup tmux session
  try { await sh(["tmux", "kill-session", "-t", TMUX_SESSION]); } catch {}
  
  const marks = parseWaterfall(log);
  if (marks.first_render) {
    for (const [key, val] of Object.entries(marks)) {
      if (!marksAccum[key]) marksAccum[key] = [];
      marksAccum[key].push(val);
    }
    console.log(`first_render=${marks.first_render}ms  total=${marks.total || marks.first_render}ms`);
  } else if (log.includes("Error")) {
    console.log(`ERROR: ${log.split("\n").find(l => l.startsWith("Error")) || log.slice(0, 80)}`);
  } else {
    console.log("NO OUTPUT");
    if (log.trim()) {
      console.log(`  log: ${log.slice(0, 200)}`);
    }
  }
}

// ── Report ─────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  LIGHT PICKER STARTUP SUMMARY                        ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

if (Object.keys(marksAccum).length === 0) {
  console.log("  No successful runs captured.");
  process.exit(1);
}

const orderedKeys = [
  "start", "health_check", "fetch_sessions", "terminal_ready", "first_render", "total"
];

console.log("  Phase               p50       min       avg");
console.log("  ────────────────  ────────  ────────  ────────");

for (const key of orderedKeys) {
  const xs = marksAccum[key];
  if (!xs || xs.length === 0) continue;
  console.log(`  ${key.padEnd(16)}  ${p50(xs).padStart(7)}  ${pMin(xs).padStart(7)}  ${avg(xs).padStart(7)}`);
}

// ── Save ───────────────────────────────────────────────────────
const result = {
  tag: "picker-light",
  date: new Date().toISOString(),
  runs: RUNS,
  successful: Object.keys(marksAccum).length > 0 ? RUNS : 0,
  medians: Object.fromEntries(
    Object.entries(marksAccum).map(([k, v]) => [k, median(v)])
  ),
};

mkdirSync(RESULT_DIR, { recursive: true });
const outFile = join(
  RESULT_DIR,
  `picker-light-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
);
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\n  Results saved: ${outFile}`);
