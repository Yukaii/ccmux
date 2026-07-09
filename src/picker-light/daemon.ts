/**
 * Daemon HTTP client for the lightweight picker.
 * Simple fetch-based — no SSE, no persistent connection.
 */

import type { SessionInfo } from "./types";

const DAEMON_URL = "http://127.0.0.1:2269";

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  try {
    const res = await fetch(`${DAEMON_URL}/sessions`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions: SessionInfo[] };
    return data.sessions ?? [];
  } catch {
    return [];
  }
}
