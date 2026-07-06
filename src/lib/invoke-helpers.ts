import type { ErrorKind, ErrorRule } from "./agents";

/**
 * Canonical invocation-id shape: `inv_` followed by 4-32 alphanumerics.
 * Shared by the CLI (`ccmux invoke --id/cancel/result`), the daemon's HTTP
 * validation, and the result-store path helper so the single rule (which
 * doubles as the result-file path-traversal guard) can never drift between
 * call sites.
 */
export const INVOCATION_ID_PATTERN = /^inv_[A-Za-z0-9]{4,32}$/;

/** Pure predicate: does `id` match {@link INVOCATION_ID_PATTERN}? */
export function isValidInvocationId(id: string): boolean {
  return INVOCATION_ID_PATTERN.test(id);
}

export function mergePromptWithStdin(
  arg: string | undefined,
  stdin: string,
): string {
  if (arg && stdin) {
    return `${arg}\n${stdin}`;
  }
  if (stdin) {
    return stdin;
  }
  if (arg) {
    return arg;
  }

  throw new Error("No prompt provided");
}

export function matchErrorRules(
  text: string,
  rules: ErrorRule[],
): { kind: ErrorKind; message: string } | null {
  for (const rule of rules) {
    // Built-in errorRules use /i, but ccmux.json overrides can carry any
    // flag. exec() on a /g regex advances lastIndex on each match, so
    // without a reset a subsequent invocation's call would start
    // mid-string and skip a legitimate match. Mirrors isPromptReady.
    rule.match.lastIndex = 0;
    const m = rule.match.exec(text);
    if (m) {
      return {
        kind: rule.kind,
        message: rule.message ?? m[0] ?? "",
      };
    }
  }

  return null;
}

export function resolveInvokePositionals(
  args: string[],
  knownAgentNames: string[],
): { agent: string; promptArg: string | undefined } {
  const known = new Set(knownAgentNames);

  if (args.length === 0) {
    return { agent: "claude", promptArg: undefined };
  }

  if (args.length === 1) {
    if (known.has(args[0])) {
      return { agent: args[0], promptArg: undefined };
    }

    return { agent: "claude", promptArg: args[0] };
  }

  if (known.has(args[0])) {
    return { agent: args[0], promptArg: args.slice(1).join(" ") };
  }

  return { agent: "claude", promptArg: args.join(" ") };
}
