/**
 * Grace window between SIGTERM (or `C-c` for the tmux path) and SIGKILL
 * during cancel teardown. Matches the original manager-local constant
 * both invokers carried in 2.2/2.3 so the user-visible cancel latency
 * after `ccmux invoke ... C-c` stays the same.
 */
export const CANCEL_GRACE_MS = 1_500;

/**
 * Tail-line scope for errorRule matching. Mirrors `matchTerminalRule`'s
 * scope in `terminal-detector.ts` so errorRules scan the same chrome
 * region (the bottom of the pane / the last lines of stdout) the status
 * detector does.
 */
export const ERROR_CHROME_TAIL_LINES = 30;

/**
 * Byte ceiling for a prompt that rides in argv (a `{prompt}` placeholder,
 * e.g. gemini's `-p {prompt}`). A single argv element is OS-bounded (Linux
 * `MAX_ARG_STRLEN` = 128 KiB on 4 KiB pages); cap below it so a within-spec
 * prompt fails clean instead of `execve` E2BIG on Linux only. Fixed
 * conservative constant by design, not runtime page-size detection.
 */
export const MAX_ARGV_PROMPT_BYTES = 120 * 1024;
