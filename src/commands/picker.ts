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
 *
 * In normal operation the thin dispatcher at `src/index.ts` catches the
 * `picker` command (and the default no-args path) before the full CLI is
 * even loaded, so this command handler is only reached in edge cases.
 *
 * - Dev mode (`bun`): spawn picker-light as a subprocess (avoids pulling
 *   fuzzysort into the full-CLI process).
 * - Compiled binary: re-exec the binary itself, which goes through the
 *   dispatcher's fast-path without loading OpenTUI.
 */
export function createPickerCommand(): Command {
  return new Command("picker")
    .description("Launch the session picker")
    .option("--persistent", "Keep the picker open after switching")
    .option("--no-persistent", "Close the picker after switching")
    .action(async () => {
      const { isStandaloneBinary } = await import(
        "../daemon/lifecycle"
      );

      if (isStandaloneBinary(process.argv[1])) {
        // Compiled binary: re-exec ourselves to hit the dispatcher's
        // fast-path (no OpenTUI).
        const proc = Bun.spawn([process.execPath], {
          stdio: ["inherit", "inherit", "inherit"],
        });
        const exitCode = await proc.exited;
        process.exit(exitCode ?? 0);
      }

      // Dev mode: spawn bun with the picker-light source directly.
      const lightPicker = join(
        import.meta.dir,
        "..",
        "picker-light",
        "main.ts",
      );
      const proc = Bun.spawn(["bun", lightPicker], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      const exitCode = await proc.exited;
      process.exit(exitCode ?? 0);
    });
}
