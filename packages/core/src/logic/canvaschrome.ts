// The chrome of the board in a Catppuccin flavour: the colours Excalidraw's toolbar, panels, menus and dialogs take, as the
// map `ThemeMsg.chrome` carries to the board view (`@aiwb/board-bridge` `chrome.ts` names the custom properties it may
// hold). The old page sets the same properties from the app's tokens in the old page's flavours-canvas.css; this is that file's
// colours as data, from the flavour's tokens (logic/flavours.ts) and palette, and app/test/canvaschrome.test.ts holds
// the two equal. Excalidraw takes only a light or a dark theme, so a flavour is laid over the one it sits on (Latte over
// light, the others over dark) and its greys follow that theme's rules. Plain light and plain dark have no chrome map:
// the chrome is Excalidraw's own. DOM-free.
import type { ChromeMsg } from "@aiwb/board-bridge/chrome.ts";
import { PALETTE, flavourTokens, type Colour } from "./flavours.ts";
import { resolveTheme, type Flavour, type Theme } from "./theme.ts";

/** Where a property's colour comes from: a token the flavour sets (`--bg`) or a colour of its palette (`ctp:blue`). */
type Source = `--${string}` | `ctp:${Colour}`;

const SURFACES: Record<string, Source> = {
  // islands, popups, the side panel; text and icons on them
  "--island-bg-color": "--bg",
  "--popup-secondary-bg-color": "--bg",
  "--color-on-surface": "--text",
  "--popup-text-color": "--text",
  "--popup-text-inverted-color": "--bg",
  "--input-bg-color": "--bg",
  "--input-border-color": "--line-2",
  "--input-hover-bg-color": "--panel",
  "--input-label-color": "--text",
  "--keybinding-color": "--faint",
  "--color-disabled": "--faint",
  "--dialog-border-color": "--line",
  "--link-color": "ctp:blue",
  // a control at rest, under the pointer, pressed
  "--color-surface-low": "--panel",
  "--color-surface-mid": "--panel",
  "--color-surface-high": "--line",
  "--color-border-outline": "ctp:overlay0",
  "--color-border-outline-variant": "--line-2",
  "--button-gray-1": "ctp:surface0",
  "--button-gray-2": "ctp:surface1",
  "--button-gray-3": "ctp:surface2",
  "--scrollbar-thumb": "ctp:surface1",
  "--scrollbar-thumb-hover": "ctp:surface2",
  "--color-slider-track": "--line-2",
  "--color-slider-thumb": "--muted",
  // the accent: the chosen tool, a filled button and what is written on it
  "--color-primary": "--accent",
  "--color-primary-darker": "--accent",
  "--color-primary-darkest": "--accent",
  "--color-primary-hover": "--accent",
  "--color-brand-hover": "--accent",
  "--color-brand-active": "--accent",
  "--color-primary-light": "--accent-soft",
  "--color-primary-light-darker": "--accent-soft",
  "--color-surface-primary-container": "--accent-soft",
  "--color-on-primary-container": "--text",
  "--color-surface-lowest": "--on-accent",
  "--color-icon-white": "--on-accent",
  "--focus-highlight-color": "--accent",
  "--select-highlight-color": "--accent",
  // the strip of the library sidebar's tabs and the ground behind an export's preview: the app's ground
  "--default-bg-color": "--bg",
  // danger
  "--color-danger": "--danger",
  "--color-danger-dark": "--danger-fill",
  "--color-danger-darker": "--danger-fill",
  "--color-danger-darkest": "--danger-fill",
  "--color-danger-text": "--danger",
  "--button-destructive-bg-color": "--danger-soft",
  "--button-destructive-color": "--danger",
  // the board view's own: the ring of an island, a shortcut in a menu
  "--aiwb-line": "--line",
  "--aiwb-faint": "--faint",
};

/** Excalidraw's greys are fixed steps from near white (10) to near black (100), which its rules pick by theme: in light
 *  30 is a border, 40 and 50 a hint, a shortcut or a close button, 60 and up text; in dark 60 is the hint and 40 and
 *  down text. Each step is the palette's colour of that part, and a hint is the app's faint text, which has its floor. */
const GREYS: Record<Theme, Record<string, Source>> = {
  light: {
    "--color-gray-10": "ctp:base", "--color-gray-20": "ctp:mantle", "--color-gray-30": "ctp:surface0", "--color-gray-40": "--faint",
    "--color-gray-50": "--faint", "--color-gray-60": "ctp:subtext0", "--color-gray-70": "ctp:subtext1", "--color-gray-80": "ctp:text",
    "--color-gray-85": "ctp:text", "--color-gray-90": "ctp:text", "--color-gray-100": "ctp:text",
  },
  dark: {
    "--color-gray-10": "ctp:text", "--color-gray-20": "ctp:subtext1", "--color-gray-30": "ctp:subtext0", "--color-gray-40": "ctp:overlay2",
    "--color-gray-50": "--faint", "--color-gray-60": "--faint", "--color-gray-70": "ctp:surface2", "--color-gray-80": "ctp:surface1",
    "--color-gray-85": "ctp:surface0", "--color-gray-90": "ctp:base", "--color-gray-100": "ctp:crust",
  },
};

const made = new Map<Flavour, ChromeMsg>();

/** The chrome map of a flavour: every property of the bridge's list, with the flavour's colour. The same object each time. */
export function chromeOf(flavour: Flavour): ChromeMsg {
  let chrome = made.get(flavour);
  if (!chrome) {
    const tokens = new Map(flavourTokens(flavour).map((t) => [t.name, t.value]));
    const palette = PALETTE[flavour];
    const colour = (s: Source) => {
      const v = s.startsWith("ctp:") ? palette[s.slice(4) as Colour] : tokens.get(s);
      if (!v) throw new Error(`the chrome of ${flavour} has no colour ${s}`);
      return v;
    };
    const sources: Record<string, Source> = { ...SURFACES, ...GREYS[resolveTheme(flavour, false)] };
    chrome = Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, colour(s)])) as ChromeMsg;
    made.set(flavour, chrome);
  }
  return chrome;
}
