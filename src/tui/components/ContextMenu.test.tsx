import { describe, it, expect, afterEach, mock } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { theme } from "../theme";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

function itemSpies(labels: string[]) {
  return labels.map(
    (label) =>
      ({
        label,
        hint: label[0]!.toLowerCase(),
        color: theme.text,
        action: mock(() => {}),
      }) satisfies ContextMenuItem,
  );
}

async function renderMenu(
  opts: {
    items?: ContextMenuItem[];
    x?: number;
    y?: number;
    onClose?: ReturnType<typeof mock>;
    size?: { width: number; height: number };
  } = {},
) {
  const items = opts.items ?? itemSpies(["Attach", "Kill", "Restart"]);
  const onClose = opts.onClose ?? mock(() => {});
  const size = opts.size ?? { width: 60, height: 15 };
  setup = await testRender(
    () => (
      <ContextMenu
        x={opts.x ?? 5}
        y={opts.y ?? 2}
        items={items}
        onClose={onClose}
      />
    ),
    size,
  );
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), items, onClose };
}

function locate(frame: string, label: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((l) => l.includes(label));
  if (row < 0) return null;
  return { row, col: lines[row].indexOf(label) };
}

describe("ContextMenu", () => {
  it("renders each item label", async () => {
    const { frame } = await renderMenu();
    expect(frame).toContain("Attach");
    expect(frame).toContain("Kill");
    expect(frame).toContain("Restart");
  });

  it("renders the hint next to each item", async () => {
    const { frame } = await renderMenu({
      items: [
        { label: "Pin to Top", hint: "<", color: theme.blue, action: () => {} },
        {
          label: "Pin to Bottom",
          hint: ">",
          color: theme.blue,
          action: () => {},
        },
      ],
    });
    expect(frame).toContain("Pin to Top");
    expect(frame).toContain("<");
    expect(frame).toContain("Pin to Bottom");
    expect(frame).toContain(">");
  });

  it("left-click on an item fires only that item's action", async () => {
    const { frame, items, onClose } = await renderMenu();
    const pos = locate(frame, "Kill");
    expect(pos).not.toBeNull();
    await setup.mockMouse.click(pos!.col, pos!.row, MouseButtons.LEFT);
    expect(items[1]!.action).toHaveBeenCalledTimes(1);
    expect(items[0]!.action).not.toHaveBeenCalled();
    expect(items[2]!.action).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("right-click on a menu item fires onClose and no item action", async () => {
    const { frame, items, onClose } = await renderMenu();
    const pos = locate(frame, "Attach");
    expect(pos).not.toBeNull();
    await setup.mockMouse.click(pos!.col, pos!.row, MouseButtons.RIGHT);
    expect(onClose).toHaveBeenCalledTimes(1);
    for (const item of items) {
      expect(item.action).not.toHaveBeenCalled();
    }
  });

  it("clamps position so the menu stays within the terminal bounds", async () => {
    const { frame } = await renderMenu({
      x: 9999,
      y: 9999,
      size: { width: 40, height: 10 },
    });
    expect(frame).toContain("Attach");
    expect(frame).toContain("Restart");
  });
});
