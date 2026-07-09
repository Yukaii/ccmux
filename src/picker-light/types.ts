/**
 * Minimal types for the lightweight picker.
 * Mirrors the relevant fields from the daemon API without the full Session type.
 */

export interface SessionInfo {
  id: string;
  agentType: string;
  project: string;
  cwd: string;
  status: "working" | "waiting" | "idle";
  attentionType: "permission" | "question" | "plan_approval" | null;
  pendingTool: string | null;
  tmuxPane: string | null;
  tmuxTarget: string | null;
  gitBranch: string | null;
  lastPrompt: string | null;
  version: string | null;
  attentionState: "unread" | "read" | null;
  trackingMode: string;
  /** background-agent sessions have no pane */
}

export interface DaemonSessionsResponse {
  sessions: SessionInfo[];
}
