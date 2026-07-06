import { readFileSync } from "fs";
import { join } from "path";
import { CLAUDE_DIR } from "./config";

interface PermissionSettings {
  allow: string[];
  deny: string[];
  ask: string[];
  defaultMode?: string;
}

interface CacheEntry {
  settings: PermissionSettings;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/** Tools auto-approved under acceptEdits mode */
const ACCEPT_EDITS_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Override for global settings directory (testing only) */
let globalSettingsDir: string | null = null;

export function clearPermissionCache(): void {
  cache.clear();
}

export function _setGlobalSettingsDir(dir: string | null): void {
  globalSettingsDir = dir;
}

function readSettingsFile(path: string): Partial<PermissionSettings> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const json = JSON.parse(raw);
    return json?.permissions ?? null;
  } catch {
    return null;
  }
}

/**
 * Load and merge layered settings for a given project cwd.
 *
 * Layers (in order):
 *   1. ~/.claude/settings.json           (global)
 *   2. {cwd}/.claude/settings.json       (project shared)
 *   3. {cwd}/.claude/settings.local.json (project local)
 *
 * Arrays (allow/deny/ask) are concatenated. defaultMode is last-wins.
 */
function loadSettings(cwd: string): PermissionSettings {
  const globalDir = globalSettingsDir ?? CLAUDE_DIR;
  const layers = [
    join(globalDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];

  const merged: PermissionSettings = {
    allow: [],
    deny: [],
    ask: [],
    defaultMode: undefined,
  };

  for (const path of layers) {
    const perms = readSettingsFile(path);
    if (!perms) continue;

    if (Array.isArray(perms.allow)) merged.allow.push(...perms.allow);
    if (Array.isArray(perms.deny)) merged.deny.push(...perms.deny);
    if (Array.isArray(perms.ask)) merged.ask.push(...perms.ask);
    if (perms.defaultMode) merged.defaultMode = perms.defaultMode;
  }

  return merged;
}

function getSettings(cwd: string): PermissionSettings {
  const now = Date.now();
  const entry = cache.get(cwd);
  if (entry && now - entry.loadedAt < CACHE_TTL_MS) {
    return entry.settings;
  }
  const settings = loadSettings(cwd);
  cache.set(cwd, { settings, loadedAt: now });
  return settings;
}

/** Parse "Bash(git *)" → { tool: "Bash", arg: "git *" }. Bare names → arg: null. */
function parsePattern(pattern: string): { tool: string; arg: string | null } {
  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) {
    return { tool: pattern, arg: null };
  }
  const tool = pattern.slice(0, parenIdx);
  const arg = pattern.slice(parenIdx + 1, -1);
  return { tool, arg };
}

/** Extract the matchable argument from tool input (command, file_path, url, etc.) */
function extractArg(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string | null {
  if (!toolInput) return null;

  switch (toolName) {
    case "Bash":
      return typeof toolInput.command === "string" ? toolInput.command : null;
    case "Read":
    case "Write":
    case "Edit":
      return typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : null;
    case "NotebookEdit":
      return typeof toolInput.notebook_path === "string"
        ? toolInput.notebook_path
        : null;
    case "WebFetch":
      return typeof toolInput.url === "string" ? toolInput.url : null;
    default:
      return null;
  }
}

/**
 * Match argument against pattern. Forms:
 *   "domain:github.com" → URL hostname match
 *   "git *"             → prefix "git " (space wildcard)
 *   "git:*"             → prefix "git"  (colon wildcard)
 *   "src/*"             → prefix "src/" (path wildcard)
 *   ".env*"             → prefix ".env" (suffix wildcard)
 *   "npm test"          → exact match
 */
function argMatches(patternArg: string, actualArg: string): boolean {
  if (patternArg.startsWith("domain:")) {
    const domain = patternArg.slice("domain:".length);
    try {
      return new URL(actualArg).hostname === domain;
    } catch {
      return false;
    }
  }

  // "git:*" → strip ":*", prefix match on "git"
  if (patternArg.endsWith(":*")) {
    return actualArg.startsWith(patternArg.slice(0, -2));
  }

  // "git *", "src/*", ".env*" → strip "*", prefix match (keeps trailing space/slash)
  if (patternArg.endsWith("*")) {
    return actualArg.startsWith(patternArg.slice(0, -1));
  }

  return actualArg === patternArg;
}

function matchesAny(
  patterns: string[],
  toolName: string,
  toolInput?: Record<string, unknown>,
): boolean {
  const actualArg = extractArg(toolName, toolInput);

  for (const pattern of patterns) {
    const { tool, arg: patternArg } = parsePattern(pattern);
    if (tool !== toolName) continue;
    if (patternArg === null) return true; // bare name matches all
    if (actualArg === null) continue;
    if (argMatches(patternArg, actualArg)) return true;
  }

  return false;
}

/**
 * Check if a tool requires permission, considering user settings.
 *
 * Precedence: deny > ask > allow > defaultMode.
 * Returns true (requires permission) when no cwd or no settings.
 */
export function toolRequiresPermission(
  toolName: string,
  toolInput?: Record<string, unknown>,
  cwd?: string,
): boolean {
  if (!cwd) return true;

  let settings: PermissionSettings;
  try {
    settings = getSettings(cwd);
  } catch {
    return true;
  }

  const hasSettings =
    settings.allow.length > 0 ||
    settings.deny.length > 0 ||
    settings.ask.length > 0 ||
    !!settings.defaultMode;

  if (!hasSettings) return true;

  if (settings.defaultMode === "bypassPermissions") return false;

  if (matchesAny(settings.deny, toolName, toolInput)) return true;
  if (matchesAny(settings.ask, toolName, toolInput)) return true;
  if (matchesAny(settings.allow, toolName, toolInput)) return false;

  if (
    settings.defaultMode === "acceptEdits" &&
    ACCEPT_EDITS_TOOLS.has(toolName)
  ) {
    return false;
  }
  if (settings.defaultMode === "dontAsk") return true;

  return true;
}
