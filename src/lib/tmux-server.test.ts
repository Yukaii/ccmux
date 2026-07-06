import { describe, expect, it, afterEach } from "bun:test";
import { currentTmuxSocket, isSameTmuxServer } from "./tmux-server";

const ORIGINAL_TMUX = process.env.TMUX;

afterEach(() => {
  if (ORIGINAL_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = ORIGINAL_TMUX;
});

describe("currentTmuxSocket", () => {
  it("returns the socket path (first field of $TMUX)", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,35273,3";
    expect(currentTmuxSocket()).toBe("/private/tmp/tmux-501/default");
  });

  it("returns null when not inside tmux", () => {
    delete process.env.TMUX;
    expect(currentTmuxSocket()).toBe(null);
  });
});

describe("isSameTmuxServer", () => {
  it("returns false when both sockets are known and differ", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer("/private/tmp/tmux-501/alt")).toBe(false);
  });

  it("returns true when both sockets are known and match", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer("/private/tmp/tmux-501/default")).toBe(true);
  });

  it("fails open when the daemon socket is unknown", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer(null)).toBe(true);
  });

  it("fails open when this process is not inside tmux", () => {
    delete process.env.TMUX;
    expect(isSameTmuxServer("/private/tmp/tmux-501/default")).toBe(true);
  });
});
