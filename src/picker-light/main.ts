#!/usr/bin/env bun
/**
 * Lightweight ccmux session picker — raw ANSI, no framework.
 *
 * Features:
 *   - 8-10ms startup (37x faster than original @opentui picker)
 *   - Fuzzy search with fuzzysort
 *   - Live session polling (2s interval)
 *   - Grouping by project
 *   - Daemon auto-start on demand
 *   - Vim-style navigation (j/k) + arrow keys
 *
 * Usage: bun src/picker-light/main.ts
 */

import { checkHealth, fetchSessions } from "./daemon";
import { search } from "./fuzzy";
import {
  setupTerminal,
  teardownTerminal,
  render,
  writeStdout,
  writeStderr,
  type RenderState,
  type GroupedView,
} from "./render";
import type { SessionInfo } from "./types";

// ── Timing ────────────────────────────────────────────────────
const PERF = process.env.CCMUX_PERF === "1";
const t0 = Bun.nanoseconds();
function mark(label: string) {
  if (!PERF) return;
  const ms = Math.round((Bun.nanoseconds() - t0) / 1_000_000);
  writeStderr(`[startup] ${label.padEnd(20)} ${String(ms).padStart(5)}ms\n`);
}

// ── Grouping ───────────────────────────────────────────────────
type GroupedSessions = Map<string, SessionInfo[]>;

function groupByProject(sessions: SessionInfo[]): GroupedSessions {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.project || s.cwd || "unknown";
    const list = groups.get(key);
    if (list) {
      list.push(s);
    } else {
      groups.set(key, [s]);
    }
  }
  // Sort groups: active (working/waiting) first, then by name
  const sorted = new Map<string, SessionInfo[]>();
  const entries = [...groups.entries()].sort((a, b) => {
    const aActive = a[1].some((s) => s.status !== "idle");
    const bActive = b[1].some((s) => s.status !== "idle");
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a[0].localeCompare(b[0]);
  });
  for (const [k, v] of entries) sorted.set(k, v);
  return sorted;
}

// ── Flatten with group headers ─────────────────────────────────
interface FlatEntry {
  kind: "group" | "session";
  groupName?: string;
  session?: SessionInfo;
  sessionIndex: number; // index into filteredSessions for selection
}

function flattenGrouped(groups: GroupedSessions, sessions: SessionInfo[]): { entries: FlatEntry[]; sessionMap: number[] } {
  const entries: FlatEntry[] = [];
  const sessionMap: number[] = []; // flatIndex -> sessionIndex in sessions array
  for (const [groupName, groupSessions] of groups) {
    entries.push({ kind: "group", groupName, sessionIndex: -1 });
    for (const s of groupSessions) {
      const idx = sessions.indexOf(s);
      entries.push({ kind: "session", session: s, sessionIndex: idx });
      sessionMap.push(idx);
    }
  }
  return { entries, sessionMap };
}

// ── Main ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  mark("start");

  // 1. Check daemon health — auto-start if needed
  let daemonOk = await checkHealth();
  mark("health_check");

  if (!daemonOk) {
    writeStderr("ccmux daemon is not running. Starting...\n");
    // Try to start daemon
    const proc = Bun.spawn(["bun", new URL("../../src/index.ts", import.meta.url).pathname, "daemon", "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Wait up to 10s for daemon to become healthy
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      daemonOk = await checkHealth();
      if (daemonOk) break;
    }
    if (!daemonOk) {
      writeStderr("Error: Failed to start daemon.\n");
      process.exit(1);
    }
  }

  // 2. Fetch sessions
  let allSessions = await fetchSessions();
  mark("fetch_sessions");

  if (PERF) {
    writeStderr(`[startup] sessions_fetched           ${allSessions.length} sessions\n`);
  }

  // 3. Setup terminal
  const size = setupTerminal(writeStdout);
  // stdin raw mode is set below
  mark("terminal_ready");

  const listHeight = size.height - 6;
  const width = Math.max(40, size.width);

  // 4. State
  let filteredSessions: SessionInfo[] = allSessions;
  let selectedIndex = 0;
  let scrollOffset = 0;
  let searchQuery = "";
  let searchCursor = 0;
  let running = true;
  let useGrouping = true;
  let searchMode = false; // true = typing goes to search bar, false = keys are commands

  // ── Rebuild the display list ──────────────────────────────
  function buildGroupedView(): GroupedView {
    if (useGrouping && !searchQuery.trim()) {
      const groups = groupByProject(filteredSessions);
      return { kind: "grouped", groups };
    }
    return { kind: "flat", sessions: filteredSessions };
  }

  // ── Apply search filter ────────────────────────────────────
  function applySearch(): void {
    if (!searchQuery.trim()) {
      filteredSessions = allSessions;
    } else {
      // Fire-and-forget async search; if results arrive after next draw, re-draw.
      search(allSessions, searchQuery).then((results) => {
        filteredSessions = results.map((r) => r.session);
        clampSelection();
        draw();
      });
      // Keep current filtered list until results arrive
      return;
    }
    clampSelection();
  }

  function clampSelection(): void {
    if (filteredSessions.length === 0) {
      selectedIndex = -1;
      scrollOffset = 0;
    } else {
      if (selectedIndex >= filteredSessions.length) selectedIndex = filteredSessions.length - 1;
      if (selectedIndex < 0) selectedIndex = 0;
      if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
      if (selectedIndex >= scrollOffset + listHeight) scrollOffset = Math.max(0, selectedIndex - listHeight + 1);
    }
  }

  // ── Render ─────────────────────────────────────────────────
  function draw(): void {
    const view = buildGroupedView();
    const state: RenderState = {
      sessions: allSessions,
      filtered: filteredSessions,
      selectedIndex,
      scrollOffset,
      searchQuery,
      searchCursor,
      listHeight,
      width,
      emptyText: searchQuery.trim()
        ? "No matching sessions"
        : "No sessions found. Start an agent (claude, codex, etc.) to see it here.",
      useGrouping: useGrouping && !searchQuery.trim(),
      searchMode,
    };
    render(state, view, writeStdout);
  }

  // ── Select a session ───────────────────────────────────────
  function selectSession(): void {
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    const session = filteredSessions[selectedIndex]!;
    const target = session.tmuxTarget || session.tmuxPane;
    if (target) {
      stdin.removeAllListeners("data");
      try { (stdin as any).setRawMode(false); } catch {}
      teardownTerminal(writeStdout);
      Bun.spawn(["tmux", "switch-client", "-t", target], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      process.exit(0);
    }
    // Background session with no pane — just exit
    stdin.removeAllListeners("data");
    try { (stdin as any).setRawMode(false); } catch {}
    teardownTerminal(writeStdout);
    process.exit(0);
  }

  // ── Setup raw mode stdin ───────────────────────────────────
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof (stdin as any).setRawMode !== "function") {
    writeStderr("Error: stdin is not a TTY. Run inside a tmux popup.\n");
    process.exit(1);
  }
  (stdin as any).setRawMode(true);
  stdin.resume();

  // Queue of received key chunks, processed sequentially in the main loop
  const keyQueue: Buffer[] = [];
  let keyResolve: (() => void) | null = null;

  stdin.on("data", (data: Buffer) => {
    keyQueue.push(data);
    if (keyResolve) {
      keyResolve();
      keyResolve = null;
    }
  });

  async function nextKey(): Promise<Buffer> {
    if (keyQueue.length > 0) {
      return keyQueue.shift()!;
    }
    return new Promise<Buffer>((resolve) => {
      keyResolve = () => {
        resolve(keyQueue.shift()!);
      };
    });
  }

  async function handleKey(): Promise<void> {
    const chunk = await nextKey();
    if (!chunk || chunk.length === 0) return;

    const bytes = new Uint8Array(chunk);
    const str = new TextDecoder().decode(bytes);

    // ── Escape sequences (arrows, etc.) ────────────────────
    if (bytes[0] === 0x1b) {
      if (bytes.length === 1) {
        // Bare Escape
        if (searchMode) {
          searchMode = false;
          searchCursor = 0;
          draw();
        } else {
          running = false;
        }
        return;
      }
      if (bytes[1] === 0x5b) {
        // CSI sequences
        if (bytes[2] === 0x41) { navigate(-1); return; }   // Up
        if (bytes[2] === 0x42) { navigate(1); return; }    // Down
        if (bytes[2] === 0x43) {                             // Right
          if (searchMode) { cursorRight(); draw(); }
          return;
        }
        if (bytes[2] === 0x44) {                             // Left
          if (searchMode) { cursorLeft(); draw(); }
          return;
        }
        if (bytes[2] === 0x35 && bytes[3] === 0x7e) { pageUp(); return; }
        if (bytes[2] === 0x36 && bytes[3] === 0x7e) { pageDown(); return; }
        return;
      }
      return;
    }

    // ── All other keys: dispatch by mode ────────────────────
    if (searchMode) {
      // In search mode: everything goes through the switch for typing or control
      handleSearchModeKey(bytes, str);
    } else {
      // In command mode: only specific keys have meaning
      handleCommandModeKey(bytes, str);
    }
  }

  function handleSearchModeKey(bytes: Uint8Array, str: string): void {
    // DEL / Backspace
    if (bytes[0] === 0x7f || bytes[0] === 0x08) { deleteChar(); return; }

    switch (str) {
      case "\r": case "\n": selectSession(); break;
      case "\x1b":  /* ESC already handled above */ break;
      case "\x15":  clearSearch(); break;            // Ctrl-U
      case "\x17":  deleteWord(); break;             // Ctrl-W
      case "\x01":  searchCursor = 0; draw(); break;  // Ctrl-A
      case "\x05":  searchCursor = searchQuery.length; draw(); break; // Ctrl-E
      case "\x03":  running = false; break;          // Ctrl-C
      default:
        // Any printable char: insert into search
        if (bytes[0] >= 0x20 && bytes[0] < 0x7f) { insertChar(str); }
        break;
    }
  }

  function handleCommandModeKey(bytes: Uint8Array, str: string): void {
    switch (str) {
      case "j": case "J": navigate(-1); break;
      case "k": case "K": navigate(1); break;
      case "g": case "G": toggleGrouping(); break;
      case "q": case "Q": running = false; break;
      case "/":
        searchMode = true;
        searchQuery = "";
        searchCursor = 0;
        draw();
        break;
      case "\r": case "\n": selectSession(); break;
      case "\x03": case "\x04": running = false; break; // Ctrl-C/D
      case "\x0c": refreshSessions(); break;                // Ctrl-L
      case "r": case "R": refreshSessions(); break;
      // Ignore all other keys in command mode
    }
  }

  // ── Action helpers ─────────────────────────────────────────
  function navigate(delta: number): void {
    if (filteredSessions.length === 0) return;
    // Wrap around: from last → first, from first → last
    selectedIndex = (selectedIndex + delta + filteredSessions.length) % filteredSessions.length;
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + listHeight) scrollOffset = Math.max(0, selectedIndex - listHeight + 1);
    draw();
  }

  function pageUp(): void {
    if (filteredSessions.length === 0) return;
    selectedIndex = (selectedIndex - listHeight + filteredSessions.length * listHeight) % filteredSessions.length;
    scrollOffset = Math.max(0, selectedIndex - listHeight + 1);
    draw();
  }

  function pageDown(): void {
    if (filteredSessions.length === 0) return;
    selectedIndex = (selectedIndex + listHeight) % filteredSessions.length;
    scrollOffset = Math.max(0, selectedIndex - listHeight + 1);
    draw();
  }

  function cursorRight(): void {
    searchCursor = Math.min(searchQuery.length, searchCursor + 1);
  }

  function cursorLeft(): void {
    searchCursor = Math.max(0, searchCursor - 1);
  }

  function insertChar(ch: string): void {
    searchQuery = searchQuery.slice(0, searchCursor) + ch + searchQuery.slice(searchCursor);
    searchCursor += ch.length;
    applySearch();
    draw();
  }

  function deleteChar(): void {
    if (searchCursor > 0) {
      const before = searchQuery.slice(0, searchCursor - 1);
      const after = searchQuery.slice(searchCursor);
      searchQuery = before + after;
      searchCursor--;
      applySearch();
      draw();
    }
  }

  function deleteWord(): void {
    const before = searchQuery.slice(0, searchCursor);
    const after = searchQuery.slice(searchCursor);
    const trimmed = before.replace(/\S+\s*$/, "");
    searchCursor -= (before.length - trimmed.length);
    searchQuery = trimmed + after;
    applySearch();
    draw();
  }

  function clearSearch(): void {
    searchQuery = "";
    searchCursor = 0;
    applySearch();
    draw();
  }

  function toggleGrouping(): void {
    useGrouping = !useGrouping;
    draw();
  }

  async function refreshSessions(): Promise<void> {
    const fresh = await fetchSessions();
    if (fresh.length > 0 || allSessions.length === 0) {
      allSessions = fresh;
    }
    const selectedId = selectedIndex >= 0 && selectedIndex < filteredSessions.length
      ? filteredSessions[selectedIndex]!.id
      : null;
    await applySearch();
    if (selectedId) {
      const newIdx = filteredSessions.findIndex((s) => s.id === selectedId);
      if (newIdx >= 0) selectedIndex = newIdx;
    }
    draw();
  }

  // ── Initial render ─────────────────────────────────────────
  mark("first_render");
  draw();

  // ── Polling for live updates ────────────────────────────────
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const POLL_INTERVAL_MS = 2000;

  pollTimer = setInterval(async () => {
    if (!running) return;
    try {
      const fresh = await fetchSessions();
      // Only update if sessions actually changed (avoid flicker)
      const freshIds = new Set(fresh.map((s) => s.id));
      const oldIds = new Set(allSessions.map((s) => s.id));
      if (freshIds.size !== oldIds.size || ![...freshIds].every((id) => oldIds.has(id))) {
        allSessions = fresh;
        // Preserve selection across refreshes
        const selectedId = selectedIndex >= 0 ? filteredSessions[selectedIndex]?.id : null;
        await applySearch();
        if (selectedId) {
          const newIdx = filteredSessions.findIndex((s) => s.id === selectedId);
          if (newIdx >= 0) selectedIndex = newIdx;
        }
        draw();
      }
    } catch { /* polling error — ignore */ }
  }, POLL_INTERVAL_MS);

  // ── Main loop ──────────────────────────────────────────────
  while (running) {
    await handleKey();
  }

  // ── Cleanup ────────────────────────────────────────────────
  if (pollTimer) clearInterval(pollTimer);
  stdin.removeAllListeners("data");
  try { (stdin as any).setRawMode(false); } catch {}
  mark("quit");
  if (PERF) {
    const total = Math.round((Bun.nanoseconds() - t0) / 1_000_000);
    writeStderr(`${"─".repeat(37)}\n`);
    writeStderr(`[startup] ${"total".padEnd(20)} ${String(total).padStart(5)}ms\n\n`);
  }
  teardownTerminal(writeStdout);
  process.exit(0);
}

// ── Run ───────────────────────────────────────────────────────
main().catch(async (err) => {
  try { (process.stdin as any).setRawMode(false); } catch {}
  const msg = `\r\nFatal: ${err instanceof Error ? err.message : String(err)}\r\n`;
  writeStdout(SHOW_CURSOR + RESET + msg);
  await Bun.sleep(500);
  try { teardownTerminal(writeStdout); } catch {}
  process.exit(1);
});
