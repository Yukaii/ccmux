import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { useStatusIcon } from "./useStatusIcon";
import type { SessionStatus, AttentionType, AttentionState } from "../../types";
import type { IconStyle } from "../../lib/icons";
import {
  getStatusIcon,
  getAttentionIcon,
  DOT_SPINNER_FRAMES,
  NERDFONT_SPINNER_FRAMES,
} from "../../lib/icons";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

/** Render a component that uses useStatusIcon and displays the icon as text */
async function renderIcon(props: {
  status: SessionStatus;
  attentionType?: AttentionType;
  iconStyle?: IconStyle;
  attentionState?: AttentionState;
}) {
  const [status] = createSignal<SessionStatus>(props.status);
  const [attention] = createSignal<AttentionType>(props.attentionType ?? null);
  const [style] = createSignal<IconStyle | undefined>(props.iconStyle);
  const [attnState] = createSignal<AttentionState | undefined>(
    props.attentionState ?? undefined,
  );

  let iconValue = "";
  setup = await testRender(
    () => {
      const icon = useStatusIcon(status, attention, style, attnState);
      iconValue = icon();
      return <text>{icon()}</text>;
    },
    { width: 10, height: 1 },
  );
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), iconValue };
}

describe("useStatusIcon", () => {
  it("returns static icon for idle status", async () => {
    const { iconValue } = await renderIcon({ status: "idle" });
    expect(iconValue).toBe(getStatusIcon("idle", null, undefined));
  });

  it("returns static icon for idle with dot style", async () => {
    const { iconValue } = await renderIcon({
      status: "idle",
      iconStyle: "dot",
    });
    expect(iconValue).toBe("●");
  });

  it("returns spinner frame for working with dot style", async () => {
    const { iconValue } = await renderIcon({
      status: "working",
      iconStyle: "dot",
    });
    expect(DOT_SPINNER_FRAMES.some((f) => f === iconValue)).toBe(true);
  });

  it("returns nerdfont spinner for working with nerdfont style", async () => {
    const { iconValue } = await renderIcon({
      status: "working",
      iconStyle: "nerdfont",
    });
    expect(NERDFONT_SPINNER_FRAMES.some((f) => f === iconValue)).toBe(true);
  });

  it("returns attention icon when idle with unread state", async () => {
    const { iconValue } = await renderIcon({
      status: "idle",
      iconStyle: "dot",
      attentionState: "unread",
    });
    expect(iconValue).toBe(getAttentionIcon("unread", "dot"));
  });

  it("returns attention icon when idle with read state", async () => {
    const { iconValue } = await renderIcon({
      status: "idle",
      iconStyle: "dot",
      attentionState: "read",
    });
    expect(iconValue).toBe(getAttentionIcon("read", "dot"));
  });

  it("ignores attention state for non-idle status", async () => {
    const { iconValue } = await renderIcon({
      status: "working",
      iconStyle: "dot",
      attentionState: "unread",
    });
    // Should show spinner, not attention icon
    expect(DOT_SPINNER_FRAMES.some((f) => f === iconValue)).toBe(true);
  });

  it("returns waiting icon with attention type", async () => {
    const { iconValue } = await renderIcon({
      status: "waiting",
      attentionType: "permission",
      iconStyle: "dot",
    });
    expect(iconValue).toBe(getStatusIcon("waiting", "permission", "dot"));
    expect(iconValue).toBe("■");
  });

  it("returns static icon for working without animated style", async () => {
    // Without "dot" or "nerdfont", working status uses static icon
    const { iconValue } = await renderIcon({ status: "working" });
    expect(iconValue).toBe(getStatusIcon("working", null, undefined));
  });

  it("returns empty string for none style", async () => {
    const { iconValue } = await renderIcon({
      status: "idle",
      iconStyle: "none",
    });
    expect(iconValue).toBe("");
  });
});
