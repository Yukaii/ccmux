import { describe, it, expect } from "bun:test";
import { createBuiltinHookAdapters } from "./index";

describe("createBuiltinHookAdapters", () => {
  it("returns the Claude, Codex, Cursor, OpenCode, and pi hook adapters", () => {
    const adapters = createBuiltinHookAdapters();
    const agentTypes = adapters.map((a) => a.agentType).sort();
    expect(agentTypes).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
  });

  it("yields fresh adapter instances on every call so callers can't mutate shared state", () => {
    const first = createBuiltinHookAdapters();
    const second = createBuiltinHookAdapters();
    expect(first).not.toBe(second);
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).not.toBe(second[i]);
    }
  });

  it("returns no duplicate agentTypes", () => {
    const adapters = createBuiltinHookAdapters();
    const unique = new Set(adapters.map((a) => a.agentType));
    expect(unique.size).toBe(adapters.length);
  });
});
