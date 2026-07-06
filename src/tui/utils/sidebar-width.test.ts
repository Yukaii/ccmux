import { describe, it, expect } from "bun:test";
import { shouldPersistWidth } from "./sidebar-width";

describe("shouldPersistWidth", () => {
  it("persists a drag: width changed while window size held", () => {
    expect(
      shouldPersistWidth({
        settledWidth: 40,
        configuredWidth: 30,
        windowWidth: 220,
        prevWindowWidth: 220,
      }),
    ).toBe(true);
  });

  it("ignores a settled width equal to the configured width", () => {
    expect(
      shouldPersistWidth({
        settledWidth: 30,
        configuredWidth: 30,
        windowWidth: 220,
        prevWindowWidth: 220,
      }),
    ).toBe(false);
  });

  it("ignores width changes that coincide with a window resize", () => {
    // Session switch / terminal resize: tmux rescaled the pane and the
    // window-resized hook will re-pin it. Must not persist the transient.
    expect(
      shouldPersistWidth({
        settledWidth: 98,
        configuredWidth: 30,
        windowWidth: 220,
        prevWindowWidth: 80,
      }),
    ).toBe(false);
  });

  it("fails safe when window width cannot be determined", () => {
    expect(
      shouldPersistWidth({
        settledWidth: 40,
        configuredWidth: 30,
        windowWidth: null,
        prevWindowWidth: 220,
      }),
    ).toBe(false);
    expect(
      shouldPersistWidth({
        settledWidth: 40,
        configuredWidth: 30,
        windowWidth: 220,
        prevWindowWidth: null,
      }),
    ).toBe(false);
  });

  it("ignores degenerate squeezed widths", () => {
    expect(
      shouldPersistWidth({
        settledWidth: 4,
        configuredWidth: 30,
        windowWidth: 220,
        prevWindowWidth: 220,
      }),
    ).toBe(false);
  });
});
