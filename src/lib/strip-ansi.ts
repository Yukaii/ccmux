const ANSI_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
