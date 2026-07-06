import { getPreferences, DEFAULT_SIDEBAR_WIDTH } from "../../lib/preferences";

/** Quiet period after the last pane-width change before we treat it as settled.
 * Long enough to outlast the window-resized hook's re-pin (a CLI boot plus a
 * resize-pane), so transient proportional rescales never read as user intent. */
export const WIDTH_SETTLE_MS = 800;

/** Widths below this are layout accidents (squeezed panes), never preferences. */
const MIN_PERSIST_WIDTH = 10;

interface PersistDecision {
  settledWidth: number;
  configuredWidth: number;
  /** Window width at settle time; null when tmux could not be queried. */
  windowWidth: number | null;
  /** Window width at the previous settle (or mount); null when unknown. */
  prevWindowWidth: number | null;
}

/**
 * A user drag changes the pane's width while the window stays the same size.
 * Window resizes (session switch with window-size=latest, terminal resize)
 * change both, and the window-resized hook re-pins those, so they must not
 * be persisted. Unknown window widths fail safe: never persist.
 */
export function shouldPersistWidth(d: PersistDecision): boolean {
  if (d.settledWidth < MIN_PERSIST_WIDTH) return false;
  if (d.windowWidth === null || d.prevWindowWidth === null) return false;
  if (d.windowWidth !== d.prevWindowWidth) return false;
  return d.settledWidth !== d.configuredWidth;
}

async function getWindowWidth(): Promise<number | null> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    const proc = Bun.spawn(
      ["tmux", "display-message", "-p", "-t", pane, "#{window_width}"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const width = Number.parseInt(out, 10);
    return Number.isInteger(width) ? width : null;
  } catch {
    return null;
  }
}

function spawnApplyWidth(width: number): void {
  Bun.spawn(["ccmux", "sidebar", "--apply-width", String(width)], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Returns a callback the sidebar invokes with its settled pane width.
 * When the settled width is a user drag (see shouldPersistWidth), it spawns
 * `ccmux sidebar --apply-width` to persist the preference and resize every
 * other sidebar. Propagated resizes settle at the already-persisted width
 * and no-op, so sidebars never echo each other.
 */
export function createSidebarWidthPersister(): (width: number) => void {
  let lastWindowWidth: number | null = null;
  void getWindowWidth().then((w) => {
    lastWindowWidth = w;
  });

  return (settledWidth: number) => {
    void (async () => {
      const windowWidth = await getWindowWidth();
      const prevWindowWidth = lastWindowWidth;
      lastWindowWidth = windowWidth;

      const prefs = await getPreferences();
      const configuredWidth = prefs.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH;
      if (
        shouldPersistWidth({
          settledWidth,
          configuredWidth,
          windowWidth,
          prevWindowWidth,
        })
      ) {
        spawnApplyWidth(settledWidth);
      }
    })();
  };
}
