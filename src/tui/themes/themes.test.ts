import { describe, it, expect } from "bun:test";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_NAME,
} from "./index";

// The full set of keys every palette must define. Kept as literal lists (not
// derived from a sample palette) so a typo or dropped key in ANY theme — the
// default included — is caught rather than silently treated as the baseline.
const SEMANTIC_KEYS = [
  "rosewater",
  "text",
  "subtext",
  "overlay",
  "surface",
  "base",
  "border",
  "red",
  "peach",
  "yellow",
  "green",
  "teal",
  "blue",
  "mauve",
] as const;

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

// The five semantic keys that drive per-agent accent colors in the picker
// (SessionItem.tsx: claude=peach, codex=green, opencode=blue, gemini=mauve,
// pi=teal). They must stay pairwise DISTINCT so two agents are never painted
// the identical color. Strict inequality only, NOT a contrast threshold: Rosé
// Pine deliberately ships close-but-unequal cool accents, so a ΔE floor would
// wrongly reject it.
const AGENT_ACCENT_KEYS = ["peach", "green", "blue", "teal", "mauve"] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe("built-in theme registry", () => {
  it("registers the default theme", () => {
    expect(BUILTIN_THEME_NAMES).toContain(DEFAULT_THEME_NAME);
  });

  it("exposes every palette under a kebab-case name", () => {
    for (const name of BUILTIN_THEME_NAMES) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe.each(Object.entries(BUILTIN_THEMES))(
  "palette %s",
  (_name, palette) => {
    it("defines exactly the 14 semantic keys", () => {
      expect(Object.keys(palette.semantic).sort()).toEqual(
        [...SEMANTIC_KEYS].sort(),
      );
    });

    it("defines exactly the 16 ansi keys", () => {
      expect(Object.keys(palette.ansi).sort()).toEqual([...ANSI_KEYS].sort());
    });

    it("uses valid 6-digit hex for every value", () => {
      for (const key of SEMANTIC_KEYS) {
        expect(palette.semantic[key]).toMatch(HEX_RE);
      }
      for (const key of ANSI_KEYS) {
        expect(palette.ansi[key]).toMatch(HEX_RE);
      }
    });

    it("keeps the five agent-accent colors pairwise distinct", () => {
      const used = AGENT_ACCENT_KEYS.map((key) => palette.semantic[key]);
      expect(new Set(used).size).toBe(AGENT_ACCENT_KEYS.length);
    });
  },
);
