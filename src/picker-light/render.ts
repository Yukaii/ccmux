/**
 * Raw ANSI rendering for the lightweight picker.
 *
 * Layout:
 *   ┌─ Search bar ───────────────────────────────────────┐
 *   │ ▎ Search query...                                  │
 *   ├─ Session list (scrollable) ────────────────────────┤
 *   │ ▸ my-project                                       │ <- group header
 *   │   ● cc  main  Fix the login bug                    │
 *   │   ◉ oc  feature/auth  Add JWT validation           │
 *   │ ▸ other-project                                    │
 *   │   ○ cu  dev  Update styles                         │
 *   ├─ Footer ───────────────────────────────────────────┤
 *   │ 3 sessions  j/k:nav  g:group  /:search  q:quit     │
 *   └────────────────────────────────────────────────────┘
 */

import type { SessionInfo } from "./types";

// ── ANSI helpers ──────────────────────────────────────────────
const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_SCREEN = `${CSI}2J`;
const CURSOR_HOME = `${CSI}H`;
const CURSOR_TO = (row: number, col: number) => `${CSI}${row};${col}H`;

function fg(r: number, g: number, b: number) { return `${CSI}38;2;${r};${g};${b}m`; }
function bg(r: number, g: number, b: number) { return `${CSI}48;2;${r};${g};${b}m`; }

function rgb(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

// ── Theme ─────────────────────────────────────────────────────
const C = {
  bg: rgb("#1a1b26"),
  surface: rgb("#24253a"),
  border: rgb("#3b3d54"),
  fg: rgb("#c0caf5"),
  muted: rgb("#565f89"),
  accent: rgb("#7aa2f7"),
  green: rgb("#9ece6a"),
  yellow: rgb("#e0af68"),
  red: rgb("#f7768e"),
  purple: rgb("#bb9af7"),
  cyan: rgb("#7dcfff"),
  orange: rgb("#ff9e64"),
  selected: rgb("#364a82"),
} as const;

// ── Agent display ─────────────────────────────────────────────
const AGENT_SHORT: Record<string, string> = {
  claude: "cc", opencode: "oc", codex: "cx", cursor: "cu", gemini: "gm", pi: "pi",
};
function agentLabel(t: string): string { return AGENT_SHORT[t] ?? t.slice(0, 2); }

// ── Status icon ───────────────────────────────────────────────
function statusIcon(s: SessionInfo): { icon: string; color: number[] } {
  if (s.trackingMode === "background") return { icon: "⏺", color: C.purple };
  if (s.status === "working") return { icon: "●", color: C.green };
  if (s.status === "waiting") {
    return s.attentionState === "unread"
      ? { icon: "✦", color: C.orange }
      : { icon: "◉", color: C.yellow };
  }
  return s.attentionState === "unread"
    ? { icon: "✦", color: C.accent }
    : { icon: "○", color: C.muted };
}

// ── Truncation ────────────────────────────────────────────────
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ── Types ─────────────────────────────────────────────────────
export type GroupedView =
  | { kind: "flat"; sessions: SessionInfo[] }
  | { kind: "grouped"; groups: Map<string, SessionInfo[]> };

export interface RenderState {
  sessions: SessionInfo[];
  filtered: SessionInfo[];
  selectedIndex: number;
  scrollOffset: number;
  searchQuery: string;
  searchCursor: number;
  listHeight: number;
  width: number;
  emptyText: string;
  useGrouping: boolean;
  searchMode: boolean;
}

// ── Session row ───────────────────────────────────────────────
function renderRow(session: SessionInfo, isSelected: boolean, indent: number, maxW: number): string {
  const isBg = session.trackingMode === "background";
  const rb = isSelected ? bg(...C.selected) : (isBg ? bg(...C.surface) : "");
  const fgC = isSelected ? fg(...C.fg) : (isBg ? fg(...C.muted) : fg(...C.muted));
  const sf = isBg ? DIM : "";
  const si = statusIcon(session);
  const selPad = isSelected ? " " : " ";

  const left = [
    rb,
    " ".repeat(indent),
    sf,
    selPad,
    fg(...si.color), si.icon, RESET, rb, sf,
    " ",
    DIM, fgC, agentLabel(session.agentType), RESET, rb, sf,
    "  ",
    isSelected ? BOLD : "", fgC, truncate(session.project, 30), RESET, rb, sf,
    session.gitBranch ? ` ${DIM}${fg(...C.cyan)}${truncate(session.gitBranch, 18)}${RESET}${rb}${sf}` : "",
    isBg ? ` ${DIM}${fg(...C.muted)}[bg]${RESET}${rb}` : "",
  ].join("");

  // Prompt preview (right-aligned)
  let right = "";
  if (session.lastPrompt) {
    const p = session.lastPrompt.replace(/\n/g, " ").trim();
    if (p) {
      right = `${DIM}${sf}${fgC}${truncate(p, Math.min(50, maxW - 50))}${RESET}${rb}`;
    }
  }

  const leftVis = `${sf}${" ".repeat(indent)} ${si.icon} ${agentLabel(session.agentType)}  ${truncate(session.project, 30)}${session.gitBranch ? " " + truncate(session.gitBranch, 18) : ""}${isBg ? " [bg]" : ""}`;
  const rightVis = right.replace(/\x1b\[[0-9;]*m/g, "");
  const fill = Math.max(1, maxW - leftVis.length - rightVis.length);
  return left + " ".repeat(fill) + right + RESET;
}

// ── Group header ──────────────────────────────────────────────
function renderGroupHeader(name: string, count: number, maxW: number): string {
  const text = `▸ ${name} (${count})`;
  return `${fg(...C.accent)}${BOLD}${text}${RESET}${" ".repeat(Math.max(0, maxW - text.length))}`;
}

// ── Main render ───────────────────────────────────────────────
export function render(
  state: RenderState,
  view: GroupedView,
  writer: (s: string) => void,
): void {
  const { filtered, selectedIndex, scrollOffset, searchQuery, searchCursor, listHeight, width, emptyText, useGrouping, searchMode } = state;
  const maxW = width - 2; // inside borders

  let out = CURSOR_HOME;

  // ── Top border ──
  out += bg(...C.bg) + fg(...C.border);
  out += "┌" + "─".repeat(maxW) + "┐" + RESET + "\r\n";

  // ── Search bar ──
  out += bg(...C.bg) + fg(...C.border) + "│" + RESET + bg(...C.bg) + " ";
  if (searchMode || searchQuery) {
    const q = truncate(searchQuery, maxW - 3);
    const before = q.slice(0, searchCursor);
    const at = q.slice(searchCursor, searchCursor + 1) || " ";
    const after = q.slice(searchCursor + 1);
    out += fg(...C.fg) + before;
    if (searchMode) {
      out += bg(...C.accent) + fg(...C.bg) + at + RESET + bg(...C.bg);
    } else {
      out += at;
    }
    out += fg(...C.fg) + after;
  } else {
    out += fg(...C.muted) + "/ search";
  }
  const searchVisLen = (searchMode || searchQuery) ? truncate(searchQuery || "", maxW - 3).length : 8;
  out += " ".repeat(Math.max(1, maxW - 1 - searchVisLen));
  out += RESET + bg(...C.bg) + fg(...C.border) + "│" + RESET + "\r\n";

  // ── Divider ──
  out += bg(...C.bg) + fg(...C.border) + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

  // ── Build flat rendering list ──────────────────────────────
  interface FlatEntry {
    kind: "group" | "session";
    groupName?: string;
    groupCount?: number;
    session?: SessionInfo;
    sessionArrayIndex: number;
  }

  let flatEntries: FlatEntry[];

  if (view.kind === "grouped" && useGrouping) {
    flatEntries = [];
    for (const [name, sessions] of view.groups) {
      flatEntries.push({ kind: "group", groupName: name, groupCount: sessions.length, sessionArrayIndex: -1 });
      for (const s of sessions) {
        flatEntries.push({ kind: "session", session: s, sessionArrayIndex: filtered.indexOf(s) });
      }
    }
  } else {
    flatEntries = filtered.map((s) => ({
      kind: "session" as const,
      session: s,
      sessionArrayIndex: filtered.indexOf(s),
    }));
  }

  // ── Session list ──
  if (flatEntries.length === 0) {
    const msg = emptyText;
    const pad = Math.floor((maxW - msg.length) / 2);
    for (let i = 0; i < listHeight; i++) {
      out += bg(...C.bg) + fg(...C.border) + "│" + RESET;
      if (i === Math.floor(listHeight / 2)) {
        out += bg(...C.bg) + " ".repeat(Math.max(0, pad)) + fg(...C.muted) + msg + RESET;
        out += bg(...C.bg) + " ".repeat(Math.max(0, maxW - pad - msg.length));
      } else {
        out += bg(...C.bg) + " ".repeat(maxW);
      }
      out += fg(...C.border) + "│" + RESET + "\r\n";
    }
  } else {
    const end = Math.min(flatEntries.length, scrollOffset + listHeight);
    for (let i = scrollOffset; i < end; i++) {
      const entry = flatEntries[i]!;
      out += bg(...C.bg) + fg(...C.border) + "│" + RESET;

      if (entry.kind === "group") {
        out += bg(...C.bg) + " " + renderGroupHeader(entry.groupName!, entry.groupCount!, maxW - 1);
      } else {
        const isSel = entry.sessionArrayIndex === selectedIndex;
        out += renderRow(entry.session!, isSel, 1, maxW);
      }

      out += bg(...C.bg) + fg(...C.border) + "│" + RESET + "\r\n";
    }
    // Fill remaining lines
    for (let i = end - scrollOffset; i < listHeight; i++) {
      out += bg(...C.bg) + fg(...C.border) + "│" + " ".repeat(maxW) + "│" + RESET + "\r\n";
    }
  }

  // ── Divider ──
  out += bg(...C.bg) + fg(...C.border) + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

  // ── Footer ──
  const groupingLabel = useGrouping ? "g:flat" : "g:group";
  const modeLabel = searchMode ? "esc:exit-search" : "/:search";
  const footer = `${filtered.length} sessions │ ${groupingLabel} │ j/k:nav  ${modeLabel}  enter:select  q:quit`;
  const padFt = Math.max(0, maxW - 2 - footer.length);
  out += bg(...C.bg) + fg(...C.border) + "│ " + RESET;
  out += bg(...C.bg) + fg(...C.muted) + footer + " ".repeat(padFt) + RESET;
  out += bg(...C.bg) + fg(...C.border) + " │" + RESET + "\r\n";

  // ── Bottom border ──
  out += bg(...C.bg) + fg(...C.border) + "└" + "─".repeat(maxW) + "┘" + RESET;

  // Cursor on search bar
  out += CURSOR_TO(2, 3 + (searchQuery ? Math.min(searchCursor, searchQuery.length) : 0));

  writer(out);
}

// ── Terminal setup / teardown ─────────────────────────────────
export function setupTerminal(writer: (s: string) => void): { width: number; height: number } {
  writer(HIDE_CURSOR + CLEAR_SCREEN + CURSOR_HOME);

  let w = 80, h = 24;
  try {
    const out = process.stdout as unknown as { columns?: number; rows?: number };
    if (typeof out.columns === "number") w = out.columns;
    if (typeof out.rows === "number") h = out.rows;
  } catch {}

  return { width: Math.max(40, w), height: Math.max(10, h) };
}

export function teardownTerminal(writer: (s: string) => void): void {
  writer(SHOW_CURSOR + CLEAR_SCREEN + CURSOR_HOME + RESET);
}

export function writeStderr(s: string): void { process.stderr.write(s); }
export function writeStdout(s: string): void { process.stdout.write(s); }
