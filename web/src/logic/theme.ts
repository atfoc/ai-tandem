// The colour theme: the user's choice (light, dark, or the system's) and the theme it comes to.
// DOM-free. index.html repeats `resolveTheme` inline so the page never paints the wrong theme first.

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_PREFS: ThemePref[] = ["light", "dark", "system"];

/** The choice saved in localStorage "aiwb.theme"; anything else is "system". */
export function parseThemePref(saved: string | null): ThemePref {
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** The theme shown: the choice, or the system's when the choice is "system". */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}
