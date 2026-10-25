// What the back control of a route shows and does (ux-improvements f2-design.md §7), pure: no React, no react-native, so Node loads it.
// `NavBack` (BackButton.tsx) and the stack sheet (StackSheet.tsx) draw and wire these.
import type { StackEntry } from "./stack.ts";

/** What a press does: the plain back (the entry is the top, so goback.ts also ends a wait for a point), or a pop to the entry under it. */
export type BackPress = { kind: "back" } | { kind: "popTo"; key: string };

/** The back of one entry: the name of the screen it goes back to on a place screen, and what a press does. */
export type NavBackPlan = { label?: string; press: BackPress };

/** Where the entry `key` stands in `entries`; a route outside the stack (no key), or one the stack no longer holds, stands at the top. */
export const entryIndex = (entries: readonly StackEntry[], key: string | null): number => {
  const at = key === null ? -1 : entries.findIndex((e) => e.key === key);
  return at < 0 ? entries.length - 1 : at;
};

/** The back of the entry `key`, or null where there is none: nothing is under the bottom entry (Home). */
export function navBackOf(entries: readonly StackEntry[], key: string | null): NavBackPlan | null {
  const at = entryIndex(entries, key);
  const own = entries[at];
  const under = entries[at - 1];
  if (!own || !under) return null;
  return { label: own.kind === "place" ? under.title : undefined, press: at === entries.length - 1 ? { kind: "back" } : { kind: "popTo", key: under.key } };
}

/** The rows of the stack sheet: the entries from the bottom up to and including the entry `key`, the screen to go back to by its key. */
export const sheetOptions = (entries: readonly StackEntry[], key: string | null): { value: string; label: string }[] =>
  entries.slice(0, entryIndex(entries, key) + 1).map((e) => ({ value: e.key, label: e.title }));

/** The key a pick of the sheet goes back to; null when the pick is the entry's own (the sheet only closes). */
export const pickTarget = (ownKey: string, picked: string): string | null => (picked === ownKey ? null : picked);
