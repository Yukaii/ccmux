import { describe, it, expect } from "bun:test";
import { killActionPath, restartActionPath } from "./invoke-actions";

describe("killActionPath", () => {
  it("kills a normal session via /sessions/:id/kill", () => {
    expect(
      killActionPath({ id: "claude_pane1", originInvocationId: null }),
    ).toBe("/sessions/claude_pane1/kill");
  });

  it("cancels a subprocess invoke row via /invoke/:id/cancel (id === originInvocationId)", () => {
    expect(
      killActionPath({ id: "inv_abcd", originInvocationId: "inv_abcd" }),
    ).toBe("/invoke/inv_abcd/cancel");
  });

  it("cancels a Claude invoke row by its INVOCATION id, not the session id", () => {
    // A Claude invoke row's id is the native session id, distinct from the
    // invocation id — the cancel must target originInvocationId.
    expect(
      killActionPath({
        id: "claude_session_xyz",
        originInvocationId: "inv_claude9",
      }),
    ).toBe("/invoke/inv_claude9/cancel");
  });
});

describe("restartActionPath", () => {
  it("restarts a normal session via /sessions/:id/restart", () => {
    expect(
      restartActionPath({ id: "claude_pane1", originInvocationId: null }),
    ).toBe("/sessions/claude_pane1/restart");
  });

  it("cancels (no meaningful restart) an invoke row by its invocation id", () => {
    expect(
      restartActionPath({
        id: "claude_session_xyz",
        originInvocationId: "inv_claude9",
      }),
    ).toBe("/invoke/inv_claude9/cancel");
  });
});
