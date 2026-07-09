#!/usr/bin/env bun
/**
 * Head-to-head comparison: old picker vs new light picker.
 * 
 * Usage: bun scripts/perf-compare.ts [--runs N]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PERF_LOG = "/tmp/ccmux-perf-compare.log";
const TMUX_SESSION = "ccmux-cmp";
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

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function healthOk(timeoutMs = 200): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
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

// ── Ensure daemon up ───────────────────────────────────────────
if (!(await healthOk())) {
  Bun.spawn(["bun", join(ROOT, "src/index.ts"), "daemon", "start"], {
    cwd: ROOT, stdout: "ignore", stderr: "ignore",
  });
  await waitUntil(() => healthOk(), 20000);
}

interface RunResult {
  label: string;
  times: number[];
}

async function benchmark(label: string, cmdInTmux: string): Promise<RunResult> {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    rmSync(PERF_LOG, { force: true });
    
    process.stdout.write(`  ${label} run ${i + 1}/${RUNS} ... `);
    
    await sh([
      "tmux", "new-session", "-d", "-s", TMUX_SESSION,
      "-x", "200", "-y", "50",
      cmdInTmux,
    ]);
    
    const started = await waitUntil(() => {
      if (!existsSync(PERF_LOG)) return false;
      const log = readFileSync(PERF_LOG, "utf-8");
      return log.includes("[startup] total") || log.includes("[startup] first_render") || log.includes("Error");
    }, 8000);
    
    if (started) {
      await sh(["tmux", "send-keys", "-t", TMUX_SESSION, "q"]);
      await Bun.sleep(200);
    }
    
    const log = existsSync(PERF_LOG) ? readFileSync(PERF_LOG, "utf-8") : "";
    try { await sh(["tmux", "kill-session", "-t", TMUX_SESSION]); } catch {}
    
    const marks = parseWaterfall(log);
    // Use total for old picker, first_render for light picker
    const value = marks.total ?? marks.first_render;
    if (value) {
      times.push(value);
      console.log(`${value}ms`);
    } else if (log.includes("Error")) {
      console.log("ERROR");
      // Don't count this run
    } else {
      console.log("? (no mark)");
    }
  }
  return { label, times };
}

// ── Run comparison ──────────────────────────────────────────────
console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║  PICKER PERFORMANCE COMPARISON (${RUNS} runs each)          ║`);
console.log(`╚══════════════════════════════════════════════════════╝\n`);

// Old picker (via src/index.ts, which loads all commands + full TUI)
console.log(`── Old picker (bun src/index.ts picker) ──`);
const oldResult = await benchmark(
  "old",
  `CCMUX_PERF=1 bun ${join(ROOT, "src/index.ts")} picker 2>${PERF_LOG}`,
);

// New light picker (via direct src/picker-light/main.ts)
console.log(`\n── New light picker (bun src/picker-light/main.ts) ──`);
const newResult = await benchmark(
  "new-light",
  `CCMUX_PERF=1 bun ${join(ROOT, "src/picker-light/main.ts")} 2>${PERF_LOG}`,
);

// New light picker via bin/ccmux wrapper
console.log(`\n── New light picker via bin/ccmux ──`);
const binResult = await benchmark(
  "new-bin",
  `CCMUX_PERF=1 ${join(ROOT, "bin/ccmux")} picker 2>${PERF_LOG}`,
);

// ── Summary table ───────────────────────────────────────────────
console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║  RESULTS SUMMARY                                     ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`\n  ${"Variant".padEnd(20)} ${"p50".padStart(8)} ${"min".padStart(8)} ${"speedup".padStart(10)}`);
console.log(`  ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(10)}`);

const oldMedian = oldResult.times.length > 0 ? median(oldResult.times) : null;

for (const r of [oldResult, newResult, binResult]) {
  if (r.times.length === 0) {
    console.log(`  ${r.label.padEnd(20)} (no data)`);
    continue;
  }
  const m = median(r.times);
  const min = Math.min(...r.times);
  const speedup = oldMedian ? `${(oldMedian / m).toFixed(1)}x` : "-";
  console.log(`  ${r.label.padEnd(20)} ${String(Math.round(m)).padStart(7)}ms ${String(Math.round(min)).padStart(7)}ms ${speedup.padStart(10)}`);
}

// Save
const result = {
  date: new Date().toISOString(),
  runs: RUNS,
  old: { p50: oldMedian ? Math.round(oldMedian) : null, times: oldResult.times.map(Math.round) },
  new_light: { p50: newResult.times.length > 0 ? Math.round(median(newResult.times)) : null, times: newResult.times.map(Math.round) },
  new_bin: { p50: binResult.times.length > 0 ? Math.round(median(binResult.times)) : null, times: binResult.times.map(Math.round) },
  speedup: oldMedian && newResult.times.length > 0 ? (oldMedian / median(newResult.times)).toFixed(1) : null,
};

mkdirSync(RESULT_DIR, { recursive: true });
const outFile = join(
  RESULT_DIR,
  `comparison-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
);
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\n  Results saved: ${outFile}`);
