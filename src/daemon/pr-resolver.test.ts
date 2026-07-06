import { describe, it, expect } from "bun:test";
import { PRResolver, foldChecks, type PRLookupFn } from "./pr-resolver";
import type { BranchPR } from "../types/session";

const PR_25: BranchPR = {
  id: "25",
  href: "https://github.com/x/y/pull/25",
};

/** Let scheduled refresh promises settle. */
const settle = () => Bun.sleep(0);

function countingLookup(result: BranchPR[] | null): {
  fn: PRLookupFn;
  calls: Array<{ cwd: string; branch: string }>;
} {
  const calls: Array<{ cwd: string; branch: string }> = [];
  return {
    calls,
    fn: async (cwd, branch) => {
      calls.push({ cwd, branch });
      return result;
    },
  };
}

describe("PRResolver", () => {
  it("returns null on a cold read and the value once the refresh lands", async () => {
    const { fn } = countingLookup([PR_25]);
    const resolver = new PRResolver({ lookup: fn });

    expect(resolver.get("/repo", "feat/x")).toBeNull();
    await settle();
    expect(resolver.get("/repo", "feat/x")).toEqual([PR_25]);
  });

  it("never looks up default branches, detached HEAD, or missing keys", async () => {
    const { fn, calls } = countingLookup([PR_25]);
    const resolver = new PRResolver({ lookup: fn });

    expect(resolver.get("/repo", "main")).toBeNull();
    expect(resolver.get("/repo", "master")).toBeNull();
    expect(resolver.get("/repo", "HEAD")).toBeNull();
    expect(resolver.get(null, "feat/x")).toBeNull();
    expect(resolver.get("/repo", null)).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("dedupes concurrent refreshes for the same key", async () => {
    const { fn, calls } = countingLookup([PR_25]);
    const resolver = new PRResolver({ lookup: fn });

    resolver.get("/repo", "feat/x");
    resolver.get("/repo", "feat/x");
    resolver.get("/repo", "feat/x");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("serves from cache within the TTL without re-fetching", async () => {
    const { fn, calls } = countingLookup([PR_25]);
    const resolver = new PRResolver({ lookup: fn });

    resolver.get("/repo", "feat/x");
    await settle();
    resolver.get("/repo", "feat/x");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("refreshes stale entries while still returning the stale value", async () => {
    const { fn, calls } = countingLookup([PR_25]);
    const resolver = new PRResolver({ lookup: fn, successTtlMs: 0 });

    resolver.get("/repo", "feat/x");
    await settle();
    // Entry exists but is already expired (ttl 0): stale value returned,
    // a new refresh scheduled.
    expect(resolver.get("/repo", "feat/x")).toEqual([PR_25]);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("fires onChange when a refresh lands a different value", async () => {
    const changes: Array<{ cwd: string; branch: string }> = [];
    let result: BranchPR[] = [];
    const resolver = new PRResolver({
      lookup: async () => result,
      successTtlMs: 0,
      onChange: (cwd, branch) => changes.push({ cwd, branch }),
    });

    // First refresh lands [] — same as the implicit empty start, no event.
    resolver.get("/repo", "feat/x");
    await settle();
    expect(changes).toHaveLength(0);

    // Second refresh lands a PR — change event.
    result = [PR_25];
    resolver.get("/repo", "feat/x");
    await settle();
    expect(changes).toEqual([{ cwd: "/repo", branch: "feat/x" }]);

    // Third refresh lands the same PR — no further event.
    resolver.get("/repo", "feat/x");
    await settle();
    expect(changes).toHaveLength(1);
  });

  it("re-broadcasts on a CI/review state flip with unchanged id and href", async () => {
    // The color depends on reviewDecision/ciStatus, which flip without the
    // PR's id or href changing (CI lands, a review posts). samePRs must
    // compare those fields or the row would keep a stale color.
    let changes = 0;
    let result: BranchPR[] = [
      { id: "25", href: "h", reviewDecision: null, ciStatus: "pending" },
    ];
    const resolver = new PRResolver({
      lookup: async () => result,
      successTtlMs: 0,
      onChange: () => {
        changes++;
      },
    });

    resolver.get("/repo", "feat/x");
    await settle();
    changes = 0; // ignore the initial empty -> [pending] transition

    // Same id+href; only the folded CI signal changes.
    result = [
      { id: "25", href: "h", reviewDecision: null, ciStatus: "failing" },
    ];
    resolver.get("/repo", "feat/x");
    await settle();
    expect(changes).toBe(1);

    // An identical refresh does not re-broadcast.
    resolver.get("/repo", "feat/x");
    await settle();
    expect(changes).toBe(1);
  });

  it("caps concurrent refreshes across distinct keys", async () => {
    const land: Array<(v: BranchPR[] | null) => void> = [];
    const calls: string[] = [];
    const resolver = new PRResolver({
      lookup: (_cwd, branch) => {
        calls.push(branch);
        return new Promise((resolve) => land.push(resolve));
      },
    });

    // Six cold keys at once (a TUI connect over many worktrees): only the
    // cap's worth of refreshes spawn; the rest skip the round.
    for (let i = 0; i < 6; i++) resolver.get(`/repo-${i}`, "feat/x");
    expect(calls).toHaveLength(4);

    // Once those land, the skipped keys reschedule on their next read.
    for (const resolve of land) resolve([]);
    await settle();
    for (let i = 0; i < 6; i++) resolver.get(`/repo-${i}`, "feat/x");
    expect(calls).toHaveLength(6);
  });

  it("expires successful entries on the short TTL and failures on the long one", async () => {
    // Success TTL 0, failure TTL effectively infinite: a successful key
    // refetches on every read, a failed key never does.
    const calls: string[] = [];
    const resolver = new PRResolver({
      lookup: async (cwd) => {
        calls.push(cwd);
        return cwd === "/no-remote" ? null : [PR_25];
      },
      successTtlMs: 0,
      failureTtlMs: 60 * 60_000,
    });

    resolver.get("/repo", "feat/x");
    resolver.get("/no-remote", "feat/x");
    await settle();
    resolver.get("/repo", "feat/x");
    resolver.get("/no-remote", "feat/x");
    await settle();
    expect(calls.filter((c) => c === "/repo")).toHaveLength(2);
    expect(calls.filter((c) => c === "/no-remote")).toHaveLength(1);
  });

  it("holds a thrown-lookup negative for the failure TTL, not the success TTL", async () => {
    const calls: string[] = [];
    const resolver = new PRResolver({
      lookup: async (cwd) => {
        calls.push(cwd);
        throw new Error("spawn ENOENT (cwd)");
      },
      ghMissing: () => false,
      successTtlMs: 0,
      failureTtlMs: 60 * 60_000,
    });

    resolver.get("/gone-worktree", "feat/x");
    await settle();
    resolver.get("/gone-worktree", "feat/x");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("caches failed lookups as negative without firing onChange", async () => {
    const changes: string[] = [];
    const { fn, calls } = countingLookup(null);
    const resolver = new PRResolver({
      lookup: fn,
      onChange: (cwd) => changes.push(cwd),
    });

    resolver.get("/repo", "feat/x");
    await settle();
    expect(resolver.get("/repo", "feat/x")).toBeNull();
    await settle();
    expect(calls).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  it("disables itself for good when a throw coincides with gh missing", async () => {
    let callCount = 0;
    const resolver = new PRResolver({
      lookup: async () => {
        callCount++;
        throw new Error("spawn gh ENOENT");
      },
      ghMissing: () => true,
    });

    resolver.get("/repo", "feat/x");
    await settle();
    expect(resolver.get("/repo", "feat/x")).toBeNull();
    expect(resolver.get("/other", "feat/y")).toBeNull();
    await settle();
    expect(callCount).toBe(1);
  });

  it("negative-caches only the key when a throw happens with gh present (deleted cwd)", async () => {
    const calls: string[] = [];
    const resolver = new PRResolver({
      lookup: async (cwd) => {
        calls.push(cwd);
        if (cwd === "/gone-worktree") throw new Error("spawn ENOENT (cwd)");
        return [PR_25];
      },
      ghMissing: () => false,
    });

    resolver.get("/gone-worktree", "feat/x");
    await settle();
    // The dead key is negative-cached, not retried...
    expect(resolver.get("/gone-worktree", "feat/x")).toBeNull();
    await settle();
    expect(calls.filter((c) => c === "/gone-worktree")).toHaveLength(1);
    // ...and other keys keep resolving.
    resolver.get("/repo", "feat/y");
    await settle();
    expect(resolver.get("/repo", "feat/y")).toEqual([PR_25]);
  });
});

describe("foldChecks", () => {
  const run = (status: string, conclusion: string | null) => ({
    __typename: "CheckRun",
    status,
    conclusion,
  });
  const ctx = (state: string) => ({ __typename: "StatusContext", state });

  it("treats an empty or absent rollup as 'none', never passing", () => {
    expect(foldChecks([])).toBe("none");
    expect(foldChecks(null)).toBe("none");
    expect(foldChecks(undefined)).toBe("none");
  });

  it("is passing only when every check passed", () => {
    expect(foldChecks([run("COMPLETED", "SUCCESS")])).toBe("passing");
    // NEUTRAL and SKIPPED are non-failures, like `gh pr checks`.
    expect(
      foldChecks([
        run("COMPLETED", "SUCCESS"),
        run("COMPLETED", "NEUTRAL"),
        run("COMPLETED", "SKIPPED"),
      ]),
    ).toBe("passing");
  });

  it("is failing if any run failed (failure dominates)", () => {
    for (const c of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
      expect(foldChecks([run("COMPLETED", c)])).toBe("failing");
    }
    // Failure wins over a co-occurring pass and pending.
    expect(
      foldChecks([
        run("COMPLETED", "SUCCESS"),
        run("IN_PROGRESS", null),
        run("COMPLETED", "FAILURE"),
      ]),
    ).toBe("failing");
  });

  it("is pending for in-flight runs and STALE/STARTUP_FAILURE, when nothing failed", () => {
    expect(foldChecks([run("IN_PROGRESS", null)])).toBe("pending");
    expect(foldChecks([run("QUEUED", null)])).toBe("pending");
    expect(foldChecks([run("COMPLETED", "STALE")])).toBe("pending");
    expect(foldChecks([run("COMPLETED", "STARTUP_FAILURE")])).toBe("pending");
    // A passing run plus a pending one is still pending.
    expect(
      foldChecks([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS", null)]),
    ).toBe("pending");
  });

  it("folds legacy StatusContext entries by their state field", () => {
    expect(foldChecks([ctx("SUCCESS")])).toBe("passing");
    expect(foldChecks([ctx("FAILURE")])).toBe("failing");
    expect(foldChecks([ctx("ERROR")])).toBe("failing");
    expect(foldChecks([ctx("PENDING")])).toBe("pending");
    expect(foldChecks([ctx("EXPECTED")])).toBe("pending");
  });
});
