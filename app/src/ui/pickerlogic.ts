// What a PickerSheet shows (ux-improvements goal 3.1.4): the plain decisions, so that Node tests them. No React and no react-native here.

/** Past this many options a picker has a search, and opens on the large detent. */
export const SEARCH_OVER = 8;

type Searchable = { label: string; note?: string; section?: string };

/** Search is forced by `search` (true or false); by default it is on past eight options. */
export function searchOn(count: number, search?: boolean): boolean {
  return search ?? count > SEARCH_OVER;
}

/** The options whose label or note holds the query (case-insensitive, surrounding blanks ignored); all of them for an empty query. */
export function filterOptions<O extends Searchable>(options: O[], query: string): O[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q) || (o.note ?? "").toLowerCase().includes(q));
}

export type Group<O> = {
  /** The heading, or undefined for options without a section. */
  section: string | undefined;
  options: O[];
};

/** The shown options in runs of one section, in order; a section with no match has no run, so no heading. */
export function groupBySection<O extends Searchable>(shown: O[]): Group<O>[] {
  const out: Group<O>[] = [];
  for (const o of shown) {
    const last = out[out.length - 1];
    if (last && last.section === o.section) last.options.push(o);
    else out.push({ section: o.section, options: [o] });
  }
  return out;
}

/** What the sheet says when nothing matches. */
export function emptyLine(query: string): string {
  return `No match for “${query.trim()}”`;
}
