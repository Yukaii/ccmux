import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CLAUDE_DIR } from "../../../lib/config";
import type { TmuxPane } from "../../../types/session";

export interface HistoryEntry {
  project: string;
  sessionId: string;
  timestamp: number;
}

export function readClaudeHistory(): HistoryEntry[] {
  const historyPath = join(CLAUDE_DIR, "history.jsonl");
  if (!existsSync(historyPath)) return [];

  try {
    const content = readFileSync(historyPath, "utf-8");
    const entries: HistoryEntry[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      try {
        entries.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // Skip malformed lines.
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * First history entry for the project that started after the pane start
 * time. Entry-based (not I/O-performing) so the binder can run it over an
 * observation snapshot.
 */
export function matchSessionToPaneByTimestampIn(
  entries: readonly HistoryEntry[],
  pane: Pick<TmuxPane, "startTime">,
  projectPath: string,
): string | null {
  if (!pane.startTime) return null;

  const paneStartTimeMs = pane.startTime * 1000;
  for (const entry of entries) {
    if (entry.project === projectPath && entry.timestamp >= paneStartTimeMs) {
      return entry.sessionId;
    }
  }

  return null;
}

/**
 * ALL history timestamps for a session (one per submitted prompt), in file
 * order. Replaces the former first-entry-only lookup: the
 * binder's cost function scans every entry, so a resumed session
 * correlates to today's run (an entry just after today's process start)
 * instead of deterministically to its days-old original prompt.
 */
export function getSessionTimestampsIn(
  entries: readonly HistoryEntry[],
  sessionId: string,
  projectPath: string,
): number[] {
  const timestamps: number[] = [];
  for (const entry of entries) {
    if (entry.sessionId === sessionId && entry.project === projectPath) {
      timestamps.push(entry.timestamp);
    }
  }
  return timestamps;
}
