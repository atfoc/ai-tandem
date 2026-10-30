// What Settings > Composer says (core logic/editing.ts): the two choices, the line of Settings' row and the footer. Pure: no React, no
// react-native, so Node loads it.
import { TAB_WIDTHS, type EditingSettings, type TabWidth } from "@aiwb/core/logic/editing.ts";

export const EDITING_TITLE = "Composer";
export const INDENT_TITLE = "Indentation";
export const TAB_INSERTS_TITLE = "Tab inserts";
export const TAB_WIDTH_TITLE = "Tab width";

export const TAB_INSERTS_OPTIONS: { value: EditingSettings["tabInserts"]; label: string }[] = [
  { value: "tab", label: "Tab character" },
  { value: "spaces", label: "Spaces" },
];

export const TAB_WIDTH_OPTIONS: { value: TabWidth; label: string }[] = TAB_WIDTHS.map((w) => ({ value: w, label: String(w) }));

/** The Composer row's second line: "Tab character · width 4", "4 spaces". */
export function editingLine(s: EditingSettings): string {
  return s.tabInserts === "spaces" ? `${s.tabWidth} spaces` : `Tab character · width ${s.tabWidth}`;
}

/** Under the choices: what the keys do in a composer. `platform` is keyplatform.ts' answer: ⌘ on a Mac and an iPad, Ctrl elsewhere. `web`:
 *  the web box's way out by the keyboard (Esc, then Tab: ChipInput.web.tsx) is said too. */
export function editingFooter(platform: string, web = false): string {
  const mod = /Mac|iPhone|iPad/.test(platform) ? "⌘" : "Ctrl+";
  const out = web ? " Esc, then Tab, moves the focus out of the box." : "";
  return `Tab indents and Shift+Tab outdents.${out} Enter adds a line and keeps its indent. ${mod}Enter sends. The width is also how wide a tab character is shown.`;
}
