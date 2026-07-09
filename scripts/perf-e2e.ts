#!/usr/bin/env bun
/**
 * End-to-end wall-time benchmark for the picker.
 * Measures: from "user presses hotkey" to "picker is ready for input".
 */

import { join } from "path";
import { rmSync, existsSync, readFileSync } from "fs";

const ROOT = join(import.meta.dir, "..");
const TMUX_SESSION = "ccmux-e2e";
const READY_FILE = "/tmp/ccmux-e2e-ready";
const RUNS = 10;

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function healthOk(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:2269/health", {
      signal: AbortSignal.timeout(200),
    });
    return res.ok;
  } catch { return false; }
}

async function waitUntil(
  pred: () => boolean,
  maxMs: number,
  stepMs = 20,
): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    if (pred()) return true;
    await Bun.sleep(stepMs);
  }
  return false;
}

// Ensure daemon
if (!(await healthOk())) {
  Bun.spawn(["bun", join(ROOT, "src/index.ts"), "daemon", "start"], {
    cwd: ROOT, stdout: "ignore", stderr: "ignore",
  });
  await waitUntil(() => healthOk(), 20000);
}

interface E2EResult {
  label: string;
  times: number[];
}

async function e2eBench(label: string, cmd: string): Promise<E2EResult> {
  const times: number[] = [];

  for (let i = 0; i < RUNS; i++) {
    rmSync(READY_FILE, { force: true });

    // The wrapper: run the picker, write a "ready" file when first_render happens
    const wrapper = `CCMUX_PERF=1 ${cmd} 2>${READY_FILE}`;

    const t0 = performance.now();

    // Launch in detached tmux
    await sh([
      "tmux", "new-session", "-d", "-s", TMUX_SESSION,
      "-x", "200", "-y", "50",
      wrapper,
    ]);

    // Wait for the ready signal
    const ok = await waitUntil(() => {
      if (!existsSync(READY_FILE)) return false;
      const log = readFileSync(READY_FILE, "utf-8");
      return log.includes("[startup] first_render") || log.includes("Error");
    }, 5000);

    const elapsed = performance.now() - t0;

    // Send quit
    if (ok) {
      await sh(["tmux", "send-keys", "-t", TMUX_SESSION, "q"]);
      await Bun.sleep(150);
    }
    try { await sh(["tmux", "kill-session", "-t", TMUX_SESSION]); } catch {}
    await Bun.sleep(100);

    if (ok) {
      times.push(elapsed);
      if (i === 0) process.stdout.write(`  ${label}: `);
      process.stdout.write(`${Math.round(elapsed)} `);
    }
  }
  process.stdout.write("\n");
  return { label, times };
}

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║  END-TO-END WALL TIME (${RUNS} runs)                       ║`);
console.log(`╚══════════════════════════════════════════════════════╝\n`);

// Light picker direct
const light = await e2eBench(
  "light (direct)   ",
  `bun ${join(ROOT, "src/picker-light/main.ts")}`,
);

// Light picker via bin/ccmux
const bin = await e2eBench(
  "light (bin/ccmux) ",
  `${join(ROOT, "bin/ccmux")} picker`,
);

// Old full path (bun src/index.ts picker) — now delegates, so this
// includes the cost of loading all 15 commander modules first
const oldFull = await e2eBench(
  "full src/index.ts ",
  `bun ${join(ROOT, "src/index.ts")} picker`,
);

console.log(`\n  ${"Path".padEnd(20)} ${"p50".padStart(7)} ${"min".padStart(7)} ${"max".padStart(7)}`);
console.log(`  ${"─".repeat(20)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)}`);

for (const r of [light, oldFull, bin]) {
  if (r.times.length === 0) continue;
  const m = Math.round(median(r.times));
  const min = Math.round(Math.min(...r.times));
  const max = Math.round(Math.max(...r.times));
  console.log(`  ${r.label.padEnd(20)} ${String(m).padStart(6)}ms ${String(min).padStart(6)}ms ${String(max).padStart(6)}ms`);
}

// Compare against the original (pre-optimization) measurement
console.log(`\n  ── Comparison ──`);
console.log(`  Original (pre-optimization):  ~326ms median (internal mark)`);
console.log(`  Original (pre-optimization):  ~938ms end-to-end wall time (cold picker)`);

const lightP50 = light.times.length > 0 ? Math.round(median(light.times)) : 0;
if (lightP50 > 0) {
  console.log(`  New light picker:              ${lightP50}ms end-to-end wall time`);
  console.log(`  Speedup:                       ~${(938 / lightP50).toFixed(1)}x vs cold, ~${(326 / lightP50).toFixed(1)}x vs warm`);
}
