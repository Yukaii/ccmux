/**
 * Bench the log-tree watcher's coalesced-event reconcile cost on a large
 * synthetic tree (mirrors ~/.claude/projects at session-heavy scale).
 *
 * The cheap path (FSEvents names the appended file directly) is already
 * one statSync. This bench targets the EXPENSIVE paths that fire when a
 * burst coalesces into a parent-dir or root event:
 *   - handleEvent(null): walk(root) + sweep(root) over the whole
 *     tree, with NOTHING changed. This is the pure-waste worst case — the
 *     CPU a single coalesced root event burns to discover nothing happened.
 *   - handleEvent(<projectDir>): walk(dir) + sweep(dir) for one
 *     subtree (the common directory-coalesced case).
 *   - handleEvent(<file>): the cheap `change` path, for contrast.
 *
 * Usage: bun scripts/bench-log-tree.ts [projects] [filesPerProject] [depth]
 * Defaults: 400 projects x 25 files = 10,000 files, unbounded depth.
 * Pass depth=1 to mirror Claude's real watchDepth (subagents dirs excluded).
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { createLogTreeWatcher } from "../src/daemon/log-tree-watcher";

const NPROJ = Number(process.argv[2] ?? 400);
const NFILES = Number(process.argv[3] ?? 25);
const DEPTH =
  process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const ITERS = 21; // odd -> clean median

interface HandleEventWatcher {
  handleEvent(relPath: string | null): void;
  close(): Promise<void>;
}

function buildTree(root: string): {
  totalFiles: number;
  sampleDir: string;
  sampleFile: string;
} {
  let totalFiles = 0;
  let sampleDir = "";
  let sampleFile = "";
  for (let p = 0; p < NPROJ; p++) {
    // Mirror Claude's encoded-path project dir name shape.
    const proj = join(root, `-Users-dev-code-project-${p}`);
    mkdirSync(proj);
    for (let f = 0; f < NFILES; f++) {
      const file = join(proj, `session-${f}-abcdef0123456789.jsonl`);
      writeFileSync(file, '{"type":"summary"}\n');
      totalFiles++;
      if (p === Math.floor(NPROJ / 2) && f === 0) {
        sampleDir = proj;
        sampleFile = file;
      }
    }
    // A subagents subdir, as Claude writes for subagent transcripts.
    const sub = join(proj, "subagents");
    mkdirSync(sub);
    writeFileSync(join(sub, "agent-0.jsonl"), '{"type":"summary"}\n');
    totalFiles++;
  }
  return { totalFiles, sampleDir, sampleFile };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeIt(label: string, iters: number, fn: () => void): number {
  // One warm-up pass (prime FS cache) excluded from the measurement.
  fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const med = median(samples);
  console.log(
    `  ${label.padEnd(38)} median ${med.toFixed(2)}ms  (min ${Math.min(...samples).toFixed(2)} / max ${Math.max(...samples).toFixed(2)})`,
  );
  return med;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccmux-bench-tree-"));
  try {
    console.log(
      `Building synthetic tree: ${NPROJ} projects x ${NFILES} files ...`,
    );
    const { totalFiles, sampleDir, sampleFile } = buildTree(root);
    console.log(`Tree: ${totalFiles} files under ${root}\n`);

    // Depth undefined = unbounded, the full-stress case. The real Claude
    // adapter uses a finite watchDepth, so unbounded is an upper bound.
    console.log(`watchDepth: ${DEPTH === undefined ? "unbounded" : DEPTH}\n`);
    const watcher = createLogTreeWatcher(
      root,
      DEPTH,
    ) as unknown as HandleEventWatcher;
    // Wait for the initial walk + ready so `known` is fully populated.
    await new Promise<void>((resolve) => {
      (watcher as unknown as { on(e: string, cb: () => void): void }).on(
        "ready",
        () => resolve(),
      );
    });

    const dirRel = sampleDir.slice(root.length + 1);
    const fileRel = sampleFile.slice(root.length + 1);

    console.log(`Reconcile cost (nothing changed), ${ITERS} iters:`);
    const tNull = timeIt("handleEvent(null)  [root walk+sweep]", ITERS, () =>
      watcher.handleEvent(null),
    );
    const tDir = timeIt("handleEvent(projectDir) [subtree]", ITERS, () =>
      watcher.handleEvent(dirRel),
    );
    const tFile = timeIt("handleEvent(file)  [cheap change]", ITERS, () =>
      watcher.handleEvent(fileRel),
    );

    // Attribute the root cost: a bare statSync over every file is what the
    // OLD whole-tree sweep paid on every event (the cost this change gates
    // away); a bare recursive readdir is what walk pays.
    let allFiles: string[] = [];
    {
      const collect = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const abs = join(d, e.name);
          if (e.isDirectory()) collect(abs);
          else allFiles.push(abs);
        }
      };
      collect(root);
    }
    console.log(`\nAttribution (${allFiles.length} files):`);
    timeIt("bare statSync over all files", ITERS, () => {
      for (const f of allFiles) statSync(f);
    });

    console.log(
      `\nSummary: a coalesced ROOT event burns ~${tNull.toFixed(1)}ms; a coalesced DIR event ~${tDir.toFixed(2)}ms; the cheap change path ~${tFile.toFixed(3)}ms.`,
    );
    console.log(
      `dir segments=${dirRel.split(sep).length}, file segments=${fileRel.split(sep).length}`,
    );

    await watcher.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
