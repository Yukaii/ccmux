import { describe, it, expect } from "bun:test";
import { formatVersion } from "./format";

describe("formatVersion", () => {
  it("should return empty string for null", () => {
    expect(formatVersion(null)).toBe("");
  });

  it("should return empty string for empty string", () => {
    expect(formatVersion("")).toBe("");
  });

  it("should add v prefix to plain version", () => {
    expect(formatVersion("2.1.50")).toBe("v2.1.50");
  });

  it("should keep existing v prefix", () => {
    expect(formatVersion("v0.29.5")).toBe("v0.29.5");
  });

  it("should strip platform suffix", () => {
    expect(formatVersion("0.104.0-darwin-arm64")).toBe("v0.104.0");
  });

  it("should strip prerelease suffix", () => {
    expect(formatVersion("1.0.0-beta.1")).toBe("v1.0.0");
  });

  it("should strip build metadata", () => {
    expect(formatVersion("1.2.3+build.456")).toBe("v1.2.3");
  });

  it("should handle v prefix with suffix", () => {
    expect(formatVersion("v0.104.0-darwin-arm64")).toBe("v0.104.0");
  });
});
