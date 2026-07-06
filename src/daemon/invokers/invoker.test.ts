import { describe, it, expect } from "bun:test";
import { getBuiltinAgent } from "../../lib/agents-test-helpers";
import type { Invoker, InvokerCapabilities } from "./invoker";
import { capabilitiesFor } from "./invoker";
import { stubInvoker } from "./test-helpers";

const claudeInvoker = stubInvoker("claude-interactive");
const subprocessInvoker = stubInvoker("subprocess");

/**
 * Each row pairs a built-in agent with the invoker the manager dispatches
 * to today, and pins the derived capabilities to what the existing
 * hand-rolled checks (the `!mode.resumeArgs` reject in
 * `SubprocessInvoker.invoke`; the `hooks_missing` branch in `server.ts`)
 * would conclude.
 *
 * Cross-pairings (Claude with subprocess, Codex with claude-interactive,
 * etc.) aren't reachable today (the registry refuses them) and aren't
 * pinned here.
 */
const CASES: Array<{
  agentName: string;
  invoker: Invoker;
  expected: InvokerCapabilities;
}> = [
  {
    agentName: "claude",
    invoker: claudeInvoker,
    expected: {
      supportsSessionResume: true,
      requiresHooks: true,
    },
  },
  {
    agentName: "codex",
    invoker: subprocessInvoker,
    expected: {
      supportsSessionResume: true,
      requiresHooks: false,
    },
  },
  {
    agentName: "cursor",
    invoker: subprocessInvoker,
    expected: {
      supportsSessionResume: true,
      requiresHooks: false,
    },
  },
  {
    agentName: "opencode",
    invoker: subprocessInvoker,
    expected: {
      supportsSessionResume: true,
      requiresHooks: false,
    },
  },
  {
    agentName: "gemini",
    invoker: subprocessInvoker,
    expected: {
      supportsSessionResume: false,
      requiresHooks: false,
    },
  },
];

describe("capabilitiesFor", () => {
  for (const { agentName, invoker, expected } of CASES) {
    it(`derives ${invoker.kind} capabilities for ${agentName}`, () => {
      const agent = getBuiltinAgent(agentName);
      expect(capabilitiesFor(agent, invoker)).toEqual(expected);
    });
  }
});
