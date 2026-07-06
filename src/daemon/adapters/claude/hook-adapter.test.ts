import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-claude-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const claudeDir = join(tempRoot, ".claude");
const hooksDir = join(claudeDir, "hooks");
const projectsDir = join(claudeDir, "projects");
const settingsFile = join(claudeDir, "settings.json");
const markersDir = join(tempRoot, "markers");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  CLAUDE_DIR: claudeDir,
  CLAUDE_HOOKS_DIR: hooksDir,
  PROJECTS_DIR: projectsDir,
  SETTINGS_FILE: settingsFile,
  MARKERS_DIR: markersDir,
}));

import { ClaudeHookAdapter } from "./hook-adapter";

function writeSettings(content: object) {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(content, null, 2) + "\n");
}

describe("ClaudeHookAdapter", () => {
  let adapter: ClaudeHookAdapter;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    adapter = new ClaudeHookAdapter();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("uninstall markers cleanup", () => {
    it("removes only claude-* markers and preserves markers owned by other agents", async () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear",
              hooks: [
                {
                  type: "command",
                  command: join(hooksDir, "ccmux-session-start.sh"),
                },
              ],
            },
          ],
        },
      });

      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "claude-session-a.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "claude-session-b.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "codex-session-c.json"),
        '{"agent_type":"codex"}',
      );
      writeFileSync(
        join(markersDir, "opencode-session-d.json"),
        '{"agent_type":"opencode"}',
      );

      await adapter.uninstall();

      expect(existsSync(markersDir)).toBe(true);
      const remaining = readdirSync(markersDir).sort();
      expect(remaining).toEqual([
        "codex-session-c.json",
        "opencode-session-d.json",
      ]);
    });

    it("reports how many claude markers it removed", async () => {
      writeSettings({ hooks: {} });
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "claude-x.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "claude-y.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(join(markersDir, "codex-z.json"), '{"agent_type":"codex"}');

      const { lines } = await adapter.uninstall();
      const reportLine = lines.find((l) => l.includes("claude marker"));
      expect(reportLine).toBeTruthy();
      expect(reportLine).toContain("2");
    });

    it("leaves the markers dir alone when no claude markers are present", async () => {
      writeSettings({ hooks: {} });
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "codex-only.json"),
        '{"agent_type":"codex"}',
      );

      const { lines } = await adapter.uninstall();
      expect(lines.some((l) => l.includes("claude marker"))).toBe(false);
      expect(
        readFileSync(join(markersDir, "codex-only.json"), "utf-8"),
      ).toContain("codex");
    });
  });

  describe("changed flag accuracy", () => {
    it("uninstall reports changed=false when settings.json has no ccmux-owned hooks", async () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "/usr/local/bin/my-own-hook.sh" },
              ],
            },
          ],
        },
      });

      const { changed, lines } = await adapter.uninstall();

      expect(changed).toBe(false);
      expect(lines.some((l) => l.includes("Removed hooks from"))).toBe(false);
      const after = JSON.parse(readFileSync(settingsFile, "utf-8"));
      expect(after.hooks.SessionStart).toHaveLength(1);
    });

    it("install reports changed=false on idempotent re-run", async () => {
      const first = await adapter.install();
      expect(first.changed).toBe(true);

      const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionEnd).toBeDefined();
      expect(settings.hooks.Notification).toBeDefined();

      const second = await adapter.install();
      expect(second.changed).toBe(false);
      expect(second.lines.some((l) => l.includes("already up to date"))).toBe(
        true,
      );
      expect(second.lines.some((l) => l.includes("already installed in"))).toBe(
        true,
      );
    });
  });

  describe("isInstalled", () => {
    it("returns false when settings.json is absent", () => {
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns false when settings.json has only user-owned hooks", () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: "/Users/me/my-own-session-start.sh",
                },
              ],
            },
          ],
        },
      });
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns true after install()", async () => {
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
    });

    it("returns false on malformed settings.json", () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsFile, "{ not valid json");
      expect(adapter.isInstalled()).toBe(false);
    });
  });

  describe("uninstall preserves user-owned hooks", () => {
    it("removes ccmux entries but leaves user-authored entries in the same slot", async () => {
      await adapter.install();
      const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      settings.hooks.SessionStart.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "/Users/me/my-own-session-start.sh",
          },
        ],
      });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

      await adapter.uninstall();

      const after = JSON.parse(readFileSync(settingsFile, "utf-8"));
      const commands = (
        (after.hooks?.SessionStart ?? []) as Array<{
          hooks?: Array<{ command?: string }>;
        }>
      ).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));
      expect(commands).toContain("/Users/me/my-own-session-start.sh");
      expect(commands.some((c) => c.includes("ccmux-session-start.sh"))).toBe(
        false,
      );
    });
  });
});
