import { describe, it, expect } from "bun:test";
import { formatAge, formatInvocation, isValidInvocationId } from "./invoke";
import type { InvocationRecord } from "../daemon/invocation-manager";

describe("formatAge", () => {
  it("renders seconds / minutes / hours buckets", () => {
    const now = Date.now();
    expect(formatAge(now - 5_000)).toBe("5s");
    expect(formatAge(now - 125_000)).toBe("2m");
    expect(formatAge(now - 7_200_000)).toBe("2h");
  });

  it("clamps a future startedAt to 0s", () => {
    expect(formatAge(Date.now() + 10_000)).toBe("0s");
  });
});

describe("formatInvocation", () => {
  function rec(over: Partial<InvocationRecord>): InvocationRecord {
    return {
      invocationId: "inv_x",
      agent: "claude",
      cwd: "/tmp",
      startedAt: Date.now(),
      status: "running",
      ...over,
    };
  }

  it("renders a running invocation with a live age", () => {
    const line = formatInvocation(
      rec({ status: "running", startedAt: Date.now() - 3_000 }),
    );
    expect(line).toContain("inv_x");
    expect(line).toContain("claude");
    expect(line).toContain("running");
  });

  it("renders a succeeded invocation with its duration", () => {
    const line = formatInvocation(
      rec({ status: "succeeded", durationMs: 4_000 }),
    );
    expect(line).toContain("succeeded");
    expect(line).toContain("4s");
  });

  it("renders a failed invocation with its kind", () => {
    const line = formatInvocation(
      rec({ status: "failed", kind: "rate_limit", durationMs: 1_000 }),
    );
    expect(line).toContain("failed (rate_limit)");
  });

  it("renders a cancelled invocation as cancelled, not failed", () => {
    // Regression guard for the cancel-status fix: a cancel must read as
    // `cancelled`, never `failed (cancelled)`.
    const line = formatInvocation(
      rec({ status: "cancelled", kind: "cancelled", durationMs: 1_000 }),
    );
    expect(line).toContain("cancelled");
    expect(line).not.toContain("failed");
  });
});

describe("isValidInvocationId", () => {
  it("accepts a well-formed id", () => {
    expect(isValidInvocationId("inv_abc123")).toBe(true);
    expect(isValidInvocationId("inv_" + "a".repeat(32))).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isValidInvocationId("nope")).toBe(false);
    expect(isValidInvocationId("inv_")).toBe(false); // too short
    expect(isValidInvocationId("inv_" + "a".repeat(33))).toBe(false); // too long
    expect(isValidInvocationId("inv_abc/../etc")).toBe(false); // separators
    expect(isValidInvocationId("inv_abc-123")).toBe(false); // dash not allowed
  });
});
