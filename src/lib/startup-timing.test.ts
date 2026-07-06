import { describe, it, expect, beforeEach } from "bun:test";
import {
  markStartup,
  getStartupMarks,
  resetStartupMarks,
  reportStartup,
} from "./startup-timing";
import { PERF_ENABLED } from "./perf-config";

describe("startup-timing", () => {
  beforeEach(() => {
    resetStartupMarks();
  });

  describe("markStartup", () => {
    it("should record marks when perf is enabled", () => {
      if (!PERF_ENABLED) {
        markStartup("test");
        expect(getStartupMarks()).toHaveLength(0);
        return;
      }

      markStartup("first");
      markStartup("second");
      const marks = getStartupMarks();
      expect(marks).toHaveLength(2);
      expect(marks[0].label).toBe("first");
      expect(marks[1].label).toBe("second");
    });

    it("should record marks in chronological order", () => {
      if (!PERF_ENABLED) return;

      markStartup("a");
      markStartup("b");
      markStartup("c");
      const marks = getStartupMarks();
      expect(marks[0].ns).toBeLessThanOrEqual(marks[1].ns);
      expect(marks[1].ns).toBeLessThanOrEqual(marks[2].ns);
    });

    it("should be a no-op when perf is disabled", () => {
      if (PERF_ENABLED) return;

      markStartup("should-not-record");
      expect(getStartupMarks()).toHaveLength(0);
    });
  });

  describe("resetStartupMarks", () => {
    it("should clear all marks", () => {
      if (!PERF_ENABLED) return;

      markStartup("to-clear");
      expect(getStartupMarks()).toHaveLength(1);
      resetStartupMarks();
      expect(getStartupMarks()).toHaveLength(0);
    });
  });

  describe("reportStartup", () => {
    it("should not throw when called with no marks", () => {
      expect(() => reportStartup()).not.toThrow();
    });

    it("should not throw when called with marks", () => {
      if (!PERF_ENABLED) return;

      markStartup("start");
      markStartup("end");
      expect(() => reportStartup()).not.toThrow();
    });
  });
});
