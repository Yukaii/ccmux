import { describe, it, expect } from "bun:test";
import { grepContent } from "./screen";

describe("grepContent", () => {
  const content = [
    "Line one: hello world",
    "Line two: ERROR something failed",
    "Line three: all good",
    "Line four: error lowercase",
    "Line five: another ERROR here",
    "",
    "Line seven: final line",
  ].join("\n");

  describe("substring matching", () => {
    it("finds case-sensitive matches", () => {
      const matches = grepContent(content, "ERROR", false, false);
      expect(matches).toEqual([
        { line: 2, text: "Line two: ERROR something failed" },
        { line: 5, text: "Line five: another ERROR here" },
      ]);
    });

    it("is case-sensitive by default", () => {
      const matches = grepContent(content, "error", false, false);
      expect(matches).toEqual([
        { line: 4, text: "Line four: error lowercase" },
      ]);
    });

    it("supports case-insensitive matching", () => {
      const matches = grepContent(content, "error", true, false);
      expect(matches).toEqual([
        { line: 2, text: "Line two: ERROR something failed" },
        { line: 4, text: "Line four: error lowercase" },
        { line: 5, text: "Line five: another ERROR here" },
      ]);
    });

    it("returns empty array when no matches", () => {
      const matches = grepContent(content, "NOTFOUND", false, false);
      expect(matches).toEqual([]);
    });
  });

  describe("regex matching", () => {
    it("matches with regex pattern", () => {
      const matches = grepContent(content, "ERROR.*failed", false, true);
      expect(matches).toEqual([
        { line: 2, text: "Line two: ERROR something failed" },
      ]);
    });

    it("supports case-insensitive regex", () => {
      const matches = grepContent(content, "error.*here", true, true);
      expect(matches).toEqual([
        { line: 5, text: "Line five: another ERROR here" },
      ]);
    });

    it("matches digit patterns", () => {
      const numbered = "item 1\nitem 2\nno number\nitem 99";
      const matches = grepContent(numbered, "\\d+", false, true);
      expect(matches).toEqual([
        { line: 1, text: "item 1" },
        { line: 2, text: "item 2" },
        { line: 4, text: "item 99" },
      ]);
    });
  });

  describe("line numbering", () => {
    it("uses 1-based line numbers", () => {
      const matches = grepContent(content, "hello", false, false);
      expect(matches).toEqual([
        { line: 1, text: "Line one: hello world" },
      ]);
    });

    it("assigns correct line numbers with gaps", () => {
      const matches = grepContent(content, "final", false, false);
      expect(matches).toEqual([
        { line: 7, text: "Line seven: final line" },
      ]);
    });
  });

  describe("edge cases", () => {
    it("handles empty content", () => {
      const matches = grepContent("", "anything", false, false);
      expect(matches).toEqual([]);
    });

    it("skips empty lines", () => {
      const matches = grepContent("a\n\nb\n\nc", ".", false, true);
      expect(matches).toEqual([
        { line: 1, text: "a" },
        { line: 3, text: "b" },
        { line: 5, text: "c" },
      ]);
    });

    it("trims trailing whitespace from matched lines", () => {
      const padded = "hello   \nworld   ";
      const matches = grepContent(padded, "hello", false, false);
      expect(matches).toEqual([
        { line: 1, text: "hello" },
      ]);
    });
  });
});
