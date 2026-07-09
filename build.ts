import solidPlugin from "@opentui/solid/bun-plugin";
import { mkdirSync, readdirSync, renameSync, rmSync, utimesSync } from "fs";
import { join } from "path";

// Build into a staging dir and rename into place, so concurrent readers
// never see a half-written file (rename is atomic).
const STAGING = "./dist/.staging";
rmSync(STAGING, { recursive: true, force: true });

const buildStart = new Date();

// ── Build the main CLI entry (full TUI, all commands) ────────
const mainResult = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "bun",
  outdir: STAGING,
  plugins: [solidPlugin],
});

if (!mainResult.success) {
  for (const log of mainResult.logs) console.error(log);
  process.exit(1);
}

mkdirSync("./dist", { recursive: true });

// ── Build the lightweight picker (no framework deps) ─────────
const pickerResult = await Bun.build({
  entrypoints: ["./src/picker-light/main.ts"],
  target: "bun",
  outdir: STAGING,
  // No solidPlugin — the light picker has no JSX/OpenTUI deps
  naming: "[dir]/picker-light.[ext]",
});

if (!pickerResult.success) {
  for (const log of pickerResult.logs) console.error(log);
  process.exit(1);
}

// Move files atomically (assets first, index.js/picker-light.js last)
const outputs = readdirSync(STAGING).sort((a, b) => {
  const aLast = a === "index.js" || a === "picker-light.js" ? 1 : 0;
  const bLast = b === "index.js" || b === "picker-light.js" ? 1 : 0;
  return aLast - bLast;
});
for (const file of outputs) {
  renameSync(join(STAGING, file), join("./dist", file));
}
utimesSync("./dist/index.js", buildStart, buildStart);
utimesSync("./dist/picker-light.js", buildStart, buildStart);
rmSync(STAGING, { recursive: true, force: true });

console.log("Build complete: dist/index.js, dist/picker-light.js");
