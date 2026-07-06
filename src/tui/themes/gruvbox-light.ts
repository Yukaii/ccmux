import type { ThemePalette } from "../../lib/preferences";

/**
 * Gruvbox Light (light variant — assumes a light terminal).
 *
 * Source: morhetz/gruvbox + gruvbox-contrib color.table. Light variant: accents
 * use the faded set. ANSI = official gruvbox-contrib light terminal mapping.
 */
export const gruvboxLight: ThemePalette = {
  semantic: {
    rosewater: "#d65d0e",
    text: "#3c3836",
    subtext: "#7c6f64",
    overlay: "#928374",
    surface: "#d5c4a1",
    base: "#fbf1c7",
    border: "#bdae93",
    red: "#9d0006",
    peach: "#af3a03",
    yellow: "#b57614",
    green: "#79740e",
    teal: "#427b58",
    blue: "#076678",
    mauve: "#8f3f71",
  },
  ansi: {
    black: "#7c6f64",
    red: "#9d0006",
    green: "#79740e",
    yellow: "#b57614",
    blue: "#076678",
    magenta: "#8f3f71",
    cyan: "#427b58",
    white: "#fbf1c7",
    brightBlack: "#928374",
    brightRed: "#cc241d",
    brightGreen: "#98971a",
    brightYellow: "#d79921",
    brightBlue: "#458588",
    brightMagenta: "#b16286",
    brightCyan: "#689d6a",
    brightWhite: "#282828",
  },
};
