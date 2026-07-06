import type { ThemePalette } from "../../lib/preferences";

/**
 * Gruvbox Dark.
 *
 * Source: morhetz/gruvbox + gruvbox-contrib color.table. Accents use the bright
 * set; gruvbox's blue (#83a598) is intentionally a muted blue-gray. ANSI =
 * official gruvbox-contrib terminal mapping.
 */
export const gruvboxDark: ThemePalette = {
  semantic: {
    rosewater: "#fbf1c7",
    text: "#ebdbb2",
    subtext: "#a89984",
    overlay: "#928374",
    surface: "#3c3836",
    base: "#282828",
    border: "#504945",
    red: "#fb4934",
    peach: "#fe8019",
    yellow: "#fabd2f",
    green: "#b8bb26",
    teal: "#8ec07c",
    blue: "#83a598",
    mauve: "#d3869b",
  },
  ansi: {
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#fbf1c7",
  },
};
