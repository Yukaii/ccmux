import { Command } from "commander";
import { existsSync } from "fs";
import {
  CLAUDE_DIR,
  CCMUX_DIR,
  PROJECTS_DIR,
  PID_FILE,
  DAEMON_HOST,
  DAEMON_PORT,
} from "../lib/config";
import { isDaemonRunningAsync, getDaemonPid } from "../daemon";
import { printDaemonHealth } from "./shared";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show overall status")
    .action(async () => {
      console.log("ccmux Status\n");

      console.log("Configuration:");
      console.log(`  ccmux directory: ${CCMUX_DIR}`);
      console.log(`  Claude directory: ${CLAUDE_DIR}`);
      console.log(`  Projects directory: ${PROJECTS_DIR}`);
      console.log(`  Daemon address: ${DAEMON_HOST}:${DAEMON_PORT}`);
      console.log();

      console.log("Paths:");
      console.log(`  ~/.claude exists: ${existsSync(CLAUDE_DIR)}`);
      console.log(`  ~/.claude/projects exists: ${existsSync(PROJECTS_DIR)}`);
      console.log(`  PID file exists: ${existsSync(PID_FILE)}`);
      console.log();

      console.log("Daemon:");
      if (await isDaemonRunningAsync()) {
        const pid = getDaemonPid();
        console.log(`  Status: running (PID: ${pid})`);
        await printDaemonHealth("  ");
      } else {
        console.log("  Status: stopped");
      }
    });
}
