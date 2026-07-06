import type { ThemePalette } from "../../lib/preferences";

/**
 * Catppuccin Frappe. Sourced from the official Catppuccin palette and mapped to
 * ccmux's roles with the same scheme as Mocha (semantic: Text/Subtext0/
 * Overlay0/Surface0/Base/Surface1 + accents; ansi: black=Surface1,
 * magenta=Pink, white=Subtext1, brightBlack=Surface2, brightWhite=Subtext0).
 */
export const catppuccinFrappe: ThemePalette = {
  semantic: {
    rosewater: "#f2d5cf",
    text: "#c6d0f5",
    subtext: "#a5adce",
    overlay: "#737994",
    surface: "#414559",
    base: "#303446",
    border: "#51576d",
    red: "#e78284",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    blue: "#8caaee",
    mauve: "#ca9ee6",
  },
  ansi: {
    black: "#51576d",
    red: "#e78284",
    green: "#a6d189",
    yellow: "#e5c890",
    blue: "#8caaee",
    magenta: "#f4b8e4",
    cyan: "#81c8be",
    white: "#b5bfe2",
    brightBlack: "#626880",
    brightRed: "#e78284",
    brightGreen: "#a6d189",
    brightYellow: "#e5c890",
    brightBlue: "#8caaee",
    brightMagenta: "#f4b8e4",
    brightCyan: "#81c8be",
    brightWhite: "#a5adce",
  },
};
