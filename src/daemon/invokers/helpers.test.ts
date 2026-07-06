import { describe, expect, it } from "bun:test";
import { abortToFailure } from "./helpers";

describe("abortToFailure", () => {
  it("maps signal.reason === 'timeout' to a timeout failure", () => {
    const ac = new AbortController();
    ac.abort("timeout");
    const failure = abortToFailure("inv_1", ac.signal, "%9");
    expect(failure).toEqual({
      success: false,
      invocationId: "inv_1",
      kind: "timeout",
      message: "invocation timed out",
      paneId: "%9",
    });
  });

  it("maps signal.reason === 'cancelled' to a cancelled failure", () => {
    const ac = new AbortController();
    ac.abort("cancelled");
    const failure = abortToFailure("inv_2", ac.signal, "%9");
    expect(failure).toEqual({
      success: false,
      invocationId: "inv_2",
      kind: "cancelled",
      message: "cancelled",
      paneId: "%9",
    });
  });

  it("treats undefined signal.reason as cancelled (defensive default)", () => {
    const ac = new AbortController();
    ac.abort();
    expect(ac.signal.reason).not.toBe("timeout");
    const failure = abortToFailure("inv_3", ac.signal);
    expect(failure.kind).toBe("cancelled");
    expect(failure.message).toBe("cancelled");
    expect(failure.paneId).toBeUndefined();
  });

  it("is idempotent on a second abort with a different reason (timeout then cancel stays timeout)", () => {
    // AbortController.abort() is a no-op after the first call, so
    // whichever side aborts first wins the reason — the manager relies on
    // this to keep "timeout fired first, user then cancelled" classified
    // as timeout instead of being relabeled cancelled.
    const ac = new AbortController();
    ac.abort("timeout");
    ac.abort("cancelled");
    expect(ac.signal.reason).toBe("timeout");
    const failure = abortToFailure("inv_4", ac.signal, "%9");
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toBe("invocation timed out");
  });

  it("is idempotent on a second abort with a different reason (cancel then timeout stays cancelled)", () => {
    const ac = new AbortController();
    ac.abort("cancelled");
    ac.abort("timeout");
    expect(ac.signal.reason).toBe("cancelled");
    const failure = abortToFailure("inv_5", ac.signal, "%9");
    expect(failure.kind).toBe("cancelled");
  });
});
