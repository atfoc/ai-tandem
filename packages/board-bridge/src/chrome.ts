// The colours of the board's chrome (Excalidraw's toolbar, panels, menus and dialogs) in a Catppuccin flavour, as the
// `theme` message carries them: a map from the name of a custom property to a colour. The names are a closed list, the
// custom properties Excalidraw colours its chrome from (`--island-bg-color`, `--color-gray-40`, …) and two of the board
// view's own (`--aiwb-*`, used by the few rules that need a colour in a shadow or in a text of their own); a value is a
// hex colour. The app makes the map from the flavour's tokens (`@aiwb/core` `logic/canvaschrome.ts`), the board view lays
// it over Excalidraw (`@aiwb/board-view` `theme.ts`), and neither can put anything else into the page's style: this
// list is what the validator allows. DOM-free.

/** Every custom property the chrome map may set. */
export const CHROME_VARS = [
  // islands, popups, the side panel; text and icons on them
  "--island-bg-color", "--popup-secondary-bg-color", "--color-on-surface", "--popup-text-color", "--popup-text-inverted-color",
  "--input-bg-color", "--input-border-color", "--input-hover-bg-color", "--input-label-color", "--keybinding-color",
  "--color-disabled", "--dialog-border-color", "--link-color",
  // a control at rest, under the pointer, pressed
  "--color-surface-low", "--color-surface-mid", "--color-surface-high", "--color-border-outline", "--color-border-outline-variant",
  "--button-gray-1", "--button-gray-2", "--button-gray-3", "--scrollbar-thumb", "--scrollbar-thumb-hover",
  "--color-slider-track", "--color-slider-thumb",
  // the accent: the chosen tool, a filled button and what is written on it
  "--color-primary", "--color-primary-darker", "--color-primary-darkest", "--color-primary-hover", "--color-brand-hover",
  "--color-brand-active", "--color-primary-light", "--color-primary-light-darker", "--color-surface-primary-container",
  "--color-on-primary-container", "--color-surface-lowest", "--color-icon-white", "--focus-highlight-color", "--select-highlight-color",
  "--default-bg-color",
  // danger
  "--color-danger", "--color-danger-dark", "--color-danger-darker", "--color-danger-darkest", "--color-danger-text",
  "--button-destructive-bg-color", "--button-destructive-color",
  // Excalidraw's greys, from near white (10) to near black (100)
  "--color-gray-10", "--color-gray-20", "--color-gray-30", "--color-gray-40", "--color-gray-50", "--color-gray-60",
  "--color-gray-70", "--color-gray-80", "--color-gray-85", "--color-gray-90", "--color-gray-100",
  // the board view's own: the app's line (the ring of an island) and faint text (a shortcut in a menu)
  "--aiwb-line", "--aiwb-faint",
] as const;

export type ChromeVar = typeof CHROME_VARS[number];

/** The chrome of a flavour: custom property → hex colour (`#rrggbb`). */
export type ChromeMsg = Partial<Record<ChromeVar, string>>;

/** The one form a colour of the map has. */
export const CHROME_COLOUR = /^#[0-9a-fA-F]{6}$/;

const known: ReadonlySet<string> = new Set(CHROME_VARS);
export const isChromeVar = (name: string): name is ChromeVar => known.has(name);
