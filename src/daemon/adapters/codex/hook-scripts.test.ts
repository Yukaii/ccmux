import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  renderSessionStartScript,
  renderStopScript,
  renderPermissionRequestScript,
} from "./hook-scripts";

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runScript(
  scriptPath: string,
  stdin: string,
): Promise<ScriptResult> {
  const proc = Bun.spawn(["/bin/bash", scriptPath], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("codex hook script templates", () => {
  const markersDir = "/tmp/ccmux-codex-marker-dir-never-used";

  describe("renderSessionStartScript", () => {
    it("interpolates the markers directory path", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(`MARKERS_DIR="${markersDir}"`);
    });

    it("reads session_id and transcript_path from stdin as snake_case", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(".session_id");
      expect(script).toContain(".transcript_path");
    });

    it("writes the marker via atomic tmp+mv with codex- prefix", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(
        `MARKER_FILE="$MARKERS_DIR/codex-$SESSION_ID.json"`,
      );
      expect(script).toContain(`"$MARKER_FILE.tmp"`);
      expect(script).toContain(`mv "$MARKER_FILE.tmp" "$MARKER_FILE"`);
    });

    it("records agent_type codex and initial idle state", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(`agent_type: "codex"`);
      expect(script).toContain(`state: "idle"`);
    });
  });

  describe("renderStopScript", () => {
    it("refreshes state to idle and clears pending tool fields", () => {
      const script = renderStopScript(markersDir);
      expect(script).toContain(`state: "idle"`);
      expect(script).toContain("pending_tool: null");
      expect(script).toContain("permission_context: null");
    });

    it("is a no-op when the marker does not exist", () => {
      const script = renderStopScript(markersDir);
      expect(script).toContain(`[ -f "$MARKER_FILE" ] || exit 0`);
    });
  });

  describe("renderPermissionRequestScript", () => {
    it("reads tool_name and tool_input.command from stdin", () => {
      const script = renderPermissionRequestScript(markersDir);
      expect(script).toContain(".tool_name");
      expect(script).toContain(".tool_input.command");
    });

    it("sets state to waiting_permission and populates pending_tool", () => {
      const script = renderPermissionRequestScript(markersDir);
      expect(script).toContain(`state: "waiting_permission"`);
      expect(script).toContain("pending_tool: (if $tool");
      expect(script).toContain("permission_context: (if $ctx");
    });

    it("documents the Deny footgun on exit 2 + stderr", () => {
      const script = renderPermissionRequestScript(markersDir);
      expect(script).toContain("Deny");
    });
  });

  describe.each([
    ["ccmux-session-start.sh", renderSessionStartScript],
    ["ccmux-stop.sh", renderStopScript],
    ["ccmux-permission-request.sh", renderPermissionRequestScript],
  ] as const)("static safety checks (%s)", (_name, render) => {
    const script = render(markersDir);
    const executableLines = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    it("does not use `set -e`", () => {
      expect(executableLines).not.toMatch(/^\s*set\s+-[a-z]*e/m);
    });

    it("does not emit `exit 2`", () => {
      expect(executableLines).not.toMatch(/exit\s+2\b/);
    });

    it("starts with a bash shebang", () => {
      expect(script.startsWith("#!/bin/bash")).toBe(true);
    });

    it("ends with an explicit `exit 0`", () => {
      expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    });
  });
});

describe("codex hook script execution (requires bash + jq)", () => {
  let tempRoot: string;
  let markersDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `ccmux-codex-script-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    markersDir = join(tempRoot, "markers");
    mkdirSync(markersDir, { recursive: true });
    scriptPath = join(tempRoot, "hook.sh");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeScript(content: string): void {
    writeFileSync(scriptPath, content, { mode: 0o755 });
  }

  describe("ccmux-session-start.sh", () => {
    it("writes a marker file for a valid payload", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const input = JSON.stringify({
        session_id: "0199c7dd-ff41-79c0-8270-d030bb51cd90",
        transcript_path: "/tmp/rollout.jsonl",
        cwd: "/home/x",
        hook_event_name: "SessionStart",
        model: "o3",
        permission_mode: "default",
        source: "startup",
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");

      const markerFile = join(
        markersDir,
        "codex-0199c7dd-ff41-79c0-8270-d030bb51cd90.json",
      );
      expect(existsSync(markerFile)).toBe(true);
      const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
      expect(marker.agent_type).toBe("codex");
      expect(marker.session_id).toBe("0199c7dd-ff41-79c0-8270-d030bb51cd90");
      expect(marker.state).toBe("idle");
      expect(marker.transcript_path).toBe("/tmp/rollout.jsonl");
      expect(typeof marker.pid).toBe("number");
      expect(typeof marker.timestamp).toBe("number");
    });

    it("stores null transcript_path when the field is absent", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const input = JSON.stringify({
        session_id: "abc",
        cwd: "/home/x",
        hook_event_name: "SessionStart",
        model: "o3",
        permission_mode: "default",
        source: "startup",
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      const marker = JSON.parse(
        readFileSync(join(markersDir, "codex-abc.json"), "utf-8"),
      );
      expect(marker.transcript_path).toBeNull();
    });

    it("exits 0 with empty stdout on empty stdin", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 with empty stdout on malformed JSON stdin", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, "not json {{{");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 without writing a marker when session_id is missing", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, JSON.stringify({ cwd: "/x" }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("ccmux-stop.sh", () => {
    it("flips an existing marker's state to idle and clears pending fields", async () => {
      writeScript(renderStopScript(markersDir));
      const markerFile = join(markersDir, "codex-xyz.json");
      writeFileSync(
        markerFile,
        JSON.stringify({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "xyz",
          state: "waiting_permission",
          state_timestamp: 10,
          pending_tool: "shell",
          permission_context: "rm -rf",
          timestamp: 10,
        }),
      );
      const result = await runScript(
        scriptPath,
        JSON.stringify({ session_id: "xyz", hook_event_name: "Stop" }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
      expect(marker.state).toBe("idle");
      expect(marker.pending_tool).toBeNull();
      expect(marker.permission_context).toBeNull();
    });

    it("is a no-op when the marker file is absent", async () => {
      writeScript(renderStopScript(markersDir));
      const result = await runScript(
        scriptPath,
        JSON.stringify({ session_id: "nope" }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(join(markersDir, "codex-nope.json"))).toBe(false);
    });

    it("exits 0 on empty stdin", async () => {
      writeScript(renderStopScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 on malformed JSON", async () => {
      writeScript(renderStopScript(markersDir));
      const result = await runScript(scriptPath, "garbage");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("ccmux-permission-request.sh", () => {
    it("flips an existing marker to waiting_permission with tool details", async () => {
      writeScript(renderPermissionRequestScript(markersDir));
      const markerFile = join(markersDir, "codex-zzz.json");
      writeFileSync(
        markerFile,
        JSON.stringify({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "zzz",
          state: "idle",
          state_timestamp: 1,
          timestamp: 1,
        }),
      );
      const input = JSON.stringify({
        session_id: "zzz",
        hook_event_name: "PermissionRequest",
        tool_name: "shell",
        tool_input: { command: "echo hi" },
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("shell");
      expect(marker.permission_context).toBe("echo hi");
    });

    it("is a no-op when the marker file is absent (daemon not tracking yet)", async () => {
      writeScript(renderPermissionRequestScript(markersDir));
      const result = await runScript(
        scriptPath,
        JSON.stringify({
          session_id: "missing",
          tool_name: "shell",
          tool_input: { command: "ls" },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 with empty stdout on empty stdin (Deny-guard)", async () => {
      writeScript(renderPermissionRequestScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 with empty stdout on malformed JSON (Deny-guard)", async () => {
      writeScript(renderPermissionRequestScript(markersDir));
      const result = await runScript(scriptPath, "{not valid");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 when tool_input.command is missing", async () => {
      writeScript(renderPermissionRequestScript(markersDir));
      const markerFile = join(markersDir, "codex-aaa.json");
      writeFileSync(
        markerFile,
        JSON.stringify({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "aaa",
          state: "idle",
          state_timestamp: 1,
          timestamp: 1,
        }),
      );
      const result = await runScript(
        scriptPath,
        JSON.stringify({
          session_id: "aaa",
          tool_name: "custom",
          tool_input: {},
        }),
      );
      expect(result.exitCode).toBe(0);
      const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("custom");
      expect(marker.permission_context).toBeNull();
    });
  });
});
