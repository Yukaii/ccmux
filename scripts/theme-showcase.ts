#!/usr/bin/env bun
/**
 * Reproducible theme-showcase montage for ccmux.
 *
 * Renders `ccmux picker` once per built-in theme via termctrl, composites each
 * capture onto that theme's own `base` color, labels it, and tiles them all
 * into a single PNG you can attach to a PR.
 *
 * The theme list and every per-theme color are read straight from the registry
 * (`src/tui/themes`), so adding or recoloring a theme is picked up automatically
 * with no edits here -- same self-maintaining principle as `themes.test.ts`.
 *
 * Usage:
 *   bun scripts/theme-showcase.ts [options]
 *
 * Options:
 *   --out <path>           Output PNG (default: $TMPDIR/ccmux-theme-showcase.png)
 *   --font-family <name>   Font for termctrl rendering. Default: portable mono
 *                          stack, or $CCMUX_SHOWCASE_FONT if set. For an exact
 *                          local match pass e.g. "DankMono Nerd Font Mono".
 *   --no-preview           Capture the list only (default shows the preview pane)
 *   --theme a,b,c          Subset of theme names (default: every built-in)
 *   --cols N / --rows N    Capture geometry (default 200x44, or 150x44 no-preview)
 *   --tile-cols N          Montage columns (default 2)
 *   --tile-width N         Downscaled tile width in the montage (default 1400)
 *   --keep                 Keep the per-theme temp tiles (for debugging)
 *
 * Requirements: a running ccmux daemon (the montage reflects LIVE sessions, so
 * its content is representative, not byte-stable), `termctrl` >= 0.3, and
 * ImageMagick (`magick`) on PATH.
 *
 * Known limitation: termctrl rasterizes via resvg, which does no per-glyph font
 * fallback and cannot draw color-emoji glyphs. A handful of codepoints absent
 * from the chosen font (e.g. Claude Code's transcript markers U+23FA / U+23BF in
 * the preview pane) render as tofu boxes here even though a real terminal shows
 * them via system fallback. ccmux's own UI icons are unaffected (termctrl draws
 * them as geometry). For a pixel-exact match, capture a real terminal instead.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BUILTIN_THEMES, BUILTIN_THEME_NAMES } from "../src/tui/themes";

// termctrl render defaults, kept explicit so the computed list/preview divider
// stays in lockstep with what termctrl actually rasterizes.
const CELL_W = 9;
const CELL_H = 18;
const PADDING = 18;
const PIXEL_RATIO = 2;
// termctrl's default frame background; resvg paints it opaque on empty cells, so
// we recolor exactly this value to each theme's base. Override if termctrl changes it.
const TERMCTRL_BG = "#0d1117";
// ccmux's default previewWidth (percent of width given to the preview pane).
const PREVIEW_WIDTH_PCT = 40;
const HEALTH_URL = "http://127.0.0.1:2269/health";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};
const int = (name: string, fallback: number): number => {
  const v = Number.parseInt(flag(name, String(fallback)), 10);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`Invalid value for ${name} (expected a positive integer)`);
    process.exit(1);
  }
  return v;
};

const PREVIEW = !has("--no-preview");
const OUT = flag("--out", join(tmpdir(), "ccmux-theme-showcase.png"));
const FONT = flag(
  "--font-family",
  process.env.CCMUX_SHOWCASE_FONT ??
    "JetBrains Mono, SFMono-Regular, Menlo, monospace",
);
const COLS = int("--cols", PREVIEW ? 200 : 150);
const ROWS = int("--rows", 44);
const TILE_COLS = int("--tile-cols", 2);
const TILE_WIDTH = int("--tile-width", 1400);
const KEEP = has("--keep");

const themeArg = flag("--theme", "");
const THEMES = themeArg
  ? themeArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : BUILTIN_THEME_NAMES;

const unknown = THEMES.filter((t) => !BUILTIN_THEMES[t]);
if (unknown.length) {
  console.error(`Unknown theme(s): ${unknown.join(", ")}`);
  console.error(`Available: ${BUILTIN_THEME_NAMES.join(", ")}`);
  process.exit(1);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/** Perceptual luminance (0..1) of a hex color; > 0.5 reads as a light theme. */
function isLight(hex: string): boolean {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** "tokyo-night-day" -> "Tokyo Night Day". */
function title(key: string): string {
  return key
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function run(cmd: string[], stdin?: Uint8Array): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin ?? "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd[0]} exited ${code}\n${err.trim()}`);
  }
}

async function daemonHealthy(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!(await daemonHealthy())) {
    console.error(
      "ccmux daemon is not responding on :2269. Start it (`ccmux daemon start`)\n" +
        "and make sure some sessions exist -- the montage renders the live picker.",
    );
    process.exit(1);
  }

  // Output pixel geometry (matches termctrl's: (cells*cell + 2*padding) * ratio)
  // and the list/preview divider, both derived rather than measured.
  const W = (COLS * CELL_W + 2 * PADDING) * PIXEL_RATIO;
  const H = (ROWS * CELL_H + 2 * PADDING) * PIXEL_RATIO;
  const listCols = Math.floor((COLS * (100 - PREVIEW_WIDTH_PCT)) / 100);
  const dividerX = Math.round((PADDING + listCols * CELL_W) * PIXEL_RATIO);

  const root = mkdtempSync(join(tmpdir(), "ccmux-showcase-home-"));
  const work = mkdtempSync(join(tmpdir(), "ccmux-showcase-tiles-"));
  const tiles: string[] = [];

  console.log(
    `Rendering ${THEMES.length} theme(s) at ${COLS}x${ROWS}` +
      `${PREVIEW ? " with preview" : " (list only)"}, font="${FONT}"`,
  );

  for (const name of THEMES) {
    const palette = BUILTIN_THEMES[name];
    if (!palette) continue; // already validated; satisfies the type guard
    const base = palette.semantic.base;
    const light = isLight(base);

    // Isolated CCMUX_HOME so we set theme/preview without touching real config.
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "ccmux.json"),
      // Pin previewWidth so the rendered list/preview split matches the
      // PREVIEW_WIDTH_PCT the crop math uses (no reliance on the store default).
      JSON.stringify({
        theme: name,
        showPreview: PREVIEW,
        previewWidth: PREVIEW_WIDTH_PCT,
      }),
    );

    const shot = join(work, `shot-${name}.png`);
    await run([
      "termctrl",
      "save",
      "--format",
      "png",
      "--out",
      shot,
      "--host",
      "opentui",
      "--cols",
      String(COLS),
      "--rows",
      String(ROWS),
      "--cell-width",
      String(CELL_W),
      "--cell-height",
      String(CELL_H),
      "--padding",
      String(PADDING),
      "--pixel-ratio",
      String(PIXEL_RATIO),
      "--font-family",
      FONT,
      "--hide-cursor",
      "--wait-for",
      "Sessions",
      "--settle-ms",
      "1100",
      "--deadline-ms",
      "8000",
      "--",
      "env",
      `CCMUX_HOME=${home}`,
      "ccmux",
      "picker",
      PREVIEW ? "--preview" : "--no-preview",
    ]);

    // Recolor termctrl's backdrop to the theme base. Dark themes recolor the
    // whole frame (preview content stays readable on a dark base). Light themes
    // with a preview pane are region-aware: only the list region takes the light
    // base, the preview pane keeps the neutral dark backdrop so the passthrough
    // agent output (which assumes a dark terminal) stays legible beside it.
    const tileBody = join(work, `body-${name}.png`);
    if (light && PREVIEW) {
      const left = join(work, `l-${name}.png`);
      const right = join(work, `r-${name}.png`);
      await run([
        "magick",
        shot,
        "-crop",
        `${dividerX}x${H}+0+0`,
        "+repage",
        "-fuzz",
        "0%",
        "-fill",
        base,
        "-opaque",
        TERMCTRL_BG,
        left,
      ]);
      await run([
        "magick",
        shot,
        "-crop",
        `${W - dividerX}x${H}+${dividerX}+0`,
        "+repage",
        right,
      ]);
      await run(["magick", left, right, "+append", tileBody]);
    } else {
      await run([
        "magick",
        shot,
        "-fuzz",
        "0%",
        "-fill",
        base,
        "-opaque",
        TERMCTRL_BG,
        tileBody,
      ]);
    }

    // Label banner: theme name in the theme's own text color, on its base.
    const [r, g, b] = hexRgb(palette.semantic.text);
    const label = `${title(name)}${light ? "  (light)" : ""}`;
    const banner = `\x1b[1;38;2;${r};${g};${b}m  ${label}\x1b[0m`;
    const lbl = join(work, `lbl-${name}.png`);
    await run(
      [
        "termctrl",
        "save",
        "--input",
        "-",
        "--format",
        "png",
        "--out",
        lbl,
        "--cols",
        String(COLS),
        "--rows",
        "1",
        "--cell-width",
        String(CELL_W),
        "--cell-height",
        String(CELL_H),
        "--padding",
        String(PADDING),
        "--pixel-ratio",
        String(PIXEL_RATIO),
        "--font-family",
        FONT,
        "--hide-cursor",
      ],
      new TextEncoder().encode(banner),
    );
    const lblc = join(work, `lblc-${name}.png`);
    await run([
      "magick",
      lbl,
      "-fuzz",
      "0%",
      "-fill",
      base,
      "-opaque",
      TERMCTRL_BG,
      lblc,
    ]);

    const tile = join(work, `tile-${name}.png`);
    await run([
      "magick",
      lblc,
      tileBody,
      "-background",
      base,
      "-gravity",
      "West",
      "-append",
      tile,
    ]);
    tiles.push(tile);
    const treatment = light
      ? PREVIEW
        ? "  (light, region-aware)"
        : "  (light)"
      : "";
    console.log(`  ${name}${treatment}`);
  }

  // Tile into the final montage. Labels are baked into each tile, so no text is
  // rendered here (`-label ""` avoids ImageMagick's font/ghostscript path).
  await run([
    "magick",
    "montage",
    "-label",
    "",
    ...tiles,
    "-tile",
    `${TILE_COLS}x`,
    "-geometry",
    `${TILE_WIDTH}x>+16+16`,
    "-background",
    TERMCTRL_BG,
    "-depth",
    "8",
    "-define",
    "png:compression-level=9",
    "-strip",
    OUT,
  ]);

  if (!KEEP) {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`\nKept tiles in ${work}`);
  }

  console.log(`\nMontage written: ${OUT}  (${THEMES.length} themes)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
