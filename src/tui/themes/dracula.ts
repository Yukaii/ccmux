import type { ThemePalette } from "../../lib/preferences";

/**
 * Dracula.
 *
 * Source: draculatheme.com/spec. Semantic blue=#82aaff is DERIVED (Dracula
 * ships no blue); the ANSI table keeps Dracula's official mapping (ansi.blue =
 * Purple #bd93f9). subtext/border are derived (no official secondary fg / dim
 * line color).
 */
export const dracula: ThemePalette = {
  semantic: {
    rosewater: "#ff79c6",
    text: "#f8f8f2",
    subtext: "#c8c9cc",
    overlay: "#6272a4",
    surface: "#44475a",
    base: "#282a36",
    border: "#3b3d4d",
    red: "#ff5555",
    peach: "#ffb86c",
    yellow: "#f1fa8c",
    green: "#50fa7b",
    teal: "#8be9fd",
    blue: "#82aaff",
    mauve: "#bd93f9",
  },
  ansi: {
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};
