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

function fg(c: [number, number, number]) { return `${CSI}38;2;${c[0]};${c[1]};${c[2]}m`; }
function bg(c: [number, number, number]) { return `${CSI}48;2;${c[0]};${c[1]};${c[2]}m`; }

// ── Active palette ────────────────────────────────────────────
let P: Palette = DEFAULT_PALETTE;

// Cached ANSI codes for the active palette (recomputed on setPalette)
let FG_BORDER = ""; let BG_BG = ""; let FG_FG = ""; let FG_MUTED = "";
let BG_ACCENT = ""; let FG_BG = ""; let BG_SURFACE = "";
let BG_SELECTED = ""; let FG_GREEN = ""; let FG_YELLOW = "";
let FG_RED = ""; let FG_PURPLE = ""; let FG_CYAN = "";
let FG_ACCENT = ""; let FG_ORANGE = "";

function cachePalette(): void {
  BG_BG = bg(P.bg); FG_BORDER = fg(P.border);
  FG_FG = fg(P.fg); FG_MUTED = fg(P.muted);
  BG_ACCENT = bg(P.accent); FG_BG = fg(P.bg);
  BG_SURFACE = bg(P.surface); BG_SELECTED = bg(P.selected);
  FG_GREEN = fg(P.green); FG_YELLOW = fg(P.yellow);
  FG_RED = fg(P.red); FG_PURPLE = fg(P.purple);
  FG_CYAN = fg(P.cyan); FG_ACCENT = fg(P.accent);
  FG_ORANGE = fg(P.orange);
}

export function setPalette(p: Palette): void { P = p; cachePalette(); }
cachePalette(); // init with default

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
  const rb = isSelected ? BG_SELECTED : (isBg ? BG_SURFACE : "");
  const fgc = isSelected ? FG_FG : (isBg ? FG_MUTED : FG_MUTED);
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
    parts.push(` ${DIM}${FG_CYAN}${truncate(session.gitBranch, 18)}${RESET}${rb}${sf}`);
  }
  if (isBg) {
    parts.push(` ${DIM}${FG_MUTED}[bg]${RESET}${rb}`);
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
  return `${FG_ACCENT}${BOLD}${text}${RESET}${" ".repeat(Math.max(0, maxW - text.length))}`;
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
  out += BG_BG + FG_BORDER;
  out += "┌" + "─".repeat(maxW) + "┐" + RESET + "\r\n";

  // ── Search bar ──
  out += BG_BG + FG_BORDER + "│" + RESET + BG_BG + " ";
  if (searchMode || searchQuery) {
    const q = truncate(searchQuery, maxW - 3);
    const before = q.slice(0, searchCursor);
    const at = q.slice(searchCursor, searchCursor + 1) || " ";
    const after = q.slice(searchCursor + 1);
    out += FG_FG + before;
    if (searchMode) {
      out += BG_ACCENT + FG_BG + at + RESET + BG_BG;
    } else {
      out += at;
    }
    out += FG_FG + after;
  } else {
    out += FG_MUTED + "/ search";
  }
  // Pad to exactly maxW visible characters
  const contentLen = searchMode
    ? (searchQuery ? truncate(searchQuery, maxW - 3).length : 1) // cursor char when empty
    : 8; // "/ search"
  out += " ".repeat(maxW - 1 - contentLen);
  out += RESET + BG_BG + FG_BORDER + "│" + RESET + "\r\n";

  // ── Divider ──
  out += BG_BG + FG_BORDER + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

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
      out += BG_BG + FG_BORDER + "│" + RESET;
      if (i === Math.floor(listHeight / 2)) {
        out += BG_BG + " ".repeat(Math.max(0, pad)) + FG_MUTED + msg + RESET;
        out += BG_BG + " ".repeat(Math.max(0, maxW - pad - msg.length));
      } else {
        out += BG_BG + " ".repeat(maxW);
      }
      out += FG_BORDER + "│" + RESET + "\r\n";
    }
  } else {
    const end = Math.min(flatEntries.length, scrollOffset + listHeight);
    for (let i = scrollOffset; i < end; i++) {
      const entry = flatEntries[i]!;
      out += BG_BG + FG_BORDER + "│" + RESET;
      if (entry.kind === "group") {
        out += BG_BG + " " + renderGroupHeader(entry.groupName!, entry.groupCount!, maxW - 1);
      } else {
        const isSel = entry.sessionIndex === selectedIndex;
        out += renderRow(entry.session!, isSel, 1, maxW);
      }
      out += BG_BG + FG_BORDER + "│" + RESET + "\r\n";
    }
    for (let i = end - scrollOffset; i < listHeight; i++) {
      out += BG_BG + FG_BORDER + "│" + " ".repeat(maxW) + "│" + RESET + "\r\n";
    }
  }

  // ── Divider ──
  out += BG_BG + FG_BORDER + "├" + "─".repeat(maxW) + "┤" + RESET + "\r\n";

  // ── Footer ──
  const groupingLabel = useGrouping ? "g:flat" : "g:group";
  const modeLabel = searchMode ? "esc:exit" : "/:search";
  const footer = `${filtered.length} sessions │ ${groupingLabel} │ j/k:nav  ${modeLabel}  enter:select  q:quit`;
  const padFt = Math.max(0, maxW - 2 - footer.length);
  out += BG_BG + FG_BORDER + "│ " + RESET;
  out += BG_BG + FG_MUTED + footer + " ".repeat(padFt) + RESET;
  out += BG_BG + FG_BORDER + " │" + RESET + "\r\n";

  // ── Bottom ──
  out += BG_BG + FG_BORDER + "└" + "─".repeat(maxW) + "┘" + RESET;

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
