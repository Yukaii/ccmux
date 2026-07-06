import type { ThemePalette } from "../../lib/preferences";

/**
 * Tokyo Night Day (light variant — assumes a light terminal).
 *
 * Source: folke/tokyonight.nvim (tokyonight_day). Light variant: light base,
 * dark text, accents tuned for a light terminal. ANSI = official extras
 * mapping.
 */
export const tokyoNightDay: ThemePalette = {
  semantic: {
    rosewater: "#ff4774",
    text: "#3760bf",
    subtext: "#6172b0",
    overlay: "#848cb5",
    surface: "#c4c8da",
    base: "#e1e2e7",
    border: "#a8aecb",
    red: "#f52a65",
    peach: "#b15c00",
    yellow: "#8c6c3e",
    green: "#587539",
    teal: "#007197",
    blue: "#2e7de9",
    mauve: "#9854f1",
  },
  ansi: {
    black: "#b4b5b9",
    red: "#f52a65",
    green: "#587539",
    yellow: "#8c6c3e",
    blue: "#2e7de9",
    magenta: "#9854f1",
    cyan: "#007197",
    white: "#6172b0",
    brightBlack: "#a1a6c5",
    brightRed: "#ff4774",
    brightGreen: "#5c8524",
    brightYellow: "#a27629",
    brightBlue: "#358aff",
    brightMagenta: "#a463ff",
    brightCyan: "#007ea8",
    brightWhite: "#3760bf",
  },
};
