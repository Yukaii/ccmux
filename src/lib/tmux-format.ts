/**
 * Field separator for packed tmux `-F` format strings.
 *
 * We deliberately do NOT use a tab (`\t`) or any control character. When tmux
 * runs under a non-UTF-8 locale (C/POSIX — e.g. a minimal container with
 * `LANG`/`LC_ALL` unset, as in Anthropic's cloud sandbox), it sanitizes
 * non-printable bytes in format output: a literal tab becomes `_` and other
 * control bytes are escaped to octal (e.g. `0x1f` -> the four characters
 * `\037`). Verified the same way on tmux 3.4 and 3.6b; under `LANG=C.UTF-8`
 * the tab survives, which is why a tab separator works on a normal dev machine
 * but silently corrupts the positional `line.split(SEP)` parse here. The
 * fallout: `listTmuxPanes()` (and the sidebar / focus-restore parsers) collapse
 * every row to one column, `panePid` parses to `NaN`, all rows are dropped, and
 * the daemon detects no pane-tracked sessions at all.
 *
 * A printable ASCII sentinel survives every tmux version under every locale.
 * `|:|` cannot appear in the structural fields we pack (pane ids are `%N`,
 * pids/indices are numeric, tmux session names cannot contain `:`), so its
 * collision profile in practice matches the tab it replaces while remaining
 * portable.
 */
export const PANE_FIELD_SEP = "|:|";
