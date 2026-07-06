import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  stopDaemonByPort,
  isDaemonRunning,
  isDaemonRunningAsync,
  getDaemonPid,
  findDaemonPidByPort,
  waitForDaemon,
  spawnDaemonBackground,
} from "../daemon";
import { DAEMON_PORT, DAEMON_HOST, LOG_FILE } from "../lib/config";
import { printDaemonHealth } from "./shared";

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the daemon process");

  daemon
    .command("start")
    .description("Start the daemon")
    .option("-b, --background", "Run in background")
    .option("--foreground", "Keep stdio on the TTY (skip log-file redirect)")
    .action(async (options) => {
      if (isDaemonRunning()) {
        const pid = getDaemonPid();
        console.log(`Daemon is already running (PID: ${pid})`);
        process.exit(1);
      }

      // Detect orphaned daemon holding the port
      if (await isDaemonRunningAsync()) {
        console.log(
          "Detected orphaned daemon via health check, stopping it...",
        );
        await stopDaemonByPort();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (options.background) {
        spawnDaemonBackground();

        if (await waitForDaemon()) {
          const pid = getDaemonPid();
          console.log(`Daemon started in background (PID: ${pid})`);
        } else {
          console.error("Failed to start daemon");
          process.exit(1);
        }
      } else {
        if (options.foreground) process.env.CCMUX_DAEMON_FOREGROUND = "1";
        console.log(`Starting daemon on ${DAEMON_HOST}:${DAEMON_PORT}...`);
        if (!options.foreground) console.log(`Logs → ${LOG_FILE}`);
        await startDaemon();
      }
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      if (!isDaemonRunning()) {
        // Fallback: check health endpoint for orphaned daemon
        if (await isDaemonRunningAsync()) {
          console.log(
            "Detected orphaned daemon via health check, stopping it...",
          );
          const stopped = await stopDaemonByPort();
          if (stopped) {
            console.log("Daemon stopped");
          } else {
            console.error("Failed to stop orphaned daemon");
            process.exit(1);
          }
          return;
        }

        console.log("Daemon is not running");
        process.exit(1);
      }

      const stopped = await stopDaemon();
      if (stopped) {
        console.log("Daemon stopped");
      } else {
        console.error("Failed to stop daemon");
        process.exit(1);
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      const isRunningPid = isDaemonRunning();
      const isRunningHealth = await isDaemonRunningAsync();

      if (isRunningPid || isRunningHealth) {
        console.log("Stopping daemon...");
        if (!isRunningPid && isRunningHealth) {
          console.log("(Detected orphaned daemon via health check)");
        }
        await stopDaemonByPort();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      spawnDaemonBackground();

      if (await waitForDaemon()) {
        const pid = getDaemonPid();
        console.log(`Daemon restarted in background (PID: ${pid})`);
      } else {
        console.error("Failed to restart daemon");
        process.exit(1);
      }
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      // Use the async check so a live daemon with a missing or corrupt PID
      // file (detected via the `/health` endpoint) is still reported as
      // running, matching `daemon start` / `daemon stop` detection.
      if (!(await isDaemonRunningAsync())) {
        console.log("Daemon: stopped");
        return;
      }

      // Prefer the PID file; fall back to the port listener when the PID
      // file is missing (orphaned daemon).
      const pid = getDaemonPid() ?? (await findDaemonPidByPort());
      console.log(`Daemon: running (PID: ${pid ?? "unknown"})`);
      await printDaemonHealth();
    });

  return daemon;
}
