import type { Component } from "solid-js";
import { For } from "solid-js";

interface HighlightedTextProps {
  text: string;
  highlightColor?: string;
  baseColor?: string;
}

interface Segment {
  text: string;
  bold: boolean;
}

function parseHighlight(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /<b>(.*?)<\/b>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false });
  }

  return segments;
}

export const HighlightedText: Component<HighlightedTextProps> = (props) => {
  const segments = () => parseHighlight(props.text);

  return (
    <For each={segments()}>
      {(segment) =>
        segment.bold ? (
          <text fg={props.highlightColor}>
            <b>{segment.text}</b>
          </text>
        ) : (
          <text fg={props.baseColor}>{segment.text}</text>
        )
      }
    </For>
  );
};
