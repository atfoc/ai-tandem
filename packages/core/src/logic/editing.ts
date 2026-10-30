// How a composer's text box edits (Settings > Composer): what Tab puts in and how wide a tab is. One JSON value in the kv port
// (`aiwb.composer.settings`); the app's state/editing.ts keeps it live, the boxes give it to indent.ts. The width is both the
// number of spaces Tab puts in with "spaces" and the width a tab character is drawn at (CSS `tab-size`).

/** Also an indent.ts IndentStyle. */
export type EditingSettings = { tabInserts: "tab" | "spaces"; tabWidth: TabWidth };

export const TAB_WIDTHS = [2, 4, 8] as const;
export type TabWidth = (typeof TAB_WIDTHS)[number];

export const EDITING_KEY = "aiwb.composer.settings";

export const EDITING_DEFAULTS: EditingSettings = { tabInserts: "tab", tabWidth: 4 };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Settings from anything: a field that is not one of its choices is its default. */
export function clampEditing(v: Partial<Record<keyof EditingSettings, unknown>> | null | undefined): EditingSettings {
  const s = v ?? {};
  return {
    tabInserts: s.tabInserts === "spaces" || s.tabInserts === "tab" ? s.tabInserts : EDITING_DEFAULTS.tabInserts,
    tabWidth: TAB_WIDTHS.find((w) => w === s.tabWidth) ?? EDITING_DEFAULTS.tabWidth,
  };
}

/** The stored text as settings: nothing stored, or text that does not parse, is the defaults. */
export function parseEditing(text: string | null): EditingSettings {
  if (text === null) return { ...EDITING_DEFAULTS };
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? clampEditing(v) : { ...EDITING_DEFAULTS };
  } catch { return { ...EDITING_DEFAULTS }; }
}

export const stringifyEditing = (s: EditingSettings): string => JSON.stringify(clampEditing(s));

export const sameEditing = (a: EditingSettings, b: EditingSettings): boolean => a.tabInserts === b.tabInserts && a.tabWidth === b.tabWidth;
