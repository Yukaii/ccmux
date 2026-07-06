import type { ThemePalette } from "../../lib/preferences";

/**
 * Rosé Pine Dawn (light variant — assumes a light terminal).
 *
 * Source: rosepinetheme.com. Light variant. Same cool-accent limitation
 * (teal=#3e8590 is derived). text=#575279 is the canonical Dawn text token.
 * surface=#e8e2dc is nudged DOWN from the official #fffaf3 (on a light theme the
 * selected row must be darker than base to be visible). ANSI = official Rosé
 * Pine Dawn mapping.
 */
export const rosePineDawn: ThemePalette = {
  semantic: {
    rosewater: "#d7827e",
    text: "#575279",
    subtext: "#797593",
    overlay: "#9893a5",
    surface: "#e8e2dc",
    base: "#faf4ed",
    border: "#dfdad9",
    red: "#b4637a",
    peach: "#d7827e",
    yellow: "#ea9d34",
    green: "#286983",
    teal: "#3e8590",
    blue: "#56949f",
    mauve: "#907aa9",
  },
  ansi: {
    black: "#f2e9e1",
    red: "#b4637a",
    green: "#286983",
    yellow: "#ea9d34",
    blue: "#56949f",
    magenta: "#907aa9",
    cyan: "#d7827e",
    white: "#575279",
    brightBlack: "#9893a5",
    brightRed: "#b4637a",
    brightGreen: "#286983",
    brightYellow: "#ea9d34",
    brightBlue: "#56949f",
    brightMagenta: "#907aa9",
    brightCyan: "#d7827e",
    brightWhite: "#575279",
  },
};
