import { describe, it, expect } from "bun:test";
import {
  formatLogLine,
  processWriteBuffer,
  formatConsoleCall,
} from "./log-redirect";

describe("formatLogLine", () => {
  const TS = "2026-04-17T12:00:00.000Z";

  it("prefixes stdout lines with the ISO timestamp", () => {
    expect(formatLogLine("hello", "", TS)).toBe(`[${TS}] hello\n`);
  });

  it("includes the [err] tag for stderr lines", () => {
    expect(formatLogLine("boom", " [err]", TS)).toBe(`[${TS}] [err] boom\n`);
  });

  it("preserves empty lines and internal whitespace", () => {
    expect(formatLogLine("", "", TS)).toBe(`[${TS}] \n`);
    expect(formatLogLine("  indented", "", TS)).toBe(`[${TS}]   indented\n`);
  });
});

describe("processWriteBuffer", () => {
  const now = (): string => "T";

  it("emits one formatted line per newline", () => {
    const { lines, leftover } = processWriteBuffer("a\nb\n", "", now);
    expect(lines).toEqual(["[T] a\n", "[T] b\n"]);
    expect(leftover).toBe("");
  });

  it("keeps partial trailing data as leftover", () => {
    const { lines, leftover } = processWriteBuffer("a\nbc", "", now);
    expect(lines).toEqual(["[T] a\n"]);
    expect(leftover).toBe("bc");
  });

  it("returns no lines when no newline is present", () => {
    const { lines, leftover } = processWriteBuffer("hello", "", now);
    expect(lines).toEqual([]);
    expect(leftover).toBe("hello");
  });

  it("applies the tag to every emitted line", () => {
    const { lines } = processWriteBuffer("a\nb\n", " [err]", now);
    expect(lines).toEqual(["[T] [err] a\n", "[T] [err] b\n"]);
  });

  it("handles consecutive newlines as empty lines", () => {
    const { lines, leftover } = processWriteBuffer("a\n\nb\n", "", now);
    expect(lines).toEqual(["[T] a\n", "[T] \n", "[T] b\n"]);
    expect(leftover).toBe("");
  });
});

describe("formatConsoleCall", () => {
  const TS = "2026-04-17T12:00:00.000Z";

  it("formats a single string argument", () => {
    expect(formatConsoleCall(["hello"], "", TS)).toBe(`[${TS}] hello\n`);
  });

  it("joins multiple arguments with spaces (util.format)", () => {
    expect(formatConsoleCall(["count", 42], "", TS)).toBe(`[${TS}] count 42\n`);
  });

  it("emits one log entry per embedded newline", () => {
    expect(formatConsoleCall(["a\nb"], "", TS)).toBe(`[${TS}] a\n[${TS}] b\n`);
  });

  it("applies the tag to every emitted line", () => {
    expect(formatConsoleCall(["a\nb"], " [err]", TS)).toBe(
      `[${TS}] [err] a\n[${TS}] [err] b\n`,
    );
  });

  it("emits a single empty line when no args are passed", () => {
    expect(formatConsoleCall([], "", TS)).toBe(`[${TS}] \n`);
  });

  it("drops a single trailing newline but preserves internal blanks", () => {
    expect(formatConsoleCall(["a\n\nb"], "", TS)).toBe(
      `[${TS}] a\n[${TS}] \n[${TS}] b\n`,
    );
  });
});
