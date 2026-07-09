#!/usr/bin/env bun
/**
 * ccmux entry point — thin dispatcher.
 *
 * Routes the `picker` command (and the default no-args invocations) directly
 * to the lightweight ANSI picker (`picker-light`), avoiding the heavy
 * OpenTUI / SolidJS import chain entirely.  All other commands are delegated
 * to the full CLI.
 *
 * In a `bun build --compile` binary both paths are bundled into the same
 * executable; only the code that is actually exercised is loaded at runtime,
 * so the picker stays fast.
 */

const arg = process.argv[2];
const isPicker = !arg || arg === "picker";

if (isPicker) {
  const { main } = await import("./picker-light/main");
  const exitCode = await main();
  process.exit(exitCode ?? 0);
}

// All other commands → full CLI (commander + OpenTUI)
await import("./cli");

export {};
