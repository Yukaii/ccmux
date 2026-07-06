/**
 * Shared inline JSONL builders for Codex adapter and integration tests.
 *
 * These mirror the real Codex rollout schema (`type`, `timestamp`, `payload`)
 * and exist so a schema change is felt at one point of the test surface
 * instead of two. Only test files import this; runtime code does not.
 */

export function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export function codexSessionMeta(
  overrides: Record<string, unknown> = {},
): object {
  return {
    timestamp: "2026-04-01T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "019c7dd4-ff41-79c0-8270-d030bb51cd90",
      timestamp: "2026-04-01T12:00:00.000Z",
      cwd: "/Users/test/project",
      cli_version: "0.57.0",
      git: { branch: "main" },
      ...overrides,
    },
  };
}

export function codexEventMsg(
  timestamp: string,
  payload: Record<string, unknown>,
): object {
  return { timestamp, type: "event_msg", payload };
}

export function codexResponseItem(timestamp: string, payload: object): object {
  return { timestamp, type: "response_item", payload };
}
