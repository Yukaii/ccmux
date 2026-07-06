import { describe, it, expect } from "bun:test";
import { dispatchSSEEvent, type SSECallbacks } from "./sse";
import type { InvocationSnapshotEntry, SSEEvent } from "../../types";

// Locks the client half of the invocation-snapshot wiring: `onInit` is the
// only consumer of the optional `invocations` arg, so a dropped third arg or a
// missing `?? []` would silently disable reconnect reconciliation with every
// other test still green. Driven through the pure dispatcher (no socket) so it
// is immune to App.test's process-wide SSEClient mock.

function makeCallbacks(over: Partial<SSECallbacks> = {}): SSECallbacks {
  return {
    onInit: () => {},
    onSessionCreated: () => {},
    onSessionUpdated: () => {},
    onSessionRemoved: () => {},
    onConnectionStateChange: () => {},
    onError: () => {},
    ...over,
  };
}

describe("dispatchSSEEvent init handling", () => {
  it("threads init.invocations through to onInit", () => {
    let received: InvocationSnapshotEntry[] | undefined;
    dispatchSSEEvent(
      {
        type: "init",
        timestamp: "2024-01-15T12:00:00Z",
        sessions: [],
        activePaneId: null,
        invocations: [{ invocationId: "inv_a", status: "running" }],
      },
      makeCallbacks({ onInit: (_s, _p, inv) => (received = inv) }),
    );
    expect(received).toEqual([{ invocationId: "inv_a", status: "running" }]);
  });

  it("passes [] to onInit when an init frame omits invocations (older daemon)", () => {
    let called = false;
    let received: InvocationSnapshotEntry[] | undefined;
    // An older daemon's init frame has no invocations field; the wire shape
    // predates the snapshot, so cast past the now-required property.
    const legacyInit = {
      type: "init",
      timestamp: "2024-01-15T12:00:00Z",
      sessions: [],
      activePaneId: null,
    } as unknown as SSEEvent;
    dispatchSSEEvent(
      legacyInit,
      makeCallbacks({
        onInit: (_s, _p, inv) => {
          called = true;
          received = inv;
        },
      }),
    );
    expect(called).toBe(true);
    expect(received).toEqual([]);
  });
});
