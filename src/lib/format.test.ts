import { describe, it, expect, setSystemTime, afterAll } from "bun:test";
import { formatRelativeTime } from "./format";

describe("formatRelativeTime", () => {
  afterAll(() => setSystemTime());

  it("should format seconds", () => {
    setSystemTime(new Date("2024-01-01T12:00:30Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("30s");
  });

  it("should format minutes", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("5m");
  });

  it("should format hours", () => {
    setSystemTime(new Date("2024-01-01T15:00:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("3h");
  });

  it("should append suffix when provided", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"), " ago")).toBe(
      "5m ago",
    );
  });

  it("should use empty suffix by default", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("5m");
  });

  it("should show 0s for equal times", () => {
    setSystemTime(new Date("2024-01-01T12:00:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("0s");
  });
});
