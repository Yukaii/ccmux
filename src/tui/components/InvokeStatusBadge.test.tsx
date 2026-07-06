import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { InvokeStatusBadge, type InvokeStatus } from "./InvokeStatusBadge";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderBadge(props: {
  status: InvokeStatus;
  mode?: "icon" | "short" | "full";
  iconStyle?: "dot" | "none";
  dimmed?: boolean;
}) {
  setup = await testRender(
    () => (
      <InvokeStatusBadge
        status={props.status}
        mode={props.mode ?? "full"}
        iconStyle={props.iconStyle ?? "dot"}
        dimmed={props.dimmed}
      />
    ),
    { width: 20, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("InvokeStatusBadge", () => {
  it("renders succeeded with a check glyph and 'done' label", async () => {
    const frame = await renderBadge({ status: "succeeded", mode: "full" });
    expect(frame).toContain("✓");
    expect(frame).toContain("done");
  });

  it("renders failed with an x glyph and 'failed' label", async () => {
    const frame = await renderBadge({ status: "failed", mode: "full" });
    expect(frame).toContain("✗");
    expect(frame).toContain("failed");
  });

  it("renders cancelled with a circled-slash glyph and 'cancel' label", async () => {
    const frame = await renderBadge({ status: "cancelled", mode: "full" });
    expect(frame).toContain("⊘");
    expect(frame).toContain("cancel");
  });

  it("renders running with the working spinner glyph and label", async () => {
    // dot style "working" animates over DOT_SPINNER_FRAMES; the first frame is ◐.
    // The running label is "working" to match a normal active session.
    const frame = await renderBadge({ status: "running", mode: "full" });
    expect(frame).toContain("◐");
    expect(frame).toContain("working");
  });

  it("renders glyph only in icon mode", async () => {
    const frame = await renderBadge({ status: "succeeded", mode: "icon" });
    expect(frame).toContain("✓");
    expect(frame).not.toContain("done");
  });

  it("truncates the label to 4 chars in short mode", async () => {
    const frame = await renderBadge({ status: "cancelled", mode: "short" });
    expect(frame).toContain("⊘ canc");
    expect(frame).not.toContain("cancel");
  });

  it("omits the terminal glyph under the none icon style", async () => {
    const frame = await renderBadge({
      status: "failed",
      mode: "full",
      iconStyle: "none",
    });
    expect(frame).toContain("failed");
    expect(frame).not.toContain("✗");
  });
});
