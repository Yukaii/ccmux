import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeExtension } from "./ccmux.js";
import type { PiExtensionApi, PiExtensionContext } from "./ccmux.js";

const tempRoot = join(
  tmpdir(),
  `ccmux-pi-ext-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const markersDir = join(tempRoot, "markers");

type Handler = (
  event: unknown,
  ctx: PiExtensionContext,
) => void | Promise<void>;

function makeFakePi() {
  const handlers = new Map<string, Handler>();
  const pi: PiExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  return { pi, handlers };
}

function makeCtx(
  sessionId: string | undefined,
  file?: string,
  cwd = "/repo",
): PiExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
    },
  };
}

function markerPath(sessionId: string): string {
  return join(markersDir, `pi-${sessionId}.json`);
}

function readMarker(sessionId: string) {
  return JSON.parse(readFileSync(markerPath(sessionId), "utf-8"));
}

describe("pi ccmux extension", () => {
  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(markersDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes an idle marker with full identity on session_start", async () => {
    const { pi, handlers } = makeFakePi();
    makeExtension({
      markersDir,
      version: "1.0.0",
      now: () => 1_700_000_000_000,
    })(pi);
    const ctx = makeCtx("S1", "/home/u/.pi/agent/sessions/x/abc.jsonl");

    await handlers.get("session_start")!(null, ctx);

    const marker = readMarker("S1");
    expect(marker.agent_type).toBe("pi");
    expect(marker.session_id).toBe("S1");
    expect(marker.pid).toBe(process.pid);
    expect(marker.state).toBe("idle");
    expect(marker.directory).toBe("/repo");
    expect(marker.transcript_path).toBe(
      "/home/u/.pi/agent/sessions/x/abc.jsonl",
    );
    expect(marker.state_timestamp).toBe(1_700_000_000);
  });

  it("flips working on agent_start and idle on agent_end", async () => {
    const { pi, handlers } = makeFakePi();
    makeExtension({ markersDir, version: "1.0.0" })(pi);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    await handlers.get("agent_start")!(null, ctx);
    expect(readMarker("S1").state).toBe("working");

    await handlers.get("agent_end")!(null, ctx);
    expect(readMarker("S1").state).toBe("idle");
  });

  it("captures the prompt from before_agent_start and preserves it across state flips", async () => {
    const { pi, handlers } = makeFakePi();
    makeExtension({ markersDir, version: "1.0.0" })(pi);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    await handlers.get("before_agent_start")!(
      { prompt: "  fix the bug  " },
      ctx,
    );
    await handlers.get("agent_start")!(null, ctx);

    const marker = readMarker("S1");
    expect(marker.last_prompt).toBe("fix the bug");
    expect(marker.state).toBe("working");
  });

  it("removes the marker on session_shutdown", async () => {
    const { pi, handlers } = makeFakePi();
    makeExtension({ markersDir, version: "1.0.0" })(pi);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    expect(existsSync(markerPath("S1"))).toBe(true);

    await handlers.get("session_shutdown")!(null, ctx);
    expect(existsSync(markerPath("S1"))).toBe(false);
  });

  it("no-ops when no session id is available", async () => {
    const { pi, handlers } = makeFakePi();
    makeExtension({ markersDir, version: "1.0.0" })(pi);
    const ctx = makeCtx(undefined);

    await handlers.get("session_start")!(null, ctx);
    // No marker file written for an absent session id.
    expect(existsSync(markerPath("undefined"))).toBe(false);
  });
});
