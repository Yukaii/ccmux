/**
 * Minimal theme resolver for the lightweight picker.
 * Includes built-in theme palettes inline (no heavy imports).
 * Reads theme preference from ~/.config/ccmux/ccmux.json.
 */

import { join } from "path";
import { homedir } from "os";

// ── RGB helper ────────────────────────────────────────────────
export type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

// ── Semantic palette used by the renderer ─────────────────────
export interface Palette {
  bg: Rgb;
  surface: Rgb;
  border: Rgb;
  fg: Rgb;
  muted: Rgb;
  accent: Rgb;
  green: Rgb;
  yellow: Rgb;
  red: Rgb;
  purple: Rgb;
  cyan: Rgb;
  orange: Rgb;
  selected: Rgb;
}

// ── Built-in theme definitions (semantic colors only) ─────────
interface ThemeDef {
  semantic: {
    base: string;
    surface: string;
    border: string;
    text: string;
    subtext: string;
    blue: string;
    green: string;
    yellow: string;
    red: string;
    mauve: string;
    teal: string;
    peach: string;
    overlay: string;
  };
}

const BUILTIN: Record<string, ThemeDef> = {
  "tokyo-night": {
    semantic: {
      base: "#1a1b26",
      surface: "#24253a",
      border: "#3b3d54",
      text: "#c0caf5",
      subtext: "#565f89",
      blue: "#7aa2f7",
      green: "#9ece6a",
      yellow: "#e0af68",
      red: "#f7768e",
      mauve: "#bb9af7",
      teal: "#7dcfff",
      peach: "#ff9e64",
      overlay: "#364a82",
    },
  },
  "tokyo-night-storm": {
    semantic: {
      base: "#24283b",
      surface: "#2a3042",
      border: "#3b4261",
      text: "#c0caf5",
      subtext: "#565f89",
      blue: "#7aa2f7",
      green: "#9ece6a",
      yellow: "#e0af68",
      red: "#f7768e",
      mauve: "#bb9af7",
      teal: "#7dcfff",
      peach: "#ff9e64",
      overlay: "#364a82",
    },
  },
  "catppuccin-mocha": {
    semantic: {
      base: "#1e1e2e",
      surface: "#313244",
      border: "#45475a",
      text: "#cdd6f4",
      subtext: "#6c7086",
      blue: "#89b4fa",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      red: "#f38ba8",
      mauve: "#cba6f7",
      teal: "#94e2d5",
      peach: "#fab387",
      overlay: "#585b70",
    },
  },
  "catppuccin-macchiato": {
    semantic: {
      base: "#24273a",
      surface: "#363a4f",
      border: "#494d64",
      text: "#cad3f5",
      subtext: "#6e738d",
      blue: "#8aadf4",
      green: "#a6da95",
      yellow: "#eed49f",
      red: "#ed8796",
      mauve: "#c6a0f6",
      teal: "#8bd5ca",
      peach: "#f5a97f",
      overlay: "#5b6078",
    },
  },
  "catppuccin-frappe": {
    semantic: {
      base: "#303446",
      surface: "#414559",
      border: "#51576d",
      text: "#c6d0f5",
      subtext: "#838ba7",
      blue: "#8caaee",
      green: "#a6d189",
      yellow: "#e5c890",
      red: "#e78284",
      mauve: "#ca9ee6",
      teal: "#81c8be",
      peach: "#ef9f76",
      overlay: "#626880",
    },
  },
  dracula: {
    semantic: {
      base: "#282a36",
      surface: "#343746",
      border: "#44475a",
      text: "#f8f8f2",
      subtext: "#6272a4",
      blue: "#8be9fd",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      red: "#ff5555",
      mauve: "#bd93f9",
      teal: "#8be9fd",
      peach: "#ffb86c",
      overlay: "#44475a",
    },
  },
  nord: {
    semantic: {
      base: "#2e3440",
      surface: "#3b4252",
      border: "#4c566a",
      text: "#eceff4",
      subtext: "#7b88a1",
      blue: "#81a1c1",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      red: "#bf616a",
      mauve: "#b48ead",
      teal: "#8fbcbb",
      peach: "#d08770",
      overlay: "#4c566a",
    },
  },
  "rose-pine": {
    semantic: {
      base: "#191724",
      surface: "#26233a",
      border: "#403d52",
      text: "#e0def4",
      subtext: "#908caa",
      blue: "#9ccfd8",
      green: "#31748f",
      yellow: "#f6c177",
      red: "#eb6f92",
      mauve: "#c4a7e7",
      teal: "#9ccfd8",
      peach: "#ebbcba",
      overlay: "#403d52",
    },
  },
  "rose-pine-moon": {
    semantic: {
      base: "#232136",
      surface: "#2a2740",
      border: "#393552",
      text: "#e0def4",
      subtext: "#908caa",
      blue: "#9ccfd8",
      green: "#31748f",
      yellow: "#f6c177",
      red: "#eb6f92",
      mauve: "#c4a7e7",
      teal: "#9ccfd8",
      peach: "#ebbcba",
      overlay: "#393552",
    },
  },
  "gruvbox-dark": {
    semantic: {
      base: "#282828",
      surface: "#3c3836",
      border: "#504945",
      text: "#ebdbb2",
      subtext: "#928374",
      blue: "#83a598",
      green: "#b8bb26",
      yellow: "#fabd2f",
      red: "#fb4934",
      mauve: "#d3869b",
      teal: "#8ec07c",
      peach: "#fe8019",
      overlay: "#504945",
    },
  },
  "kanagawa-wave": {
    semantic: {
      base: "#1f1f28",
      surface: "#2a2a37",
      border: "#363646",
      text: "#dcd7ba",
      subtext: "#727169",
      blue: "#7e9cd8",
      green: "#98bb6c",
      yellow: "#e6c384",
      red: "#e46876",
      mauve: "#957fb8",
      teal: "#7aa89f",
      peach: "#ffa066",
      overlay: "#363646",
    },
  },
};

// ── Default palette (tokyo-night) ──────────────────────────────
export const DEFAULT_PALETTE: Palette = themeDefToPalette(BUILTIN["tokyo-night"]!);

// ── Convert ThemeDef → Palette ─────────────────────────────────
function themeDefToPalette(t: ThemeDef): Palette {
  const s = t.semantic;
  return {
    bg: hexToRgb(s.base),
    surface: hexToRgb(s.surface),
    border: hexToRgb(s.border),
    fg: hexToRgb(s.text),
    muted: hexToRgb(s.subtext),
    accent: hexToRgb(s.blue),
    green: hexToRgb(s.green),
    yellow: hexToRgb(s.yellow),
    red: hexToRgb(s.red),
    purple: hexToRgb(s.mauve),
    cyan: hexToRgb(s.teal),
    orange: hexToRgb(s.peach),
    selected: hexToRgb(s.overlay),
  };
}

// ── Resolve theme from config ──────────────────────────────────
const CONFIG_FILE = join(homedir(), ".config", "ccmux", "ccmux.json");

let cachedPalette: Palette | null = null;

export async function resolveTheme(): Promise<Palette> {
  if (cachedPalette) return cachedPalette;

  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      const config = await file.json() as {
        theme?: string | { base?: string; colors?: Partial<Record<keyof Palette, string>> };
      };
      const themeConfig = config.theme;
      if (themeConfig) {
        if (typeof themeConfig === "string") {
          if (BUILTIN[themeConfig]) {
            cachedPalette = themeDefToPalette(BUILTIN[themeConfig]!);
            return cachedPalette;
          }
        } else {
          const baseName = themeConfig.base ?? "tokyo-night";
          const base = BUILTIN[baseName] ?? BUILTIN["tokyo-night"]!;
          const palette = themeDefToPalette(base);
          // Apply per-color overrides
          if (themeConfig.colors) {
            for (const [key, hexColor] of Object.entries(themeConfig.colors)) {
              if (key in palette && typeof hexColor === "string") {
                (palette as any)[key] = hexToRgb(hexColor);
              }
            }
          }
          cachedPalette = palette;
          return cachedPalette;
        }
      }
    }
  } catch {
    // Config missing or malformed — use default
  }

  cachedPalette = DEFAULT_PALETTE;
  return cachedPalette;
}
