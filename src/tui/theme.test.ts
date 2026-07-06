import { describe, it, expect, afterEach } from "bun:test";
import type { SemanticColors } from "../lib/preferences";
import {
  theme,
  resolveTheme,
  resolveThemeVerbose,
  applyTheme,
  resetTheme,
} from "./theme";
import { catppuccinMocha } from "./themes/catppuccin-mocha";
import { catppuccinLatte } from "./themes/catppuccin-latte";
import { dracula } from "./themes/dracula";
import { gruvboxLight } from "./themes/gruvbox-light";

// applyTheme mutates a process-global singleton; reset after every test so
// state can't leak into later tests.
afterEach(() => resetTheme());

describe("resolveTheme", () => {
  it("resolves a built-in name", () => {
    const p = resolveTheme("catppuccin-latte");
    expect(p.semantic).toEqual(catppuccinLatte.semantic);
    expect(p.ansi).toEqual(catppuccinLatte.ansi);
  });

  it("defaults to mocha when config is undefined", () => {
    expect(resolveTheme(undefined).semantic).toEqual(catppuccinMocha.semantic);
  });

  it("resolves a non-Catppuccin dark theme", () => {
    const p = resolveTheme("dracula");
    expect(p.semantic).toEqual(dracula.semantic);
    expect(p.ansi).toEqual(dracula.ansi);
  });

  it("resolves a non-Catppuccin light theme", () => {
    const p = resolveTheme("gruvbox-light");
    expect(p.semantic).toEqual(gruvboxLight.semantic);
    expect(p.ansi).toEqual(gruvboxLight.ansi);
  });

  it("falls back to default on an unknown name, with a warning", () => {
    const { palette, warnings } = resolveThemeVerbose("catpuccin-moca");
    expect(palette.semantic).toEqual(catppuccinMocha.semantic);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown theme");
  });

  it("deep-merges semantic overrides over the base", () => {
    const p = resolveTheme({
      base: "catppuccin-mocha",
      colors: { red: "#ff5555" },
    });
    expect(p.semantic.red).toBe("#ff5555");
    expect(p.semantic.green).toBe(catppuccinMocha.semantic.green);
  });

  it("deep-merges ansi overrides over the base", () => {
    const p = resolveTheme({
      base: "catppuccin-latte",
      ansi: { brightBlack: "#000000" },
    });
    expect(p.ansi.brightBlack).toBe("#000000");
    expect(p.ansi.black).toBe(catppuccinLatte.ansi.black);
  });

  it("base defaults to mocha when omitted in object form", () => {
    const p = resolveTheme({ colors: { red: "#ff5555" } });
    expect(p.semantic.base).toBe(catppuccinMocha.semantic.base);
    expect(p.semantic.red).toBe("#ff5555");
  });

  it("drops an invalid-hex override and warns, keeping the base value", () => {
    const { palette, warnings } = resolveThemeVerbose({
      colors: { red: "#zzz" },
    });
    expect(palette.semantic.red).toBe(catppuccinMocha.semantic.red);
    expect(warnings.some((w) => w.includes("invalid hex"))).toBe(true);
  });

  it("drops an unknown override key and warns", () => {
    // Hand-edited config can carry keys outside the typed shape; the runtime
    // guard must drop them. Type-loose so the JSON path is exercised.
    const looseColors: Record<string, string> = { nope: "#ffffff" };
    const { warnings } = resolveThemeVerbose({
      colors: looseColors as Partial<SemanticColors>,
    });
    expect(warnings.some((w) => w.includes("unknown colors key"))).toBe(true);
  });
});

describe("resolveThemeVerbose: resolvedBase + appliedOverrides", () => {
  it("reports the resolved base name", () => {
    expect(resolveThemeVerbose("catppuccin-latte").resolvedBase).toBe(
      "catppuccin-latte",
    );
  });

  it("resolvedBase falls back to the default on an unknown name", () => {
    expect(resolveThemeVerbose("nope-theme").resolvedBase).toBe(
      "catppuccin-mocha",
    );
  });

  it("appliedOverrides is true when a valid override survives", () => {
    expect(
      resolveThemeVerbose({ colors: { red: "#ff5555" } }).appliedOverrides,
    ).toBe(true);
  });

  it("appliedOverrides is false when the only override is invalid hex", () => {
    expect(
      resolveThemeVerbose({ colors: { red: "#zzz" } }).appliedOverrides,
    ).toBe(false);
  });

  it("appliedOverrides is false when the only override is an unknown key", () => {
    const looseColors: Record<string, string> = { nope: "#ffffff" };
    expect(
      resolveThemeVerbose({ colors: looseColors as Partial<SemanticColors> })
        .appliedOverrides,
    ).toBe(false);
  });

  it("appliedOverrides is false when there are no overrides", () => {
    expect(resolveThemeVerbose("catppuccin-latte").appliedOverrides).toBe(
      false,
    );
  });
});

describe("applyTheme / resetTheme", () => {
  it("mutates the live singleton in place", () => {
    const ref = theme;
    applyTheme("catppuccin-latte");
    expect(theme).toBe(ref); // identity stays stable
    expect(theme.green).toBe(catppuccinLatte.semantic.green);
    expect(theme.ansi.black).toBe(catppuccinLatte.ansi.black);
  });

  it("resetTheme restores the default palette", () => {
    applyTheme("catppuccin-latte");
    resetTheme();
    expect(theme.green).toBe(catppuccinMocha.semantic.green);
    expect(theme.ansi.black).toBe(catppuccinMocha.ansi.black);
  });
});
