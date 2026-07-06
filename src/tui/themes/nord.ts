import type { ThemePalette } from "../../lib/preferences";

/**
 * Nord.
 *
 * Source: nordtheme.com. rosewater intentionally shares nord13 (#ebcb8b) with
 * yellow (Nord has no second warm hue); the roles never co-locate. The cool
 * agent accents use two well-separated Frost tones: blue=nord10 (#5e81ac) and
 * teal=nord7 (#8fbcbb), so opencode and pi stay tellable apart (nord9 #81a1c1
 * sits too close to nord7 to use as the blue accent). The ANSI table keeps
 * Nord's official blue=nord9; ANSI = official Nord mapping.
 */
export const nord: ThemePalette = {
  semantic: {
    rosewater: "#ebcb8b",
    text: "#eceff4",
    subtext: "#d8dee9",
    overlay: "#4c566a",
    surface: "#3b4252",
    base: "#2e3440",
    border: "#434c5e",
    red: "#bf616a",
    peach: "#d08770",
    yellow: "#ebcb8b",
    green: "#a3be8c",
    teal: "#8fbcbb",
    blue: "#5e81ac",
    mauve: "#b48ead",
  },
  ansi: {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
};
