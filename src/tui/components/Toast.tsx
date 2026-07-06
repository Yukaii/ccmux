import type { Component } from "solid-js";
import { theme } from "../theme";

interface ToastProps {
  message: string;
}

export const Toast: Component<ToastProps> = (props) => (
  <box width="100%" height={1} justifyContent="center">
    <text fg={theme.subtext}>{props.message}</text>
  </box>
);
