#!/usr/bin/env bun
/**
 * In-process import cost measurement for ccmux.
 * Run: bun scripts/perf-imports.ts
 */
const ROOT = new URL("..", import.meta.url).pathname;
const RUNS = 10;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function p50(xs: number[]): string {
  return `${Math.round(median(xs))}ms`;
}

function avg(xs: number[]): string {
  return `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}ms`;
}

function benchSync(label: string, fn: () => void, runs = RUNS) {
  Bun.gc(true);
  const times: number[] = [];
  for (let i = 0; i < runs + 1; i++) {
    if (i === 0) { fn(); continue; } // warm
    const t = Bun.nanoseconds();
    fn();
    times.push((Bun.nanoseconds() - t) / 1_000_000);
  }
  console.log(`${label.padEnd(42)} min=${Math.round(Math.min(...times))}ms  p50=${p50(times)}  avg=${avg(times)}`);
}

async function benchAsync(label: string, fn: () => Promise<void>, runs = RUNS) {
  Bun.gc(true);
  const times: number[] = [];
  for (let i = 0; i < runs + 1; i++) {
    if (i === 0) { await fn(); continue; }
    const t = Bun.nanoseconds();
    await fn();
    times.push((Bun.nanoseconds() - t) / 1_000_000);
  }
  console.log(`${label.padEnd(42)} min=${Math.round(Math.min(...times))}ms  p50=${p50(times)}  avg=${avg(times)}`);
}

console.log("=== Eager import costs (static imports, in-process, after warm) ===\n");

// These are all already loaded by this point, so we measure re-import from cache
// The real cost is the FIRST import. We use dynamic import for fresh measurement.

async function measureDynamic(label: string, importPath: string, runs = RUNS) {
  // Clear module cache between runs by using require + delete
  // Actually, Bun doesn't expose delete easily. Use subprocess instead.
  // Better: measure via inline eval with fresh context.
}

// Let's do it differently — measure the cost within a fresh subprocess
// by creating temp scripts that just import one thing and do nothing else.
// This gives us the "how much does this module add on top of Bun bootstrap".

async function measureImportCost(label: string, code: string, runs = 5) {
  const tmpFile = `/tmp/ccmux-import-${Math.random().toString(36).slice(2)}.ts`;
  await Bun.write(tmpFile, code);
  const times: number[] = [];
  for (let i = 0; i < runs + 1; i++) {
    if (i === 0) {
      try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
      continue;
    }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${label.padEnd(42)} min=${Math.round(Math.min(...times))}ms  p50=${p50(times)}  avg=${avg(times)}`);
}

// Baseline: empty script
await measureImportCost("empty", "1+1");

// Just config (small, fs only)
await measureImportCost("lib/config", `
import { join } from "path";
import { homedir } from "os";
const CLAUDE_DIR = join(homedir(), ".claude");
1+1;
`);

// Commander
await measureImportCost("commander", `
import { Command } from "commander";
new Command().name("x");
1+1;
`);

// solid-js
await measureImportCost("solid-js", `
import { createSignal } from "solid-js";
1+1;
`);

// @opentui/core
await measureImportCost("@opentui/core", `
import { CliRenderer } from "@opentui/core";
1+1;
`);

// @opentui/solid (depends on both solid-js and @opentui/core)
await measureImportCost("@opentui/solid", `
import { render } from "@opentui/solid";
1+1;
`);

// fuzzysort
await measureImportCost("fuzzysort", `
import fuzzysort from "fuzzysort";
1+1;
`);

// Full src/index.ts
await measureImportCost("src/index.ts (ALL)", `
import "${ROOT}src/index.ts";
1+1;
`);

// Full src/tui/index.tsx (the TUI)
await measureImportCost("src/tui/index.tsx", `
import "${ROOT}src/tui/index.tsx";
1+1;
`);

// commander + single command (not all 15)
await measureImportCost("commander + 1 cmd", `
import { Command } from "commander";
import { createPickerCommand } from "${ROOT}src/commands/picker";
new Command().addCommand(createPickerCommand(), { isDefault: true });
1+1;
`);

// Compare: a raw ANSI-based picker (tmux-palette style)
// Just the fuzzy + render modules, no TUI framework
await measureImportCost("tmux-palette style (fuzzy only)", `
import fuzzysort from "fuzzysort";
// No TUI framework, no solid-js
1+1;
`);

console.log("\n=== Key findings ===");
console.log("The delta above 'empty' baseline is the import cost for each module.");

// Now let's also compare full ccmux picker TUI vs a hypothetical minimal one
console.log("\n=== Startup waterfall from CCMUX_PERF ===");
console.log("(run: CCMUX_PERF=1 bun src/index.ts picker inside tmux)");
