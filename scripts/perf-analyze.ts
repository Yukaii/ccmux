#!/usr/bin/env bun
/**
 * Granular startup cost breakdown for ccmux.
 * Run: bun scripts/perf-analyze.ts
 * Measures import cost of each major module in isolation.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const RUNS = 5;

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

async function bench(label: string, fn: () => Promise<void>, runs = RUNS) {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Warm up run (not counted)
    if (i === 0) {
      try { await fn(); } catch {}
      continue;
    }
    const t = performance.now();
    try {
      await fn();
    } catch {
      // Some modules may fail outside proper context
    }
    times.push(performance.now() - t);
  }
  console.log(`${label.padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// Phase 1: Raw bun process bootstrap (no imports beyond node builtins)
console.log("=== Phase 1: Process bootstrap ===");
{
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { await Bun.$`bun -e "1+1"`.quiet(); continue; }
    const t = performance.now();
    await Bun.$`bun -e "1+1"`.quiet();
    times.push(performance.now() - t);
  }
  console.log(`${"bun -e \"1+1\"".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// Phase 2: Key module import costs (via subprocess to isolate)
console.log("\n=== Phase 2: Module import costs (isolated subprocess) ===");

const modules = [
  ["index.ts (all commands)", "src/index.ts"],
  ["commander only", "src/_isolated_commander.ts"],
  ["lib/config only", "src/lib/config.ts"],
  ["lib/preferences only", "src/lib/preferences.ts"],
  ["lib/agents only", "src/lib/agents.ts"],
  ["commands/picker (no TUI)", "src/commands/picker.ts"],
  ["tui/index.tsx (full TUI)", "src/tui/index.tsx"],
];

// Create temp import files for subprocess benchmarks
for (const [, mod] of modules) {
  // Skip if file doesn't exist (some are created below)
}

// Phase 3: Subprocess import timing
console.log("\n=== Phase 3: Subprocess import timing ===");

async function measureImport(entryFile: string, runs = RUNS) {
  const times: number[] = [];
  // Create a temp file that imports and prints "ok"
  const tmpFile = `/tmp/ccmux-perf-import-${Date.now()}.ts`;
  await Bun.write(tmpFile, `import "${join(ROOT, entryFile)}";\nconsole.log("ok");\n`);
  
  for (let i = 0; i < runs + 1; i++) {
    if (i === 0) {
      try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
      continue;
    }
    const t = performance.now();
    try {
      await Bun.$`bun ${tmpFile}`.quiet();
    } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  return times;
}

// 1. Empty import baseline
{
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { await Bun.$`bun -e "console.log(1)"`.quiet(); continue; }
    const t = performance.now();
    await Bun.$`bun -e "console.log(1)"`.quiet();
    times.push(performance.now() - t);
  }
  console.log(`${"bun -e (empty)".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 2. Just config/constants
{
  const times = await measureImport("src/lib/config.ts", RUNS);
  console.log(`${"lib/config".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 3. lib/preferences
{
  const times = await measureImport("src/lib/preferences.ts", RUNS);
  console.log(`${"lib/preferences".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 4. lib/agents (biggest raw data module)
{
  const times = await measureImport("src/lib/agents.ts", RUNS);
  console.log(`${"lib/agents".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 5. commander only (no commands registered)
{
  const times = await measureImport("src/lib/config.ts", RUNS); // tiny
  // Commander itself
  const tmpFile = `/tmp/ccmux-perf-import-commander.ts`;
  await Bun.write(tmpFile, `import { Command } from "commander";\nconst p = new Command();\np.name("test");\nconsole.log("ok");\n`);
  const times2: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}; continue; }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times2.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${"commander (standalone)".padEnd(40)} ${pMin(times2).padStart(6)}  (p50 ${p50(times2)})`);
}

// 6. SolidJS import
{
  const tmpFile = `/tmp/ccmux-perf-import-solid.ts`;
  await Bun.write(tmpFile, `import { createSignal } from "solid-js";\nconsole.log("ok");\n`);
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}; continue; }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${"solid-js (createSignal)".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 7. @opentui/solid
{
  const tmpFile = `/tmp/ccmux-perf-import-opentui.ts`;
  await Bun.write(tmpFile, `import { render } from "@opentui/solid";\nconsole.log("ok");\n`);
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}; continue; }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${"@opentui/solid".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 8. @opentui/core
{
  const tmpFile = `/tmp/ccmux-perf-import-core.ts`;
  await Bun.write(tmpFile, `import { CliRenderer } from "@opentui/core";\nconsole.log("ok");\n`);
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}; continue; }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile}`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${"@opentui/core".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// 9. Full index.ts import
{
  const times = await measureImport("src/index.ts", RUNS);
  console.log(`${"src/index.ts (full)".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// Phase 4: Measure --version from various entry paths
console.log("\n=== Phase 4: --version from different paths ===");

async function versionTiming(runner: string[], runs = RUNS) {
  const times: number[] = [];
  for (let i = 0; i < runs + 1; i++) {
    if (i === 0) { await Bun.$`${{ raw: [...runner, "--version"] }}`.quiet(); continue; }
    const t = performance.now();
    await Bun.$`${{ raw: [...runner, "--version"] }}`.quiet();
    times.push(performance.now() - t);
  }
  return times;
}

// Source (bun src/index.ts --version)
{
  const times = await versionTiming(["bun", join(ROOT, "src/index.ts")], RUNS);
  console.log(`${"bun src/index.ts --version".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// Build first, then test dist
console.log("\nBuilding dist...");
await Bun.$`cd ${ROOT} && bun run build`.quiet();
console.log("Build done.\n");

{
  const times = await versionTiming(["bun", join(ROOT, "dist/index.js")], RUNS);
  console.log(`${"bun dist/index.js --version".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// Pure node (compare)
{
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { await Bun.$`node -e "1+1"`.quiet(); continue; }
    const t = performance.now();
    await Bun.$`node -e "1+1"`.quiet();
    times.push(performance.now() - t);
  }
  console.log(`${"node -e (baseline)".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// What if we only import commander + a single command?
console.log("\n=== Phase 5: Hypothetical minimal picker ===");
{
  // Create a minimal picker that only imports what's needed
  const tmpFile = `/tmp/ccmux-perf-minimal.ts`;
  await Bun.write(tmpFile, `
import { Command } from "commander";
const p = new Command().name("minimal").version("0.0.0");
// No commands registered - just commander parsing
p.parse();
console.log("ok");
`.trim());
  const times: number[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    if (i === 0) { try { await Bun.$`bun ${tmpFile} --version`.quiet(); } catch {}; continue; }
    const t = performance.now();
    try { await Bun.$`bun ${tmpFile} --version`.quiet(); } catch {}
    times.push(performance.now() - t);
  }
  await Bun.$`rm -f ${tmpFile}`.quiet();
  console.log(`${"minimal commander --version".padEnd(40)} ${pMin(times).padStart(6)}  (p50 ${p50(times)})`);
}

// What about the actual ccmux --version built with a bundler optimizing away unused code?
// Already measured via dist above

console.log("\nDone.");
