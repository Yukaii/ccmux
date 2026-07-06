import type { ThemePalette } from "../../lib/preferences";
import { catppuccinMocha } from "./catppuccin-mocha";
import { catppuccinMacchiato } from "./catppuccin-macchiato";
import { catppuccinFrappe } from "./catppuccin-frappe";
import { catppuccinLatte } from "./catppuccin-latte";
import { tokyoNight } from "./tokyo-night";
import { tokyoNightStorm } from "./tokyo-night-storm";
import { tokyoNightDay } from "./tokyo-night-day";
import { dracula } from "./dracula";
import { gruvboxDark } from "./gruvbox-dark";
import { gruvboxLight } from "./gruvbox-light";
import { nord } from "./nord";
import { rosePine } from "./rose-pine";
import { rosePineMoon } from "./rose-pine-moon";
import { rosePineDawn } from "./rose-pine-dawn";

/** Name of the default theme, applied when none is configured or on fallback. */
export const DEFAULT_THEME_NAME = "catppuccin-mocha";

/** Built-in palettes keyed by their config name. */
export const BUILTIN_THEMES: Record<string, ThemePalette> = {
  "catppuccin-mocha": catppuccinMocha,
  "catppuccin-macchiato": catppuccinMacchiato,
  "catppuccin-frappe": catppuccinFrappe,
  "catppuccin-latte": catppuccinLatte,
  "tokyo-night": tokyoNight,
  "tokyo-night-storm": tokyoNightStorm,
  "tokyo-night-day": tokyoNightDay,
  dracula: dracula,
  "gruvbox-dark": gruvboxDark,
  "gruvbox-light": gruvboxLight,
  nord: nord,
  "rose-pine": rosePine,
  "rose-pine-moon": rosePineMoon,
  "rose-pine-dawn": rosePineDawn,
};

/** All built-in theme names, in registry order. */
export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEMES);
