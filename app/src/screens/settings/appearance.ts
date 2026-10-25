// What the Appearance screen says (ux-improvements goal 3.8.1, package S1): the rows of the theme list, the words of the flavour row
// and of the footers, and the flavour sheet's options. The theme stays one stored value (`ThemePref`, core logic/theme.ts): with a
// flavour on none of Light, Dark and System is checked, and choosing one of them turns the flavour off. No React, so Node loads it.
import { PALETTE } from "@aiwb/core/logic/flavours.ts";
import { FLAVOURS, THEME_LABELS, flavourOf, resolveTheme, type Flavour, type ThemePref } from "@aiwb/core/logic/theme.ts";

export type ThemeRow = { pref: "light" | "dark" | "system"; label: string; checked: boolean };

/** Light, Dark, System; `checked` only for the one that is the choice (none while a flavour is on). */
export function themeRows(pref: ThemePref): ThemeRow[] {
  return (["light", "dark", "system"] as const).map((p) => ({ pref: p, label: THEME_LABELS[p], checked: p === pref }));
}

/** What the Catppuccin row says at its right. */
export function flavourValue(pref: ThemePref): string {
  const f = flavourOf(pref);
  return f ? THEME_LABELS[f] : "Off";
}

/** The line under the Colours group. */
export function flavourFooter(pref: ThemePref): string {
  const f = flavourOf(pref);
  if (!f) return "Off: the app's own colours.";
  return `${THEME_LABELS[f]} is ${resolveTheme(f, false)}. Choosing a theme above turns it off.`;
}

/** The line under the Theme group. */
export function systemFooter(isWeb: boolean): string {
  return `System follows ${isWeb ? "this device's" : "the phone's"} light or dark setting.`;
}

/** The flavour sheet's options, in the order of FLAVOURS; each says whether it is light or dark. */
export function flavourOptions(): { value: Flavour; label: string; note: "Light" | "Dark" }[] {
  return FLAVOURS.map((f) => ({ value: f, label: THEME_LABELS[f], note: resolveTheme(f, false) === "light" ? "Light" : "Dark" }));
}

/** The two colours of a flavour's swatch: its base and its mauve (palette data: the swatch shows the flavour itself). */
export function swatchOf(flavour: Flavour): [string, string] {
  return [PALETTE[flavour].base, PALETTE[flavour].mauve];
}
