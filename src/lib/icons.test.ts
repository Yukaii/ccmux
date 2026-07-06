import { describe, it, expect } from "bun:test";
import { getAttentionIcon, getStatusIcon } from "./icons";

describe("getAttentionIcon", () => {
  it("should return ● for dot style", () => {
    expect(getAttentionIcon("unread", "dot")).toBe("●");
    expect(getAttentionIcon("read", "dot")).toBe("●");
  });

  it("should return emoji icons", () => {
    expect(getAttentionIcon("unread", "emoji")).toBe("📬");
    expect(getAttentionIcon("read", "emoji")).toBe("✅");
  });

  it("should return empty string for none style", () => {
    expect(getAttentionIcon("unread", "none")).toBe("");
  });

  it("should return empty string for null state", () => {
    expect(getAttentionIcon(null, "dot")).toBe("");
  });

  it("should default to dot style", () => {
    expect(getAttentionIcon("unread")).toBe("●");
  });
});

describe("getStatusIcon", () => {
  it("should return ● for idle dot style", () => {
    expect(getStatusIcon("idle", null, "dot")).toBe("●");
  });

  it("should return ■ for waiting dot style", () => {
    expect(getStatusIcon("waiting", null, "dot")).toBe("■");
  });
});
