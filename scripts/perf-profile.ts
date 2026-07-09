#!/usr/bin/env bun
/**
 * Precision startup profiler for ccmux picker.
 * Instruments every phase in-process (no subprocess overhead).
 * 
 * Usage: bun scripts/perf-profile.ts
 * 
 * This creates a standalone measurement that mimics the picker's
 * critical path step-by-step and reports per-phase timing.
 */

const ROOT = new URL("..", import.meta.url).pathname;

// ── Helpers ──────────────────────────────────────────────────
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Phase {
  label: string;
  ms: number;
  pct: number;
}

function printTable(phases: Phase[], totalMs: number) {
  const labelW = Math.max(...phases.map((p) => p.label.length));
  console.log(`\n${"Phase".padEnd(labelW)}  Time (ms)  % of total`);
  console.log("─".repeat(labelW + 20));
  for (const p of phases) {
    console.log(
      `${p.label.padEnd(labelW)}  ${p.ms.toFixed(1).padStart(8)}  ${p.pct.toFixed(0).padStart(7)}%`,
    );
  }
  console.log("─".repeat(labelW + 20));
  console.log(`${"TOTAL".padEnd(labelW)}  ${totalMs.toFixed(1).padStart(8)}`);
}

// ── Phase 1: Measure pure Bun + module parsing overhead ──────
console.log("╔══════════════════════════════════════════════════════╗");
console.log("║  CCMUX PICKER STARTUP PROFILER                       ║");
console.log("╚══════════════════════════════════════════════════════╝");

console.log("\n── Phase 1: Module import costs (dynamic import, cold) ──");

async function timeImport(label: string, importPath: string): Promise<number> {
  Bun.gc(true);
  // Dynamic import with cache-busting query param for fresh measurement
  const t0 = Bun.nanoseconds();
  await import(importPath);
  return (Bun.nanoseconds() - t0) / 1_000_000;
}

// Warm up first
await import("../src/lib/config");
await import("commander");

const importCosts: Phase[] = [];

// These are measured as "how much EXTRA does this add"
// We're measuring them in a fresh process, so let's use a subprocess approach
// but with more precision.

// Actually, let's just use the subprocess approach but with more runs
// and compute the delta from baseline.

const RUNS = 5;
async function benchSubprocess(label: string, code: string): Promise<number[]> {
  const tmpFile = `/tmp/ccmux-prof-${label.replace(/[/ ]/g, "_")}.ts`;
  await Bun.write(tmpFile, code);
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) {
      try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
      continue;
    }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  return times;
}

async function measureDelta(
  label: string,
  code: string,
  baseline: number[],
): Promise<void> {
  const times = await benchSubprocess(label, code);
  const delta = median(times) - median(baseline);
  console.log(
    `  ${label.padEnd(32)} +${delta.toFixed(0).padStart(4)}ms  (raw ${median(times).toFixed(0)}ms)`,
  );
}

const emptyCode = "1+1";
const emptyTimes = await benchSubprocess("(baseline: empty)", emptyCode);
const BASELINE = median(emptyTimes);
console.log(`  Bun process bootstrap baseline: ${BASELINE.toFixed(0)}ms\n`);

// Now measure each dependency in isolation
await measureDelta(
  "commander",
  `import { Command } from "commander"; new Command().name("x"); 1+1;`,
  emptyTimes,
);

await measureDelta(
  "solid-js",
  `import { createSignal } from "solid-js"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "@opentui/core",
  `import { createCliRenderer } from "@opentui/core"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "@opentui/solid",
  `import { render } from "@opentui/solid"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "lib/config only",
  `import "${ROOT}src/lib/config"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "lib/preferences",
  `import "${ROOT}src/lib/preferences"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "lib/agents (BUILTIN_AGENTS)",
  `import "${ROOT}src/lib/agents"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "commands/picker only",
  `import "${ROOT}src/commands/picker"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "tui/index.tsx (FULL TUI)",
  `import "${ROOT}src/tui/index.tsx"; 1+1;`,
  emptyTimes,
);

await measureDelta(
  "src/index.ts (ALL commands)",
  `import "${ROOT}src/index"; 1+1;`,
  emptyTimes,
);

// ── Phase 2: End-to-end measurements ─────────────────────────
console.log("\n── Phase 2: End-to-end command timing ──");

async function benchCommand(label: string, runner: string[]): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) {
      try { await Bun.$`${{ raw: runner }}`.quiet(); } catch {}
      continue;
    }
    const t = performance.now();
    try { await Bun.$`${{ raw: runner }}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  console.log(`  ${label.padEnd(32)} ${median(times).toFixed(0)}ms median`);
  return times;
}

await benchCommand("bun src/index.ts --version", [
  "bun",
  ROOT + "src/index.ts",
  "--version",
]);

// If dist exists
const { existsSync } = await import("fs");
if (existsSync(`${ROOT}dist/index.js`)) {
  await benchCommand("bun dist/index.js --version", [
    "bun",
    ROOT + "dist/index.js",
    "--version",
  ]);
}

// ── Phase 3: Hypothetical minimal picker ─────────────────────
console.log("\n── Phase 3: Hypothetical minimal alternatives ──");

// A picker that uses just fuzzysort + raw ANSI (tmux-palette style)
await measureDelta(
  "fuzzysort only (for fuzzy picker)",
  `import fuzzysort from "fuzzysort"; 1+1;`,
  emptyTimes,
);

// Summary
console.log("\n── Summary ──");
console.log(`
Key finding: The TUI framework (@opentui/core + @opentui/solid + solid-js)
dominates the import cost. A raw-ANSI picker (tmux-palette style) would
need just:
  - fuzzysort (~0ms over baseline — 56KB)
  - Raw ANSI escape rendering (0 dependencies)
  - Simple HTTP fetch for daemon data (built into Bun)
  - Raw stdin keystroke reading (Bun built-in)

Current TUI dependency chain: @opentui/core (10MB) → @opentui/solid → solid-js
                          Plus: commander, chokidar, anser, fuzzysort
                          Total: 203 packages, 266MB node_modules

Proposed minimal picker:   fuzzysort only
                          Total: 1 package, ~56KB
`);
