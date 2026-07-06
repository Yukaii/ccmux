import type { Component } from "solid-js";
import { createSignal, For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import { theme } from "../theme";

export interface ContextMenuItem {
  label: string;
  hint: string;
  color: string;
  action: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 22;

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const dims = useTerminalDimensions();
  const [hovered, setHovered] = createSignal<number | null>(null);

  const menuHeight = () => props.items.length + 2;

  const clampedX = () => {
    const max = Math.max(0, dims().width - MENU_WIDTH);
    return Math.min(Math.max(0, props.x), max);
  };
  const clampedY = () => {
    const max = Math.max(0, dims().height - menuHeight());
    return Math.min(Math.max(0, props.y), max);
  };

  return (
    <box
      position="absolute"
      left={clampedX()}
      top={clampedY()}
      width={MENU_WIDTH}
      backgroundColor={theme.surface}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
    >
      <For each={props.items}>
        {(item, i) => (
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={hovered() === i() ? theme.border : theme.surface}
            onMouseOver={() => setHovered(i())}
            onMouseOut={() => setHovered((h) => (h === i() ? null : h))}
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) item.action();
              else if (event.button === MouseButton.RIGHT) props.onClose();
            }}
          >
            <box flexGrow={1}>
              <text fg={item.color}>{item.label}</text>
            </box>
            <text fg={theme.overlay}>{item.hint}</text>
          </box>
        )}
      </For>
    </box>
  );
};
