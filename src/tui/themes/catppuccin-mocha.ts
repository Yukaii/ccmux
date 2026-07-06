import type { ThemePalette } from "../../lib/preferences";

/**
 * Catppuccin Mocha (default theme).
 *
 * Semantic values are preserved byte-for-byte from ccmux's original hardcoded
 * palette. Note `base` is `#1e1e2f`, one digit off the official Catppuccin
 * `#1e1e2e`; kept as-is so the long-standing default renders identically.
 *
 * `ansi` is the official Catppuccin Mocha terminal mapping, folded in from the
 * standalone `ANSI_16_HEX` added in #78 (black=Surface1, magenta=Pink,
 * white=Subtext1, brightBlack=Surface2, brightWhite=Subtext0).
 */
export const catppuccinMocha: ThemePalette = {
  semantic: {
    rosewater: "#f5e0dc",
    text: "#cdd6f4",
    subtext: "#a6adc8",
    overlay: "#6c7086",
    surface: "#313244",
    base: "#1e1e2f",
    border: "#45475a",
    red: "#f38ba8",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    blue: "#89b4fa",
    mauve: "#cba6f7",
  },
  ansi: {
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
};
