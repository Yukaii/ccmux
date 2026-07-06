import { describe, it, expect, beforeEach } from "bun:test";
import {
  trackedMemo,
  getMemoCounters,
  resetMemoCounters,
  trackInterval,
  untrackInterval,
  getActiveTimerCount,
  PERF_ENABLED,
} from "./perf";

describe("perf utilities", () => {
  describe("trackedMemo", () => {
    it("should return a working memo accessor", () => {
      const memo = trackedMemo("test-memo", () => 42);
      expect(memo()).toBe(42);
    });

    it("should track invocation count when perf is enabled", () => {
      if (!PERF_ENABLED) {
        // When disabled, trackedMemo is just createMemo - counters won't be set
        const memo = trackedMemo("disabled-memo", () => 1);
        expect(memo()).toBe(1);
        expect(getMemoCounters().has("disabled-memo")).toBe(false);
        return;
      }

      resetMemoCounters();
      const memo = trackedMemo("counted-memo", () => 99);
      memo(); // trigger evaluation
      const counters = getMemoCounters();
      expect(counters.has("counted-memo")).toBe(true);
      expect(counters.get("counted-memo")).toBeGreaterThanOrEqual(1);
    });
  });

  describe("resetMemoCounters", () => {
    it("should reset all counters to zero", () => {
      if (!PERF_ENABLED) return;

      trackedMemo("reset-test", () => 1);
      resetMemoCounters();
      expect(getMemoCounters().get("reset-test")).toBe(0);
    });
  });

  describe("trackInterval / untrackInterval", () => {
    beforeEach(() => {
      // Clean up any leaked timers from previous tests
    });

    it("should track active timer count", () => {
      const initial = getActiveTimerCount();
      const id = trackInterval(() => {}, 100_000);
      if (PERF_ENABLED) {
        expect(getActiveTimerCount()).toBe(initial + 1);
      }
      untrackInterval(id);
      if (PERF_ENABLED) {
        expect(getActiveTimerCount()).toBe(initial);
      }
    });

    it("should actually create a working interval", async () => {
      let called = false;
      const id = trackInterval(() => {
        called = true;
      }, 10);

      await new Promise((r) => setTimeout(r, 50));
      expect(called).toBe(true);
      untrackInterval(id);
    });

    it("should stop the interval on untrack", async () => {
      let count = 0;
      const id = trackInterval(() => {
        count++;
      }, 10);

      await new Promise((r) => setTimeout(r, 50));
      untrackInterval(id);
      const countAfterStop = count;

      await new Promise((r) => setTimeout(r, 50));
      expect(count).toBe(countAfterStop);
    });
  });
});
