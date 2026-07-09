/**
 * Raw ANSI rendering for the lightweight picker.
 */
import type { SessionInfo } from "./types";
import { DEFAULT_PALETTE, type Palette } from "./theme";

// ── ANSI helpers ──────────────────────────────────────────────
const CSI = "\x1b[";
export const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const CLEAR_SCREEN = `${CSI}2J`;
export const CURSOR_HOME = `${CSI}H`;
const CURSOR_TO = (row: number, col: number) => `${CSI}${row};${col}H`;

function fg(c: [number, number, number]) { return `${CSI}38;2;${c[0]};${c[1]};${c[2]}m`; }
function bg(c: [number, number, number]) { return `${CSI}48;2;${c[0]};${c[1]};${c[2]}m`; }

// ── Active palette ────────────────────────────────────────────
let P: Palette = DEFAULT_PALETTE;
export function setPalette(p: Palette): void { P = p; }

// ── Agent display ─────────────────────────────────────────────
const AGENT_SHORT: Record<string, string> = {
  claude: "cc", opencode: "oc", codex: "cx", cursor: "cu", gemini: "gm", pi: "pi",
};
function agentLabel(t: string): string { return AGENT_SHORT[t] ?? t.slice(0, 2); }

// ── Status icon ───────────────────────────────────────────────
function statusIcon(s: SessionInfo): { icon: string; color: [number, number, number] } {
  if (s.trackingMode === "background") return { icon: "⏺", color: P.purple };
  if (s.status === "working") return { icon: "●", color: P.green };
  if (s.status === "waiting") {
    return s.attentionState === "unread"
      ? { icon: "✦", color: P.orange }
      : { icon: "◉", color: P.yellow };
  }
  return s.attentionState === "unread"
    ? { icon: "✦", color: P.accent }
    : { icon: "○", color: P.muted };
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
function renderRow(
  session: SessionInfo,
  isSelected: boolean,
  indent: number,
  maxW: number,
): string {
  const isBg = session.trackingMode === "background";
  const rb = isSelected ? bg(P.selected) : (isBg ? bg(P.surface) : "");
  const fgc = isSelected ? fg(P.fg) : (isBg ? fg(P.muted) : fg(P.muted));
  const sf = isBg ? DIM : "";
  const si = statusIcon(session);

  const parts: string[] = [
    rb,
    " ".repeat(indent),
    sf,
    " ",
    fg(si.color), si.icon, RESET, rb, sf,
    " ",
    DIM, fgc, agentLabel(session.agentType), RESET, rb, sf,
    "  ",
    isSelected ? BOLD : "", fgc, truncate(session.project ?? "?", 30), RESET, rb, sf,
  ];

  if (session.gitBranch) {
    parts.push(` ${DIM}${fg(P.cyan)}${truncate(session.gitBranch, 18)}${RESET}${rb}${sf}`);
  }
  if (isBg) {
    parts.push(` ${DIM}${fg(P.muted)}[bg]${RESET}${rb}`);
  }

  const left = parts.join("");

  // Prompt preview (right-aligned)
  let right = "";
  if (session.lastPrompt) {
    const p = session.lastPrompt.replace(/\n/g, " ").trim();
    if (p) {
      right = `${DIM}${sf}${fgc}${truncate(p, Math.min(50, maxW - 50))}${RESET}${rb}`;
    }
  }

  // Width calculation (strip ANSI codes, approximate)
  const leftVis = `${sf}${" ".repeat(indent)} ${si.icon} ${agentLabel(session.agentType)}  ${truncate(session.project ?? "?", 30)}${session.gitBranch ? " " + truncate(session.gitBranch, 18) : ""}${isBg ? " [bg]" : ""}`;
  const rightVis = right.replace(/\x1b\[[0-9;]*m/g, "");
  const fill = Math.max(1, maxW - leftVis.length - rightVis.length);
  return left + " ".repeat(fill) + right + RESET;
}

// ── Group header ──────────────────────────────────────────────
function renderGroupHeader(name: string, count: number, maxW: number): string {
  const text = `▸ ${name} (${count})`;
  return `${fg(P.accent)}${BOLD}${text}${RESET}${" ".repeat(Math.max(0, maxW - text.length))}`;
}

// ── Main render ───────────────────────────────────────────────
export function render(
  state: RenderState,
  view: GroupedView,
  writer: (s: string) => void,
): void {
  const {
    filtered, selectedIndex, scrollOffset,
    searchQuery, searchCursor, listHeight,
    width, emptyText, useGrouping, searchMode,
  } = state;
  const maxW = width - 2;

  let out = CURSOR_HOME;

  // ── Top border ──
  out += bg(P.bg) + fg(P.border);
  out += "┌" + "─".repeat(maxW) + "┐" + RESET + "\r\n";

  // ── Search bar ──
  out += bg(P.bg) + fg(P.border) + "│" + RESET + bg(P.bg) + " ";
  if (searchMode || searchQuery) {
    const q = truncate(searchQuery, maxW - 3);
    const before = q.slice(0, searchCursor);
    const at = q.slice(searchCursor, searchCursor + 1) || " ";
    const after = q.slice(searchCursor + 1);
    out += fg(P.fg) + before;
    if (searchMode) {
      out += bg(P.accent) + fg(P.bg) + at + RESET + bg(P.bg);
    } else {
      out += at;
    }
    out += fg(P.fg) + after;
  } else {
    out += fg(P.muted) + "/ search";
  }
  const visLen = (searchMode || searchQuery) ? truncate(searchQuery || "", maxW - 3).length : 8;
  out += " ".repeat(Math.max(1, maxW - 1 - visLen));
  out += RESET + bg(P.bg) + fg(P.border) + "│" + RESET + "\r\n";

  // ── Divider ──
  out += bg(P.bg) + fg(P.border) + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

  // ── Build flat list ──
  interface FlatEntry {
    kind: "group" | "session";
    groupName?: string;
    groupCount?: number;
    session?: SessionInfo;
    sessionIndex: number;
  }
  let flatEntries: FlatEntry[];

  if (view.kind === "grouped" && useGrouping) {
    flatEntries = [];
    let idx = 0;
    for (const [name, sessions] of view.groups) {
      flatEntries.push({ kind: "group", groupName: name, groupCount: sessions.length, sessionIndex: -1 });
      for (const s of sessions) {
        flatEntries.push({ kind: "session", session: s, sessionIndex: idx++ });
      }
    }
  } else {
    flatEntries = filtered.map((s, i) => ({
      kind: "session", session: s, sessionIndex: i,
    }));
  }

  // ── Session list ──
  if (flatEntries.length === 0) {
    const msg = emptyText;
    const pad = Math.floor((maxW - msg.length) / 2);
    for (let i = 0; i < listHeight; i++) {
      out += bg(P.bg) + fg(P.border) + "│" + RESET;
      if (i === Math.floor(listHeight / 2)) {
        out += bg(P.bg) + " ".repeat(Math.max(0, pad)) + fg(P.muted) + msg + RESET;
        out += bg(P.bg) + " ".repeat(Math.max(0, maxW - pad - msg.length));
      } else {
        out += bg(P.bg) + " ".repeat(maxW);
      }
      out += fg(P.border) + "│" + RESET + "\r\n";
    }
  } else {
    const end = Math.min(flatEntries.length, scrollOffset + listHeight);
    for (let i = scrollOffset; i < end; i++) {
      const entry = flatEntries[i]!;
      out += bg(P.bg) + fg(P.border) + "│" + RESET;
      if (entry.kind === "group") {
        out += bg(P.bg) + " " + renderGroupHeader(entry.groupName!, entry.groupCount!, maxW - 1);
      } else {
        const isSel = entry.sessionIndex === selectedIndex;
        out += renderRow(entry.session!, isSel, 1, maxW);
      }
      out += bg(P.bg) + fg(P.border) + "│" + RESET + "\r\n";
    }
    for (let i = end - scrollOffset; i < listHeight; i++) {
      out += bg(P.bg) + fg(P.border) + "│" + " ".repeat(maxW) + "│" + RESET + "\r\n";
    }
  }

  // ── Divider ──
  out += bg(P.bg) + fg(P.border) + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

  // ── Footer ──
  const groupingLabel = useGrouping ? "g:flat" : "g:group";
  const modeLabel = searchMode ? "esc:exit" : "/:search";
  const footer = `${filtered.length} sessions │ ${groupingLabel} │ j/k:nav  ${modeLabel}  enter:select  q:quit`;
  const padFt = Math.max(0, maxW - 2 - footer.length);
  out += bg(P.bg) + fg(P.border) + "│ " + RESET;
  out += bg(P.bg) + fg(P.muted) + footer + " ".repeat(padFt) + RESET;
  out += bg(P.bg) + fg(P.border) + " │" + RESET + "\r\n";

  // ── Bottom ──
  out += bg(P.bg) + fg(P.border) + "└" + "─".repeat(maxW) + "┘" + RESET;
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
