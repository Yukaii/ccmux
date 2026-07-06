import type { ThemePalette } from "../../lib/preferences";

/**
 * Catppuccin Macchiato. Sourced from the official Catppuccin palette and mapped
 * to ccmux's roles with the same scheme as Mocha (semantic: Text/Subtext0/
 * Overlay0/Surface0/Base/Surface1 + accents; ansi: black=Surface1,
 * magenta=Pink, white=Subtext1, brightBlack=Surface2, brightWhite=Subtext0).
 */
export const catppuccinMacchiato: ThemePalette = {
  semantic: {
    rosewater: "#f4dbd6",
    text: "#cad3f5",
    subtext: "#a5adcb",
    overlay: "#6e738d",
    surface: "#363a4f",
    base: "#24273a",
    border: "#494d64",
    red: "#ed8796",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    blue: "#8aadf4",
    mauve: "#c6a0f6",
  },
  ansi: {
    black: "#494d64",
    red: "#ed8796",
    green: "#a6da95",
    yellow: "#eed49f",
    blue: "#8aadf4",
    magenta: "#f5bde6",
    cyan: "#8bd5ca",
    white: "#b8c0e0",
    brightBlack: "#5b6078",
    brightRed: "#ed8796",
    brightGreen: "#a6da95",
    brightYellow: "#eed49f",
    brightBlue: "#8aadf4",
    brightMagenta: "#f5bde6",
    brightCyan: "#8bd5ca",
    brightWhite: "#a5adcb",
  },
};
