import type { AgentDef } from "../../lib/agents";
import type { Invoker } from "./invoker";

/**
 * Maps an `AgentDef` to the `Invoker` that should handle its `ccmux invoke`
 * request. Replaces the manager's hand-rolled `if (agent.invokeMode) ...
 * else if (agent.name === "claude") ...` dispatch fork. The registry is
 * built once at daemon startup with both invokers (claude-interactive +
 * subprocess) and queried per `POST /invoke`.
 *
 * Dispatch rule (carried verbatim from the manager's pre-2.4 fork):
 * - `agent.invokeMode` set → subprocess invoker (codex / cursor / opencode
 *   / gemini, plus any custom ccmux.json agent that ships an `invokeMode`).
 * - `agent.name === "claude"` → claude-interactive invoker.
 * - otherwise → `undefined` (custom ccmux.json agent without `invokeMode`;
 *   the manager surfaces this as `agent_error` carrying the word
 *   `invokeMode` so the existing CLI error matchers keep working).
 *
 * Reading `agent.invokeMode` (rather than enumerating built-in agents at
 * construction time) means a custom agent declared in
 * `~/.config/ccmux/ccmux.json` with its own `invokeMode` resolves the same
 * way without registry-time registration.
 */
export class InvocationRegistry {
  constructor(
    private readonly claude: Invoker,
    private readonly subprocess: Invoker,
  ) {}

  get(agent: AgentDef): Invoker | undefined {
    if (agent.invokeMode) return this.subprocess;
    if (agent.name === "claude") return this.claude;
    return undefined;
  }
}
