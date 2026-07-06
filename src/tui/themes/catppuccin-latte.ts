import type { ThemePalette } from "../../lib/preferences";

/**
 * Catppuccin Latte (light). Assumes a light terminal background; ccmux paints no
 * root background, so pairing this with a dark terminal will look wrong. Sourced
 * from the official Catppuccin palette and mapped to ccmux's roles with the same
 * scheme as Mocha. Because Latte is light, `base`/`surface` are light and
 * `text` is dark; `brightWhite` (Subtext0) is lighter than `white` (Subtext1).
 */
export const catppuccinLatte: ThemePalette = {
  semantic: {
    rosewater: "#dc8a78",
    text: "#4c4f69",
    subtext: "#6c6f85",
    overlay: "#9ca0b0",
    surface: "#ccd0da",
    base: "#eff1f5",
    border: "#bcc0cc",
    red: "#d20f39",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    blue: "#1e66f5",
    mauve: "#8839ef",
  },
  ansi: {
    black: "#bcc0cc",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#5c5f77",
    brightBlack: "#acb0be",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#6c6f85",
  },
};
