import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";

export function createSendCommand(): Command {
  return new Command("send")
    .description("Send text to a session's tmux pane")
    .argument("<session-id>", "Session ID or pane ID")
    .argument("<text>", "Text to send")
    .option("--no-enter", "Do not press Enter after sending text")
    .action(async (sessionId: string, text: string, options: { enter: boolean }) => {
      await ensureDaemon();

      try {
        const response = await fetch(
          `${getDaemonUrl()}/sessions/${sessionId}/send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, enter: options.enter }),
          },
        );

        if (response.status === 404) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }

        if (response.status === 400) {
          const data = (await response.json()) as { error: string };
          console.error(data.error);
          process.exit(1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        console.log(`Sent to session: ${sessionId}`);
      } catch (error) {
        console.error("Failed to send to session:", error);
        process.exit(1);
      }
    });
}
