import type { ThemePalette } from "../../lib/preferences";

/**
 * Rosé Pine (main).
 *
 * Source: rosepinetheme.com. Known limitation: Rosé Pine lacks a distinct green
 * and blue, so codex/pi/opencode cool accents differ mainly by brightness
 * (teal=#5ba3b5 is derived). Deliberate, documented carve-out from
 * distinctness-first; per-agent overrides are the long-term fix. surface=#2e2a42
 * is nudged up from the official #1f1d2e (too close to base for a visible
 * selected row, same fix as tokyo-night-storm). ANSI = official Rosé Pine
 * mapping.
 */
export const rosePine: ThemePalette = {
  semantic: {
    rosewater: "#ebbcba",
    text: "#e0def4",
    subtext: "#908caa",
    overlay: "#6e6a86",
    surface: "#2e2a42",
    base: "#191724",
    border: "#26233a",
    red: "#eb6f92",
    peach: "#ebbcba",
    yellow: "#f6c177",
    green: "#31748f",
    teal: "#5ba3b5",
    blue: "#9ccfd8",
    mauve: "#c4a7e7",
  },
  ansi: {
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#31748f",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba",
    brightWhite: "#e0def4",
  },
};
