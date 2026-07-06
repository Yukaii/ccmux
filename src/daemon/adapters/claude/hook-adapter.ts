import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  CLAUDE_HOOKS_DIR as HOOKS_DIR,
  MARKERS_DIR,
  SETTINGS_FILE,
} from "../../../lib/config";
import {
  SESSION_END_HOOK_SCRIPT,
  SESSION_START_HOOK_SCRIPT,
  STATE_NOTIFY_HOOK_SCRIPT,
} from "./hook-scripts";
import type {
  HookAdapter,
  HookAdapterOutcome,
  HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";

const SESSION_START_SCRIPT = "ccmux-session-start.sh";
const SESSION_END_SCRIPT = "ccmux-session-end.sh";
const STATE_NOTIFY_SCRIPT = "ccmux-state-notify.sh";

interface HookConfig {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookConfig[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcher[];
    SessionEnd?: HookMatcher[];
    Notification?: HookMatcher[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Claude-specific hook integration. Owns install/uninstall of hook scripts
 * and settings.json entries, JSONL-based liveness checks, and delegation of
 * marker add/remove events to the Claude `LogWatcher`.
 */
export class ClaudeHookAdapter implements HookAdapter {
  readonly agentType = "claude";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    mkdirSync(HOOKS_DIR, { recursive: true });
    mkdirSync(MARKERS_DIR, { recursive: true });

    const scripts = [
      { name: SESSION_START_SCRIPT, content: SESSION_START_HOOK_SCRIPT },
      { name: SESSION_END_SCRIPT, content: SESSION_END_HOOK_SCRIPT },
      { name: STATE_NOTIFY_SCRIPT, content: STATE_NOTIFY_HOOK_SCRIPT },
    ] as const;
    for (const { name, content } of scripts) {
      const path = join(HOOKS_DIR, name);
      const existed = existsSync(path);
      const current = existed ? readFileSync(path, "utf-8") : null;
      if (current === content) {
        lines.push(`Hook script already up to date: ${path}`);
        continue;
      }
      writeFileSync(path, content);
      chmodSync(path, 0o755);
      lines.push(`${existed ? "Updated" : "Created"} hook script: ${path}`);
      changed = true;
    }

    let settings: ClaudeSettings = {};
    const settingsExisted = existsSync(SETTINGS_FILE);
    if (settingsExisted) {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }

    const hookSlots: Array<{
      slot: "SessionStart" | "SessionEnd" | "Notification";
      matcher: string;
      script: string;
    }> = [
      { slot: "SessionStart", matcher: "", script: SESSION_START_SCRIPT },
      { slot: "SessionEnd", matcher: "", script: SESSION_END_SCRIPT },
      {
        slot: "Notification",
        matcher: "idle_prompt|permission_prompt",
        script: STATE_NOTIFY_SCRIPT,
      },
    ];

    let settingsChanged = false;
    for (const { slot, matcher, script } of hookSlots) {
      const added = ensureHook(
        settings,
        slot,
        matcher,
        join(HOOKS_DIR, script),
        lines,
      );
      settingsChanged ||= added;
    }

    if (settingsChanged) {
      if (settingsExisted) {
        const backupPath = `${SETTINGS_FILE}.backup`;
        copyFileSync(SETTINGS_FILE, backupPath);
        lines.push(`Backed up settings to ${backupPath}`);
      }
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
      lines.push(`Updated ${SETTINGS_FILE}`);
      changed = true;
    }

    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    if (existsSync(SETTINGS_FILE)) {
      const settings: ClaudeSettings = JSON.parse(
        readFileSync(SETTINGS_FILE, "utf-8"),
      );

      const removedStart = removeHook(
        settings,
        "SessionStart",
        SESSION_START_SCRIPT,
      );
      const removedEnd = removeHook(settings, "SessionEnd", SESSION_END_SCRIPT);
      const removedNotify = removeHook(
        settings,
        "Notification",
        STATE_NOTIFY_SCRIPT,
      );
      const removed = removedStart || removedEnd || removedNotify;

      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (removed) {
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
        lines.push(`Removed hooks from ${SETTINGS_FILE}`);
        changed = true;
      }
    }

    for (const script of [
      SESSION_START_SCRIPT,
      SESSION_END_SCRIPT,
      STATE_NOTIFY_SCRIPT,
    ]) {
      const scriptPath = join(HOOKS_DIR, script);
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        lines.push(`Removed ${scriptPath}`);
        changed = true;
      }
    }

    if (existsSync(MARKERS_DIR)) {
      let removed = 0;
      for (const entry of readdirSync(MARKERS_DIR)) {
        if (!entry.startsWith("claude-") || !entry.endsWith(".json")) continue;
        try {
          unlinkSync(join(MARKERS_DIR, entry));
          removed += 1;
        } catch {
          // best-effort; next daemon sweep will catch stragglers
        }
      }
      if (removed > 0) {
        lines.push(`Removed ${removed} claude marker(s) from ${MARKERS_DIR}`);
        changed = true;
      }
    }

    return { lines, changed };
  }

  isInstalled(): boolean {
    if (!existsSync(SETTINGS_FILE)) return false;
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
      const startHooks = settings?.hooks?.SessionStart;
      if (!Array.isArray(startHooks)) return false;
      return startHooks.some((h: { hooks?: { command?: string }[] }) =>
        h.hooks?.some((hook) => hook.command?.includes(SESSION_START_SCRIPT)),
      );
    } catch {
      return false;
    }
  }

  // Claude does not write the per-session JSONL until the user submits the
  // first prompt, so a JSONL-existence check would race-delete fresh
  // markers in the seconds between SessionStart and the first turn. PID
  // liveness in cleanupStaleMarkers is authoritative.
  isSessionStillLive(_marker: SessionPidMarker): boolean {
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    ctx.getLogWatcher(this.agentType)?.handleMarkerAdded(marker);
  }

  async onMarkerRemoved(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    ctx.getLogWatcher(this.agentType)?.handleMarkerRemoved(marker);
  }
}

function ensureHook(
  settings: ClaudeSettings,
  slot: "SessionStart" | "SessionEnd" | "Notification",
  matcher: string,
  scriptPath: string,
  lines: string[],
): boolean {
  const existing = settings.hooks?.[slot] ?? [];
  const scriptName = scriptPath.split("/").pop() ?? "";
  const alreadyInstalled = existing.some(
    (h) => h.hooks?.some((hook) => hook.command?.includes(scriptName)) ?? false,
  );
  if (alreadyInstalled) {
    lines.push(`${slot} hook already installed in settings.json`);
    return false;
  }

  settings.hooks = {
    ...(settings.hooks ?? {}),
    [slot]: [
      ...existing,
      { matcher, hooks: [{ type: "command", command: scriptPath }] },
    ],
  };
  lines.push(`Added ${slot} hook to settings.json`);
  return true;
}

function removeHook(
  settings: ClaudeSettings,
  slot: "SessionStart" | "SessionEnd" | "Notification",
  scriptName: string,
): boolean {
  const existing = settings.hooks?.[slot];
  if (!existing) return false;
  const filtered = existing.filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes(scriptName)),
  );
  if (filtered.length === existing.length) return false;
  if (filtered.length === 0) {
    delete settings.hooks![slot];
  } else {
    settings.hooks![slot] = filtered;
  }
  return true;
}
