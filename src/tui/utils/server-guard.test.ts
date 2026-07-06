import { describe, it, expect, afterEach } from "bun:test";
import { isSameServerCached, setDaemonSocketPath } from "./server-guard";

const ORIGINAL_TMUX = process.env.TMUX;

afterEach(() => {
  if (ORIGINAL_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = ORIGINAL_TMUX;
  // Module-global cache: restore fail-open for every other test file.
  setDaemonSocketPath(null);
});

describe("server-guard", () => {
  it("fails open while the daemon socket is unknown", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath(null);
    expect(isSameServerCached()).toBe(true);
  });

  it("caches a refusal when the sockets are known and differ", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(false);
  });

  it("caches an allow when the sockets match", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/mine");
    expect(isSameServerCached()).toBe(true);
  });

  it("fails open when this process is not inside tmux", () => {
    delete process.env.TMUX;
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(true);
  });

  it("re-learning an unknown socket returns to fail-open", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(false);
    setDaemonSocketPath(null);
    expect(isSameServerCached()).toBe(true);
  });
});
