/**
 * Narrow TOML helpers for toggling the codex hooks feature flag inside
 * `~/.codex/config.toml` without pulling in a general-purpose TOML parser.
 *
 * Codex renamed the flag from `codex_hooks` to `hooks` (under `[features]`)
 * around release 0.124, and made it stable/default-on by 0.130. The read
 * side recognizes either name; the write side preserves whichever name is
 * already present, and falls back to `codex_hooks = true` for new writes
 * so older Codex versions that still gate on the original name keep
 * working. New-codex users see a harmless orphan key (documented as
 * cosmetic).
 *
 * Supported form: the standard table form
 *
 *   [features]
 *   codex_hooks = true     # or `hooks = true` on Codex 0.124+
 *
 * Unsupported alternate forms (a user hand-editing their config may still
 * produce these; detection treats them as absent):
 *   - Dotted top-level key:   `features.codex_hooks = true`
 *   - Inline table:           `features = { codex_hooks = true }`
 *   - Quoted keys:            `"features"."codex_hooks" = true`
 *
 * If a user has the flag set via one of the unsupported forms, installing
 * the standard form alongside it would create a TOML duplicate-key error
 * that Codex rejects at load. The caller is expected to surface the raw
 * error in that case so the user can reconcile manually.
 *
 * The writer is line-oriented and preserves comments, blank lines, and
 * user formatting within sections we don't touch.
 */

const FEATURES_HEADER = /^\[\s*features\s*\](?:\s*#.*)?$/;
const ARRAY_TABLE_HEADER = /^\[\[/;
const TABLE_HEADER = /^\[/;
const HOOKS_KV = /^(codex_hooks|hooks)\s*=\s*(true|false)(?:\s|#|$)/;

/**
 * True when `[features]` enables the codex hooks feature under either
 * `codex_hooks = true` (pre-0.124) or `hooks = true` (0.124+). When both
 * keys are present, any `= true` wins (logical OR), so a user with a
 * stale `codex_hooks = false` alongside `hooks = true` (or vice versa)
 * is correctly reported as enabled.
 */
export function isCodexHooksEnabled(content: string): boolean {
  let inFeatures = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (ARRAY_TABLE_HEADER.test(line)) {
      inFeatures = false;
      continue;
    }
    if (TABLE_HEADER.test(line)) {
      inFeatures = FEATURES_HEADER.test(line);
      continue;
    }
    if (inFeatures) {
      const m = line.match(HOOKS_KV);
      if (m && m[2] === "true") return true;
    }
  }
  return false;
}

/**
 * Returns content with the codex hooks feature flag ensured to be `true`.
 * Idempotent. Preserves existing comments, blank lines, and the relative
 * ordering of other sections/keys.
 *
 * Resolution order inside `[features]`:
 *   1. If any `(codex_hooks|hooks) = true` already exists, leave content
 *      untouched. Other duplicate keys (including a stale `= false`) are
 *      left alone so we don't silently rewrite user-authored values.
 *   2. Otherwise, if any `(codex_hooks|hooks) = false` exists, flip the
 *      first one to `true` in place, preserving its key name.
 *   3. Otherwise, insert `codex_hooks = true` so older Codex versions
 *      (pre-0.124) still pick up the flag.
 */
export function ensureCodexHooksEnabled(content: string): string {
  if (content === "") {
    return "[features]\ncodex_hooks = true\n";
  }

  const lines = content.split("\n");

  let featuresStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FEATURES_HEADER.test(lines[i].trim())) {
      featuresStart = i;
      break;
    }
  }

  if (featuresStart === -1) {
    const trimmed = content.replace(/\n+$/, "");
    if (trimmed === "") return "[features]\ncodex_hooks = true\n";
    return `${trimmed}\n\n[features]\ncodex_hooks = true\n`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (TABLE_HEADER.test(t) || ARRAY_TABLE_HEADER.test(t)) {
      sectionEnd = i;
      break;
    }
  }

  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    const m = lines[i].trim().match(HOOKS_KV);
    if (m && m[2] === "true") return content;
  }

  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    const m = lines[i].trim().match(HOOKS_KV);
    if (m) {
      const keyName = m[1];
      const flipRe = new RegExp(`(${keyName}\\s*=\\s*)false\\b`);
      lines[i] = lines[i].replace(flipRe, "$1true");
      return ensureTrailingNewline(lines.join("\n"));
    }
  }

  lines.splice(featuresStart + 1, 0, "codex_hooks = true");
  return ensureTrailingNewline(lines.join("\n"));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
