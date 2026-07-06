import type { AgentDef } from "./agents";
import { BUILTIN_AGENTS } from "./agents";

/**
 * Pick a built-in agent by name, throwing a fixture-load error rather
 * than returning `undefined` so tests fail at the lookup site instead of
 * downstream with a confusing "cannot read property of undefined".
 *
 * Consolidates six near-identical copies of `BUILTIN_AGENTS.find + throw`
 * that grew across the daemon and lib test suites
 * (`agentByName`, `agent`, `requireAgent` plus inline call sites).
 * AGENTS.md flagged the consolidation threshold at the sixth copy.
 */
export function getBuiltinAgent(name: string): AgentDef {
  const found = BUILTIN_AGENTS.find((a) => a.name === name);
  if (!found) throw new Error(`built-in agent fixture missing: ${name}`);
  return found;
}
