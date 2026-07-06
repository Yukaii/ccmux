import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  toolRequiresPermission,
  clearPermissionCache,
  _setGlobalSettingsDir,
} from "./permission-resolver";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "perm-test-"));
}

function writeSettings(dir: string, perms: Record<string, unknown>): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({ permissions: perms }),
  );
}

function writeLocalSettings(dir: string, perms: Record<string, unknown>): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: perms }),
  );
}

describe("permission-resolver", () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    clearPermissionCache();
    tmpDir = makeTmpDir();
    globalDir = makeTmpDir();
    _setGlobalSettingsDir(globalDir);
  });

  afterEach(() => {
    _setGlobalSettingsDir(null);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  describe("fallback behavior", () => {
    it("requires permission when no cwd provided", () => {
      expect(toolRequiresPermission("Read")).toBe(true);
      expect(toolRequiresPermission("Bash")).toBe(true);
    });

    it("requires permission when settings file missing", () => {
      expect(toolRequiresPermission("Read", undefined, tmpDir)).toBe(true);
      expect(toolRequiresPermission("Bash", undefined, tmpDir)).toBe(true);
    });

    it("requires permission when settings are malformed", () => {
      mkdirSync(join(tmpDir, ".claude"), { recursive: true });
      writeFileSync(join(tmpDir, ".claude", "settings.json"), "not json");
      expect(toolRequiresPermission("Bash", undefined, tmpDir)).toBe(true);
    });

    it("requires permission when settings have no permissions", () => {
      mkdirSync(join(tmpDir, ".claude"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".claude", "settings.json"),
        JSON.stringify({ model: "opus" }),
      );
      expect(toolRequiresPermission("Bash", undefined, tmpDir)).toBe(true);
    });
  });

  describe("pattern matching - simple name", () => {
    it("matches exact tool name in allow list", () => {
      writeSettings(tmpDir, { allow: ["Bash"] });
      expect(
        toolRequiresPermission("Bash", { command: "anything" }, tmpDir),
      ).toBe(false);
    });

    it("does not match different tool name", () => {
      writeSettings(tmpDir, { allow: ["Read"] });
      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        true,
      );
    });
  });

  describe("pattern matching - exact arg", () => {
    it("matches Bash with exact command", () => {
      writeSettings(tmpDir, { allow: ["Bash(npm test)"] });
      expect(
        toolRequiresPermission("Bash", { command: "npm test" }, tmpDir),
      ).toBe(false);
    });

    it("does not match different command", () => {
      writeSettings(tmpDir, { allow: ["Bash(npm test)"] });
      expect(
        toolRequiresPermission("Bash", { command: "npm start" }, tmpDir),
      ).toBe(true);
    });
  });

  describe("pattern matching - wildcard suffix with space", () => {
    it('matches "Bash(git *)" for git commands', () => {
      writeSettings(tmpDir, { allow: ["Bash(git *)"] });
      expect(
        toolRequiresPermission("Bash", { command: "git status" }, tmpDir),
      ).toBe(false);
      expect(
        toolRequiresPermission(
          "Bash",
          { command: "git push origin main" },
          tmpDir,
        ),
      ).toBe(false);
    });

    it('does not match "Bash(git *)" for non-git commands', () => {
      writeSettings(tmpDir, { allow: ["Bash(git *)"] });
      expect(
        toolRequiresPermission("Bash", { command: "npm test" }, tmpDir),
      ).toBe(true);
    });
  });

  describe("pattern matching - wildcard suffix with colon", () => {
    it('matches "Bash(bun run:*)" for bun run commands', () => {
      writeSettings(tmpDir, { allow: ["Bash(bun run:*)"] });
      expect(
        toolRequiresPermission(
          "Bash",
          { command: "bun run typecheck" },
          tmpDir,
        ),
      ).toBe(false);
      expect(
        toolRequiresPermission("Bash", { command: "bun run build" }, tmpDir),
      ).toBe(false);
    });

    it("does not match unrelated commands", () => {
      writeSettings(tmpDir, { allow: ["Bash(bun run:*)"] });
      expect(
        toolRequiresPermission("Bash", { command: "npm run build" }, tmpDir),
      ).toBe(true);
    });
  });

  describe("pattern matching - file path wildcard", () => {
    it('matches "Write(src/*)" for files under src/', () => {
      writeSettings(tmpDir, { allow: ["Write(src/*)"] });
      expect(
        toolRequiresPermission("Write", { file_path: "src/index.ts" }, tmpDir),
      ).toBe(false);
      expect(
        toolRequiresPermission(
          "Write",
          { file_path: "src/lib/config.ts" },
          tmpDir,
        ),
      ).toBe(false);
    });

    it("does not match files outside src/", () => {
      writeSettings(tmpDir, { allow: ["Write(src/*)"] });
      expect(
        toolRequiresPermission("Write", { file_path: "test/index.ts" }, tmpDir),
      ).toBe(true);
    });
  });

  describe("pattern matching - domain", () => {
    it('matches "WebFetch(domain:github.com)" for GitHub URLs', () => {
      writeSettings(tmpDir, { allow: ["WebFetch(domain:github.com)"] });
      expect(
        toolRequiresPermission(
          "WebFetch",
          { url: "https://github.com/user/repo" },
          tmpDir,
        ),
      ).toBe(false);
    });

    it("does not match different domains", () => {
      writeSettings(tmpDir, { allow: ["WebFetch(domain:github.com)"] });
      // Non-matching domain falls through to default (requires permission)
      expect(
        toolRequiresPermission(
          "WebFetch",
          { url: "https://example.com/page" },
          tmpDir,
        ),
      ).toBe(true);
    });

    it("deny blocks non-matching domains", () => {
      writeSettings(tmpDir, {
        allow: ["WebFetch(domain:github.com)"],
        deny: ["WebFetch"],
      });
      expect(
        toolRequiresPermission(
          "WebFetch",
          { url: "https://example.com/page" },
          tmpDir,
        ),
      ).toBe(true);
      // github.com is denied too because deny is checked first (bare "WebFetch" matches all)
      expect(
        toolRequiresPermission(
          "WebFetch",
          { url: "https://github.com/user/repo" },
          tmpDir,
        ),
      ).toBe(true);
    });
  });

  describe("pattern matching - MCP tools", () => {
    it("matches exact MCP tool name", () => {
      writeSettings(tmpDir, { allow: ["mcp__server__tool"] });
      expect(toolRequiresPermission("mcp__server__tool", {}, tmpDir)).toBe(
        false,
      );
    });

    it("does not match different MCP tool", () => {
      writeSettings(tmpDir, { allow: ["mcp__server__tool"] });
      expect(toolRequiresPermission("mcp__other__tool", {}, tmpDir)).toBe(true);
    });
  });

  describe("precedence", () => {
    it("deny overrides allow", () => {
      writeSettings(tmpDir, {
        allow: ["Bash(git *)"],
        deny: ["Bash(git push:*)"],
      });
      expect(
        toolRequiresPermission(
          "Bash",
          { command: "git push origin main" },
          tmpDir,
        ),
      ).toBe(true);
      expect(
        toolRequiresPermission("Bash", { command: "git status" }, tmpDir),
      ).toBe(false);
    });

    it("ask overrides allow", () => {
      writeSettings(tmpDir, {
        allow: ["Bash(git *)"],
        ask: ["Bash(git push:*)"],
      });
      expect(
        toolRequiresPermission(
          "Bash",
          { command: "git push origin main" },
          tmpDir,
        ),
      ).toBe(true);
    });

    it("allow makes permission-required tool auto-approved", () => {
      writeSettings(tmpDir, { allow: ["Bash"] });
      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        false,
      );
    });
  });

  describe("defaultMode", () => {
    it("bypassPermissions makes everything auto-approved", () => {
      writeSettings(tmpDir, { defaultMode: "bypassPermissions" });
      expect(
        toolRequiresPermission("Bash", { command: "rm -rf /" }, tmpDir),
      ).toBe(false);
      expect(
        toolRequiresPermission("Write", { file_path: "test.ts" }, tmpDir),
      ).toBe(false);
      expect(toolRequiresPermission("mcp__server__tool", {}, tmpDir)).toBe(
        false,
      );
    });

    it("acceptEdits auto-approves Edit/Write/NotebookEdit", () => {
      writeSettings(tmpDir, { defaultMode: "acceptEdits" });
      expect(
        toolRequiresPermission("Edit", { file_path: "test.ts" }, tmpDir),
      ).toBe(false);
      expect(
        toolRequiresPermission("Write", { file_path: "test.ts" }, tmpDir),
      ).toBe(false);
      expect(
        toolRequiresPermission(
          "NotebookEdit",
          { notebook_path: "test.ipynb" },
          tmpDir,
        ),
      ).toBe(false);
    });

    it("acceptEdits still requires permission for Bash", () => {
      writeSettings(tmpDir, { defaultMode: "acceptEdits" });
      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        true,
      );
    });

    it("dontAsk requires permission for everything not in allow", () => {
      writeSettings(tmpDir, {
        allow: ["Read", "Glob"],
        defaultMode: "dontAsk",
      });
      expect(toolRequiresPermission("Read", undefined, tmpDir)).toBe(false);
      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        true,
      );
      expect(
        toolRequiresPermission("Write", { file_path: "f.ts" }, tmpDir),
      ).toBe(true);
    });
  });

  describe("merging layers", () => {
    it("project settings extend global allow list", () => {
      writeSettings(tmpDir, { allow: ["Bash(bun test:*)"] });

      expect(
        toolRequiresPermission("Bash", { command: "bun test src/lib" }, tmpDir),
      ).toBe(false);
    });

    it("project local overrides defaultMode from shared", () => {
      writeSettings(tmpDir, { defaultMode: "acceptEdits" });
      writeLocalSettings(tmpDir, { defaultMode: "bypassPermissions" });

      expect(
        toolRequiresPermission("Bash", { command: "rm -rf /" }, tmpDir),
      ).toBe(false);
    });

    it("deny from project adds to global deny", () => {
      writeSettings(tmpDir, { allow: ["Bash"], deny: ["Bash(rm -rf:*)"] });

      expect(
        toolRequiresPermission("Bash", { command: "rm -rf /" }, tmpDir),
      ).toBe(true);
      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        false,
      );
    });
  });

  describe("caching", () => {
    it("second call uses cache", () => {
      writeSettings(tmpDir, { allow: ["Bash"] });

      const first = toolRequiresPermission("Bash", { command: "ls" }, tmpDir);
      // Overwrite with deny - should still be cached
      writeSettings(tmpDir, { deny: ["Bash"] });
      const second = toolRequiresPermission("Bash", { command: "ls" }, tmpDir);

      expect(first).toBe(false);
      expect(second).toBe(false); // still cached
    });

    it("clearPermissionCache forces re-read", () => {
      writeSettings(tmpDir, { allow: ["Bash"] });
      toolRequiresPermission("Bash", { command: "ls" }, tmpDir);

      writeSettings(tmpDir, { deny: ["Bash"] });
      clearPermissionCache();

      expect(toolRequiresPermission("Bash", { command: "ls" }, tmpDir)).toBe(
        true,
      );
    });
  });

  describe("edge cases", () => {
    it("handles tool with no input", () => {
      writeSettings(tmpDir, { allow: ["Bash(npm test)"] });
      // Bash pattern with arg should not match when no input provided
      expect(toolRequiresPermission("Bash", undefined, tmpDir)).toBe(true);
    });

    it("handles pattern with arg but tool input missing relevant field", () => {
      writeSettings(tmpDir, { allow: ["Bash(npm test)"] });
      expect(toolRequiresPermission("Bash", { other: "field" }, tmpDir)).toBe(
        true,
      );
    });

    it("handles Edit tool with file_path pattern", () => {
      writeSettings(tmpDir, { allow: ["Edit(src/*)"] });
      expect(
        toolRequiresPermission("Edit", { file_path: "src/foo.ts" }, tmpDir),
      ).toBe(false);
    });

    it("handles NotebookEdit tool with notebook_path", () => {
      writeSettings(tmpDir, { allow: ["NotebookEdit(notebooks/*)"] });
      expect(
        toolRequiresPermission(
          "NotebookEdit",
          { notebook_path: "notebooks/test.ipynb" },
          tmpDir,
        ),
      ).toBe(false);
    });

    it("handles invalid URL in WebFetch domain matching", () => {
      // Invalid URL doesn't match allow pattern, falls through to default (requires permission)
      writeSettings(tmpDir, { allow: ["WebFetch(domain:github.com)"] });
      expect(
        toolRequiresPermission("WebFetch", { url: "not a url" }, tmpDir),
      ).toBe(true);
    });

    it("invalid URL with deny falls through to deny", () => {
      writeSettings(tmpDir, {
        allow: ["WebFetch(domain:github.com)"],
        deny: ["WebFetch"],
      });
      expect(
        toolRequiresPermission("WebFetch", { url: "not a url" }, tmpDir),
      ).toBe(true);
    });

    it("deny with .env pattern", () => {
      writeSettings(tmpDir, { deny: ["Read(.env*)"] });
      expect(
        toolRequiresPermission("Read", { file_path: ".env.local" }, tmpDir),
      ).toBe(true);
    });
  });
});
