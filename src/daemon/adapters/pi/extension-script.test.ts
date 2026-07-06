import { describe, expect, it } from "bun:test";
import {
  getPiExtensionSourceForTests,
  renderPiExtension,
} from "./extension-script";

describe("renderPiExtension", () => {
  it("substitutes the markers dir and version, leaving no raw sentinels", () => {
    const out = renderPiExtension({
      markersDir: "/home/u/.config/ccmux/session-pids",
      version: "1.2.3",
    });
    expect(out).toContain(`markersDir: "/home/u/.config/ccmux/session-pids"`);
    expect(out).toContain(`version: "1.2.3"`);
    // Sentinel comment carries the version.
    expect(out.split("\n", 1)[0]).toBe("// ccmux-extension v1.2.3");
    expect(out).not.toContain("__CCMUX_MARKERS_DIR__");
    expect(out).not.toContain("__CCMUX_VERSION__");
  });

  it("JSON-encodes paths so special characters stay valid string literals", () => {
    const out = renderPiExtension({
      markersDir: `/tmp/with "quote"/markers`,
      version: "9.9.9",
    });
    expect(out).toContain(JSON.stringify(`/tmp/with "quote"/markers`));
  });

  it("raw template still carries the sentinels (pre-substitution)", () => {
    const raw = getPiExtensionSourceForTests();
    expect(raw).toContain("__CCMUX_MARKERS_DIR__");
    expect(raw).toContain("__CCMUX_VERSION__");
  });
});
