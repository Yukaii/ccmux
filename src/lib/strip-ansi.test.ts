import { describe, it, expect } from "bun:test";
import { stripAnsi } from "./strip-ansi";

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\x1B[31mred\x1B[0m")).toBe("red");
  });

  it("removes multiple codes", () => {
    expect(stripAnsi("\x1B[1m\x1B[32mbold green\x1B[0m")).toBe("bold green");
  });

  it("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("removes SGR codes with multiple parameters", () => {
    expect(stripAnsi("\x1B[38;5;196mcolor\x1B[0m")).toBe("color");
  });
});
