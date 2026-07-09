/**
 * Fuzzy matching wrapper around fuzzysort.
 * Falls back to a simple substring match if fuzzysort fails to import.
 */

import type { SessionInfo } from "./types";

type FuzzysortModule = typeof import("fuzzysort");

let fuzzysort: FuzzysortModule | null = null;
let loadAttempted = false;

async function loadFuzzysort(): Promise<FuzzysortModule | null> {
  if (loadAttempted) return fuzzysort;
  loadAttempted = true;
  try {
    fuzzysort = await import("fuzzysort");
    return fuzzysort;
  } catch {
    return null;
  }
}

export type SearchResult = {
  session: SessionInfo;
  score: number;
};

/**
 * Search sessions by fuzzy-matching against project name, cwd, agent type,
 * branch, and last prompt.
 */
export async function search(
  sessions: SessionInfo[],
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) {
    return sessions.map((s) => ({ session: s, score: 0 }));
  }

  const fs = await loadFuzzysort();

  if (fs) {
    // Prepare search targets
    const targets = sessions.map((s) => {
      const searchText = [
        s.project,
        s.cwd,
        s.agentType,
        s.gitBranch,
        s.lastPrompt,
      ]
        .filter(Boolean)
        .join(" ");
      return { session: s, searchText };
    });

    const results = fs.go(query, targets, {
      key: "searchText",
      allowTypo: true,
      limit: 100,
    });

    return results.map((r) => ({
      session: r.obj.session,
      score: r.score,
    }));
  }

  // Fallback: simple case-insensitive substring match
  const q = query.toLowerCase();
  return sessions
    .map((s) => {
      const searchText = [
        s.project,
        s.cwd,
        s.agentType,
        s.gitBranch,
        s.lastPrompt,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const idx = searchText.indexOf(q);
      return {
        session: s,
        score: idx >= 0 ? (1000 - idx) / 1000 : -1,
      };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
}
