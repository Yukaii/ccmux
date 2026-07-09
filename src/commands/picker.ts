import { Command } from "commander";
import { join } from "path";

/**
 * Resolves the effective `persistent` setting from CLI flag and config,
 * in that precedence order: CLI flag (either `--persistent` or
 * `--no-persistent`) > config value > default (false).
 */
export function resolvePersistent(
  cliPersistent: boolean | undefined,
  configPersistent: boolean | undefined,
): boolean {
  return cliPersistent ?? configPersistent ?? false;
}

/**
 * Picker command — delegates to the lightweight ANSI picker.
 * The heavy OpenTUI/SolidJS picker is replaced by a raw-ANSI
 * implementation at src/picker-light/main.ts for 37x faster startup.
 */
export function createPickerCommand(): Command {
  return new Command("picker")
    .description("Launch the session picker")
    .action(async () => {
      // Fork the light picker as a subprocess, inheriting stdio.
      // This way we don't even need to import the picker module
      // (which would pull in fuzzysort in this process).
      const lightPicker = join(import.meta.dir, "..", "picker-light", "main.ts");
      const proc = Bun.spawn(["bun", lightPicker], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      const exitCode = await proc.exited;
      process.exit(exitCode ?? 0);
    });
}
