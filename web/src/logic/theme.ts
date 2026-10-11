// The colour theme: the user's choice (light, dark, the system's, or a Catppuccin flavour) and what the page shows
// for it. DOM-free. index.html repeats `resolveTheme` and `flavourOf` inline so the page never paints the wrong theme
// first; test/theme.test.ts runs that script against these two.
//
// A flavour is laid over light or dark: Latte over light, the other three over dark. So the page still has a theme
// that is one of the two, which the canvas takes and every "light or dark" rule reads, and the flavour beside it:
// flavours.css sets the flavour's colours, and what it does not set stays the theme's.

/** The Catppuccin flavours (their colours: logic/flavours.ts). */
export const FLAVOURS = ["latte", "frappe", "macchiato", "mocha"] as const;
export type Flavour = typeof FLAVOURS[number];

export type ThemePref = "light" | "dark" | "system" | Flavour;
export type Theme = "light" | "dark";

/** The choices, in the picker's order. */
export const THEME_PREFS: ThemePref[] = ["light", "dark", "system", ...FLAVOURS];

export const THEME_LABELS: Record<ThemePref, string> = {
  light: "Light", dark: "Dark", system: "System", latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha",
};

/** The choice saved in localStorage "aiwb.theme"; anything else is "system". */
export function parseThemePref(saved: string | null): ThemePref {
  return THEME_PREFS.find((p) => p === saved) ?? "system";
}

/** The flavour a choice is; null for light, dark and system. */
export function flavourOf(pref: ThemePref): Flavour | null {
  return FLAVOURS.find((f) => f === pref) ?? null;
}

/** The theme shown: the choice, the system's when the choice is "system", or the one a flavour is laid over. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "light" || pref === "latte") return "light";
  if (pref === "system") return systemDark ? "dark" : "light";
  return "dark";
}

/** What the picker's button says of the choice, in its tooltip. */
export function themeTitle(pref: ThemePref): string {
  if (pref === "system") return "Theme: System (follows the OS)";
  return `Theme: ${flavourOf(pref) ? "Catppuccin " : ""}${THEME_LABELS[pref]}`;
}

export type ThemeItem = { pref: ThemePref; label: string; on: boolean };

/** The picker's menu: the three themes, then the four flavours under their own head. `on` marks the choice. */
export function themeMenu(pref: ThemePref): { head: string; items: ThemeItem[] }[] {
  const item = (p: ThemePref): ThemeItem => ({ pref: p, label: THEME_LABELS[p], on: p === pref });
  return [
    { head: "Theme", items: THEME_PREFS.filter((p) => !flavourOf(p)).map(item) },
    { head: "Catppuccin", items: FLAVOURS.map(item) },
  ];
}
