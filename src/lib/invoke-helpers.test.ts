import { describe, expect, it } from "bun:test";
import {
  matchErrorRules,
  mergePromptWithStdin,
  resolveInvokePositionals,
} from "./invoke-helpers";

describe("mergePromptWithStdin", () => {
  it("combines prompt arg and stdin with a newline", () => {
    expect(mergePromptWithStdin("hello", "world")).toBe("hello\nworld");
  });

  it("returns stdin when prompt arg is undefined", () => {
    expect(mergePromptWithStdin(undefined, "world")).toBe("world");
  });

  it("returns prompt arg when stdin is empty", () => {
    expect(mergePromptWithStdin("hello", "")).toBe("hello");
  });

  it("throws when no prompt is provided", () => {
    expect(() => mergePromptWithStdin("", "")).toThrow("No prompt provided");
    expect(() => mergePromptWithStdin(undefined, "")).toThrow(
      "No prompt provided",
    );
  });
});

describe("matchErrorRules", () => {
  it("returns null when no rules are provided", () => {
    expect(matchErrorRules("text", [])).toBeNull();
  });

  it("returns null when no rule matches", () => {
    expect(
      matchErrorRules("hello", [{ match: /xyz/, kind: "rate_limit" }]),
    ).toBeNull();
  });

  it("returns the first matching rule", () => {
    const rules: Parameters<typeof matchErrorRules>[1] = [
      { match: /a/, kind: "rate_limit" },
      { match: /b/, kind: "agent_error" },
    ];

    expect(matchErrorRules("ab", rules)).toEqual({
      kind: "rate_limit",
      message: "a",
    });
  });

  it("uses custom messages and falls back to the matched substring", () => {
    expect(
      matchErrorRules("hello", [
        { match: /hello/, kind: "agent_error", message: "custom" },
      ]),
    ).toEqual({ kind: "agent_error", message: "custom" });

    expect(
      matchErrorRules("rate limited", [{ match: /rate/, kind: "rate_limit" }]),
    ).toEqual({ kind: "rate_limit", message: "rate" });
  });

  it("returns the first match for a /g-flagged user-supplied regex", () => {
    // A custom errorRule from ccmux.json could carry the /g flag. A
    // naive test-then-match would advance lastIndex on the first probe
    // and return null (or the next match) on the second; this test
    // pins the single-exec() behavior.
    expect(
      matchErrorRules("limit limit limit", [
        { match: /limit/g, kind: "rate_limit" },
      ]),
    ).toEqual({ kind: "rate_limit", message: "limit" });
  });
});

describe("resolveInvokePositionals", () => {
  const knownAgentNames = ["claude", "codex", "cursor", "opencode", "gemini"];

  it("defaults to claude with no prompt for empty args", () => {
    expect(resolveInvokePositionals([], knownAgentNames)).toEqual({
      agent: "claude",
      promptArg: undefined,
    });
  });

  it("treats a single known agent as the agent", () => {
    expect(resolveInvokePositionals(["codex"], knownAgentNames)).toEqual({
      agent: "codex",
      promptArg: undefined,
    });
  });

  it("treats a single unknown arg as the claude prompt", () => {
    expect(resolveInvokePositionals(["hello world"], knownAgentNames)).toEqual({
      agent: "claude",
      promptArg: "hello world",
    });
  });

  it("treats a known first arg as the agent and the rest as prompt", () => {
    expect(resolveInvokePositionals(["codex", "hi"], knownAgentNames)).toEqual({
      agent: "codex",
      promptArg: "hi",
    });
  });

  it("treats unknown args as the claude prompt", () => {
    expect(
      resolveInvokePositionals(["hello", "world"], knownAgentNames),
    ).toEqual({
      agent: "claude",
      promptArg: "hello world",
    });
  });

  it("joins multiple prompt args after a known agent", () => {
    expect(
      resolveInvokePositionals(["gemini", "say", "hi"], knownAgentNames),
    ).toEqual({
      agent: "gemini",
      promptArg: "say hi",
    });
  });
});
