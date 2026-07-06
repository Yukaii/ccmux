import type { ThemePalette } from "../../lib/preferences";

/**
 * Rosé Pine Moon.
 *
 * Source: rosepinetheme.com. Same cool-accent limitation as the main variant
 * (teal=#6bb0c4 is derived). surface=#322f4a is nudged up from the official
 * #2a273f (too close to base for a visible selected row). ANSI = official Rosé
 * Pine Moon mapping.
 */
export const rosePineMoon: ThemePalette = {
  semantic: {
    rosewater: "#ea9a97",
    text: "#e0def4",
    subtext: "#908caa",
    overlay: "#6e6a86",
    surface: "#322f4a",
    base: "#232136",
    border: "#393552",
    red: "#eb6f92",
    peach: "#ea9a97",
    yellow: "#f6c177",
    green: "#3e8fb0",
    teal: "#6bb0c4",
    blue: "#9ccfd8",
    mauve: "#c4a7e7",
  },
  ansi: {
    black: "#393552",
    red: "#eb6f92",
    green: "#3e8fb0",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ea9a97",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#3e8fb0",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ea9a97",
    brightWhite: "#e0def4",
  },
};
