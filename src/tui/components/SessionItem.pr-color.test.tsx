import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RGBA, type CapturedFrame } from "@opentui/core";
import { SessionItem } from "./SessionItem";
import { TickContext } from "../store";
import { theme } from "../theme";
import { mockEnrichedSession } from "./test-helpers";
import type { BranchPR, EnrichedSession } from "../../types";

/**
 * Rendered-color verification for the PR cell. captureCharFrame() is
 * text-only, so to prove the state -> color mapping actually reaches the
 * screen we capture spans (which carry each run's fg) and assert the PR
 * span's foreground equals the expected theme hue. The row is not dimmed
 * (no `dimmed` prop), so dimColor returns the real color, not theme.border.
 */
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderPR(overrides: Partial<EnrichedSession>): Promise<void> {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionItem
          session={mockEnrichedSession(overrides)}
          selected={false}
          index={0}
          previewWidth={30}
        />
      </TickContext.Provider>
    ),
    { width: 120, height: 3 },
  );
  await setup.renderOnce();
}

/** Foreground of the span rendering the PR number, as [r,g,b,a] ints. */
function prCellFg(frame: CapturedFrame): [number, number, number, number] {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes("#70")) return span.fg.toInts();
    }
  }
  throw new Error("PR span (#70) not found in frame");
}

const hex = (h: string) => RGBA.fromHex(h).toInts();
const pr = (extra: Partial<BranchPR>): BranchPR => ({
  id: "70",
  href: "https://github.com/x/y/pull/70",
  ...extra,
});

describe("SessionItem PR cell color", () => {
  it("renders red when CI is failing", async () => {
    await renderPR({
      branchPRs: [pr({ reviewDecision: null, ciStatus: "failing" })],
    });
    expect(prCellFg(setup.captureSpans())).toEqual(hex(theme.red));
  });

  it("renders red when changes were requested", async () => {
    await renderPR({
      branchPRs: [
        pr({ reviewDecision: "CHANGES_REQUESTED", ciStatus: "passing" }),
      ],
    });
    expect(prCellFg(setup.captureSpans())).toEqual(hex(theme.red));
  });

  it("renders green only on an explicit approval", async () => {
    await renderPR({
      branchPRs: [pr({ reviewDecision: "APPROVED", ciStatus: "passing" })],
    });
    expect(prCellFg(setup.captureSpans())).toEqual(hex(theme.green));
  });

  it("renders yellow for an open/unapproved PR (strict green never fires)", async () => {
    await renderPR({
      branchPRs: [pr({ reviewDecision: null, ciStatus: "passing" })],
    });
    expect(prCellFg(setup.captureSpans())).toEqual(hex(theme.yellow));
  });

  it("keeps mauve for state-less background-agent PRs", async () => {
    await renderPR({
      backgroundChildren: [
        { kind: "pr", id: "70", href: "https://github.com/x/y/pull/70" },
      ],
    });
    expect(prCellFg(setup.captureSpans())).toEqual(hex(theme.mauve));
  });
});
