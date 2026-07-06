import type { AttentionType, TmuxPane } from "../types/session";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import { detectTerminalStatus } from "./terminal-detector";
import { capturePane } from "./pane-io";

type PaneState = "plan_approval" | "working" | "waiting" | "idle" | "active";

export interface PaneDetectionResult {
  state: PaneState;
  attentionType: AttentionType;
  pendingTool: string | null;
}

function paneDetectionResult(
  state: PaneState,
  attentionType: AttentionType = null,
  pendingTool: string | null = null,
): PaneDetectionResult {
  return { state, attentionType, pendingTool };
}

/**
 * Classify pane title using universal agent status signals.
 *
 * - Braille spinner (U+2800-U+28FF) as first char → "working"
 * - ✳ (U+2733) as first char → "not_working"
 * - Otherwise → "unknown"
 */
export function classifyPaneTitle(
  title: string | null,
): "working" | "not_working" | "unknown" {
  if (!title || title.length === 0) return "unknown";
  const cp = title.codePointAt(0)!;
  if (cp >= 0x2800 && cp <= 0x28ff) return "working";
  if (cp === 0x2733) return "not_working";
  return "unknown";
}

const IDLE_COMMANDS = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "-zsh",
  "-bash",
  "nvim",
  "vim",
  "vi",
]);

/**
 * Check if the pane's foreground command indicates Claude is not running.
 */
export function isIdleCommand(command: string | null): boolean {
  if (!command) return false;
  return IDLE_COMMANDS.has(command);
}

/**
 * Classify pane content into a PaneState based on visible patterns.
 */
export function classifyPaneContent(content: string): PaneDetectionResult {
  if (content.includes("/.claude/plans/")) {
    return paneDetectionResult("plan_approval", "plan_approval");
  }

  const detected = detectTerminalStatus(content, CLAUDE_AGENT_DEF);
  if (detected.status === "waiting") {
    return paneDetectionResult(
      "waiting",
      detected.attentionType,
      detected.pendingTool,
    );
  }

  return paneDetectionResult("active");
}

/**
 * Detect pane state using tiered signals:
 *
 * 1. Shell/editor foreground command → idle (Claude not running)
 * 2. Braille spinner in pane title → working
 * 3. ✳ in pane title → idle unless content shows waiting/plan approval
 * 4. Unknown title or no pane data → fall back to content capture
 */
export async function detectPaneState(
  paneId: string,
  pane?: TmuxPane,
): Promise<PaneDetectionResult> {
  if (pane) {
    if (isIdleCommand(pane.currentCommand)) {
      return paneDetectionResult("idle");
    }

    const titleState = classifyPaneTitle(pane.paneTitle);
    if (titleState === "working") {
      return paneDetectionResult("working");
    }

    if (titleState === "not_working") {
      const detection = classifyPaneContent(await capturePane(paneId, 20));
      return detection.state === "active"
        ? paneDetectionResult("idle")
        : detection;
    }
  }

  return classifyPaneContent(await capturePane(paneId, 20));
}
