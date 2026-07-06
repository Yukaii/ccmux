import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import {
  getStatusIcon,
  VALID_ICON_STYLES,
  isValidIconStyle,
  type IconStyle,
} from "../lib/icons";
import { formatRelativeTime } from "../lib/format";
import { getPreferences } from "../lib/preferences";
import type { EnrichedSession } from "../types";

function formatSession(session: EnrichedSession, style: IconStyle): string {
  const icon = getStatusIcon(session.status, session.attentionType, style);
  const attention = session.attentionType
    ? ` [${session.attentionType}${session.pendingTool ? `: ${session.pendingTool}` : ""}]`
    : "";
  const attn =
    session.attentionState && session.status === "idle" ? " {done}" : "";
  const pane = session.tmuxPane ? ` (${session.tmuxTarget})` : "";
  const time = formatRelativeTime(new Date(session.updatedAt), " ago");

  const prefix = icon ? `${icon} ` : "";
  return `${prefix}${session.project} - ${session.status}${attention}${attn}${pane} - ${time}`;
}

export function createShowCommand(): Command {
  return new Command("show")
    .description("List all sessions")
    .option("-j, --json", "Output as JSON")
    .option("--icons <style>", "Icon style: none, emoji, nerdfont, dot")
    .action(async (options: { json?: boolean; icons?: string }) => {
      if (options.icons && !isValidIconStyle(options.icons)) {
        console.error(
          `Invalid icon style: ${options.icons}. Valid styles: ${VALID_ICON_STYLES.join(", ")}`,
        );
        process.exit(1);
      }

      await ensureDaemon();

      try {
        const prefs = await getPreferences();
        const iconStyle =
          (options.icons as IconStyle) ?? prefs.iconStyle ?? "dot";

        const response = await fetch(`${getDaemonUrl()}/sessions`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const { sessions } = (await response.json()) as {
          sessions: EnrichedSession[];
        };

        if (options.json) {
          console.log(JSON.stringify(sessions, null, 2));
          return;
        }

        if (sessions.length === 0) {
          console.log("No active sessions");
          return;
        }

        console.log(`\nActive Sessions (${sessions.length}):\n`);
        for (const session of sessions) {
          console.log(formatSession(session, iconStyle));
        }
        console.log();
      } catch (error) {
        console.error("Failed to fetch sessions:", error);
        process.exit(1);
      }
    });
}
