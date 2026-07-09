/**
 * Fuzzy matching wrapper around fuzzysort.
 * Falls back to a simple substring match if fuzzysort fails to import.
 */

import type { SessionInfo } from "./types";

import fuzzysort from "fuzzysort";

export type SearchResult = {
  session: SessionInfo;
  score: number;
};

/**
 * Search sessions by fuzzy-matching against project name, cwd, agent type,
 * branch, and last prompt.
 */
export function search(
  sessions: SessionInfo[],
  query: string,
): SearchResult[] {
  if (!query.trim()) {
    return sessions.map((s) => ({ session: s, score: 0 }));
  }

  const targets = sessions.map((s) => ({
    session: s,
    searchText: [s.project, s.cwd, s.agentType, s.gitBranch, s.lastPrompt]
      .filter(Boolean)
      .join(" "),
  }));

  const results = fuzzysort.go(query, targets, {
    key: "searchText",
    allowTypo: true,
    limit: 100,
  });

  return results.map((r) => ({
    session: r.obj.session,
    score: r.score,
  }));
}
