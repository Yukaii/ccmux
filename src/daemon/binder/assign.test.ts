import { describe, it, expect } from "bun:test";
import { ASSIGN_MAX_GROUP, assignGroup, forwardGapCost } from "./assign";

// ---------------------------------------------------------------------------
// forwardGapCost (D1 direction, D2 tolerance, D4 no-signal, D7 all-entries)
// ---------------------------------------------------------------------------

describe("forwardGapCost", () => {
  it("AT-D4: a candidate without a start time is ineligible", () => {
    expect(forwardGapCost([1_000], null)).toBeNull();
    expect(forwardGapCost([1_000], undefined)).toBeNull();
  });

  it("AT-D1: timestamps before the candidate start (beyond skew) are ineligible", () => {
    // Session's only prompt predates the process launch: that process
    // cannot have produced it.
    expect(forwardGapCost([100_000], 150_000)).toBeNull();
  });

  it("absorbs sub-skew clock disagreement as cost zero", () => {
    expect(forwardGapCost([100_000], 101_500)).toBe(0);
  });

  it("AT-D2: a gap beyond the tolerance cap is ineligible", () => {
    // 40 minutes after launch — never a match, even as the only candidate.
    expect(forwardGapCost([2_400_000], 0)).toBeNull();
  });

  it("uses the closest forward timestamp as the cost", () => {
    expect(forwardGapCost([50_000, 5_000, 300_000], 0)).toBe(5_000);
  });

  it("AT-D7: a resumed session correlates via today's entry, not its first prompt", () => {
    const threeDays = 3 * 24 * 3600 * 1000;
    const procStart = threeDays; // resumed today
    const entries = [1_000, 2_000, procStart + 5_000]; // old run + today's prompt
    expect(forwardGapCost(entries, procStart)).toBe(5_000);
  });

  it("returns null when no timestamp exists at all (D4 no-signal)", () => {
    expect(forwardGapCost([], 1_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assignGroup (D3 ambiguity, D5 no-leftover, D6 group-wise optimality)
// ---------------------------------------------------------------------------

/** Build a cost callback from a matrix (rows = sessions, cols = candidates). */
function costOf(matrix: (number | null)[][]) {
  return (s: number, c: number) => matrix[s][c];
}

describe("assignGroup", () => {
  it("binds a clear 1×1 pairing", () => {
    const r = assignGroup(1, 1, costOf([[5_000]]));
    expect(r.bound.get(0)).toBe(0);
    expect(r.unbound.size).toBe(0);
  });

  it("AT-D2: refuses a sole ineligible candidate instead of binding it", () => {
    const r = assignGroup(1, 1, costOf([[null]]));
    expect(r.bound.size).toBe(0);
    expect(r.unbound.get(0)).toBe("no-signal");
  });

  it("1×2: binds the clear winner, refuses a jitter-close pair", () => {
    const clear = assignGroup(1, 2, costOf([[5_000, 400_000]]));
    expect(clear.bound.get(0)).toBe(0);

    const close = assignGroup(1, 2, costOf([[5_000, 6_500]]));
    expect(close.bound.size).toBe(0);
    expect(close.unbound.get(0)).toBe("ambiguous");
  });

  it("2×1: the clearly-better session wins; the loser is outcompeted, and a near-tie refuses both", () => {
    const clear = assignGroup(2, 1, costOf([[5_000], [400_000]]));
    expect(clear.bound.get(0)).toBe(0);
    expect(clear.unbound.get(1)).toBe("outcompeted");

    // Near-tie: BOTH read "ambiguous" (symmetric labels — which of the two
    // earns a visible unbound row must not depend on enumeration order).
    const close = assignGroup(2, 1, costOf([[5_000], [6_000]]));
    expect(close.bound.size).toBe(0);
    expect(close.unbound.get(0)).toBe("ambiguous");
    expect(close.unbound.get(1)).toBe("ambiguous");
  });

  it("AT-D3: the demo scenario — an all-eligible group refuses every binding", () => {
    // Three same-cwd sessions, three processes launched within 1s, prompts
    // typed minutes later: every pairing is eligible, and the total cost of
    // every permutation is identical (Σgaps is permutation-invariant), so
    // no choice is signal. All three must go unbound, never permuted.
    const procs = [0, 500, 1_000];
    const prompts = [180_000, 200_000, 220_000];
    const r = assignGroup(3, 3, (s, c) =>
      forwardGapCost([prompts[s]], procs[c]),
    );
    expect(r.bound.size).toBe(0);
    expect([...r.unbound.values()]).toEqual([
      "ambiguous",
      "ambiguous",
      "ambiguous",
    ]);
  });

  it("binds fully when launch/prompt interleaving makes the group unambiguous", () => {
    // The realistic quick-prompt flow: each pane launched, prompted within
    // seconds, next pane launched. Direction eligibility forces the unique
    // maximal assignment.
    const procs = [0, 60_000, 120_000];
    const prompts = [5_000, 65_000, 125_000];
    const r = assignGroup(3, 3, (s, c) =>
      forwardGapCost([prompts[s]], procs[c]),
    );
    expect(r.bound.get(0)).toBe(0);
    expect(r.bound.get(1)).toBe(1);
    expect(r.bound.get(2)).toBe(2);
    expect(r.unbound.size).toBe(0);
  });

  it("AT-D6: solves group-wise where greedy-closest-first cascades wrong", () => {
    // s1's closest candidate is c2, but c2 is s2's ONLY eligible match.
    // Greedy (s1 first) takes c2 and strands s2; the maximal assignment
    // binds s1→c1, s2→c2 regardless of iteration order.
    const matrix: (number | null)[][] = [
      [50_000, 5_000],
      [null, 40_000],
    ];
    const r = assignGroup(2, 2, costOf(matrix));
    expect(r.bound.get(0)).toBe(0);
    expect(r.bound.get(1)).toBe(1);

    // Same observation, session order flipped: same outcome.
    const flipped = assignGroup(2, 2, costOf([matrix[1], matrix[0]]));
    expect(flipped.bound.get(0)).toBe(1);
    expect(flipped.bound.get(1)).toBe(0);
  });

  it("AT-D5: an ambiguous refusal does not hand the leftover to a no-signal session", () => {
    // s0 is ambiguous between the two candidates; s1 has no usable signal.
    // Neither binds — s1 must not inherit a pane merely for being last.
    const r = assignGroup(
      2,
      2,
      costOf([
        [5_000, 6_000],
        [null, null],
      ]),
    );
    expect(r.bound.size).toBe(0);
    expect(r.unbound.get(0)).toBe("ambiguous");
    expect(r.unbound.get(1)).toBe("no-signal");
  });

  it("refuses the whole group beyond the size cap", () => {
    const n = ASSIGN_MAX_GROUP + 1;
    const r = assignGroup(n, 1, () => 1_000);
    expect(r.overflow).toBe(true);
    expect(r.bound.size).toBe(0);
    expect([...r.unbound.values()].every((v) => v === "group-too-large")).toBe(
      true,
    );
  });

  it("caps on ELIGIBLE sessions, not the raw pool size", () => {
    // 50 raw sessions (every history session of a long-lived cwd) of which
    // only one survives the eligibility gates: no overflow, normal bind.
    const r = assignGroup(50, 1, (s) => (s === 7 ? 5_000 : null));
    expect(r.overflow).toBe(false);
    expect(r.bound.get(7)).toBe(0);
    expect(r.bound.size).toBe(1);
  });

  it("caps on ELIGIBLE candidates, not the raw candidate count", () => {
    // 50 raw candidates (many live same-cwd panes) of which only one is
    // time-eligible for the session: no overflow, normal bind.
    const r = assignGroup(1, 50, (_s, c) => (c === 7 ? 5_000 : null));
    expect(r.overflow).toBe(false);
    expect(r.bound.get(0)).toBe(7);
  });

  it("output is always injective (no two sessions share a candidate)", () => {
    // Deterministic pseudo-random sweep over small matrices.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round++) {
      const S = 1 + Math.floor(rand() * 5);
      const C = 1 + Math.floor(rand() * 5);
      const matrix: (number | null)[][] = Array.from({ length: S }, () =>
        Array.from({ length: C }, () =>
          rand() < 0.35 ? null : Math.floor(rand() * 600_000),
        ),
      );
      const r = assignGroup(S, C, costOf(matrix));
      const candidates = [...r.bound.values()];
      expect(new Set(candidates).size).toBe(candidates.length);
      // Every session is accounted for exactly once.
      expect(r.bound.size + r.unbound.size).toBe(S);
      // Bound pairs are always eligible pairs.
      for (const [s, c] of r.bound) {
        expect(matrix[s][c]).not.toBeNull();
      }
    }
  });
});
