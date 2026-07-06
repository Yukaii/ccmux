import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AttentionType, SessionStatus } from "../../types";
import { BackgroundStatusBadge } from "./BackgroundStatusBadge";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderBadge(props: {
  status: SessionStatus;
  attentionType?: AttentionType;
  mode?: "icon" | "short" | "full";
  iconStyle?: "dot" | "none";
}) {
  setup = await testRender(
    () => (
      <BackgroundStatusBadge
        status={props.status}
        attentionType={props.attentionType ?? null}
        mode={props.mode ?? "full"}
        iconStyle={props.iconStyle ?? "dot"}
      />
    ),
    { width: 20, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("BackgroundStatusBadge", () => {
  it("renders working with the distinct diamond glyph + label", async () => {
    const frame = await renderBadge({ status: "working" });
    expect(frame).toContain("◆");
    expect(frame).toContain("working");
  });

  it("renders waiting with the waiting diamond glyph + label", async () => {
    const frame = await renderBadge({
      status: "waiting",
      attentionType: "permission",
    });
    expect(frame).toContain("◈");
    expect(frame).toContain("waiting");
  });

  it("renders idle with the hollow diamond glyph + label", async () => {
    const frame = await renderBadge({ status: "idle" });
    expect(frame).toContain("◇");
    expect(frame).toContain("idle");
  });

  it("uses a distinct glyph from the normal circle/square family", async () => {
    const frame = await renderBadge({ status: "working" });
    // Diamond family, NOT the normal working ● / waiting ■.
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("■");
  });

  it("icon mode renders just the single-char glyph", async () => {
    const frame = await renderBadge({ status: "working", mode: "icon" });
    expect(frame).toContain("◆");
    expect(frame).not.toContain("working");
  });
});
