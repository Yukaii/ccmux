import { describe, expect, it } from "bun:test";
import type { AgentDef } from "../../lib/agents";
import { getBuiltinAgent } from "../../lib/agents-test-helpers";
import { InvocationRegistry } from "./registry";
import { stubInvoker } from "./test-helpers";

const claudeStub = stubInvoker("claude-interactive");
const subprocessStub = stubInvoker("subprocess");

describe("InvocationRegistry.get", () => {
  it("returns the claude-interactive invoker for the built-in claude agent", () => {
    const registry = new InvocationRegistry(claudeStub, subprocessStub);
    const result = registry.get(getBuiltinAgent("claude"));
    expect(result).toBe(claudeStub);
  });

  it.each(["codex", "cursor", "opencode", "gemini"])(
    "returns the subprocess invoker for the built-in %s agent",
    (name) => {
      const registry = new InvocationRegistry(claudeStub, subprocessStub);
      const result = registry.get(getBuiltinAgent(name));
      expect(result).toBe(subprocessStub);
    },
  );

  it("dispatches a custom config agent with invokeMode to the subprocess invoker", () => {
    // Mirrors a `~/.config/ccmux/ccmux.json` declaration: name not in
    // BUILTIN_AGENTS, but invokeMode set. Should route to subprocess
    // without registry-time registration, otherwise custom-agent invoke
    // silently breaks.
    const custom = {
      name: "myagent",
      shortCode: "MA",
      processMatch: /myagent/,
      terminalRules: [],
      invokeMode: {
        args: ["myagent", "--print"],
        output: { kind: "stdout" },
      },
    } as unknown as AgentDef;
    const registry = new InvocationRegistry(claudeStub, subprocessStub);
    expect(registry.get(custom)).toBe(subprocessStub);
  });

  it("returns undefined for a non-claude agent without invokeMode", () => {
    // The unsupported case: custom agent with no invokeMode and not
    // named "claude". The manager surfaces this as an agent_error
    // mentioning `invokeMode`, which existing CLI tests pin.
    const noInvoke = {
      name: "no-invoke",
      shortCode: "NI",
      processMatch: /no-invoke/,
      terminalRules: [],
    } as unknown as AgentDef;
    const registry = new InvocationRegistry(claudeStub, subprocessStub);
    expect(registry.get(noInvoke)).toBeUndefined();
  });
});
