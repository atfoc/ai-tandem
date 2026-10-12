// The prompt library: the shapes the local server sends (Go: internal/library), and how a page
// keeps the list of libraries up to date. Every server has one library; the page gets them all
// from the local server, each under its server's id in the server list (logic/servers.ts).
//
// A page has the list from the snapshot (`libraries`) or from GET /api/library, and then one
// `library` event for every library that changes (upsertLibrary) and one `library_removed` for
// a server that left the server list (removeLibrary). It never polls. The calls that change a
// library are in libraryapi.ts.

/** A group: a name, and the prompts and groups whose `parent` it is. */
export type LibraryGroup = {
  id: string;     // "g_" and 12 hex digits; made by the library's server, never changed
  name: string;   // 1 to 80 characters, no "/" and no line break; unique in its group, whatever the case
  parent: string; // the id of the group it is in; "" = at the top of the library
};

/** A prompt: a name and the text that is inserted. */
export type LibraryPrompt = {
  id: string;     // "p_" and 12 hex digits
  name: string;   // as a group's; a prompt and a group of one group cannot share a name either
  parent: string; // the id of the group it is in; "" = at the top of the library
  text: string;   // plain text with line breaks, as it was saved; may be empty
};

/** One server's library. The lists are flat and in the order the items were made: the tree is in
 *  the `parent` fields, and its order on screen is the page's. */
export type LibraryView = {
  server: string;     // the server's id in the server list; "local" = this computer
  name: string;       // the server's name
  connected: boolean; // false: the copy last received from a server that dropped; it cannot be changed until the server is back
  notice?: string;    // why the library's file was set aside when its server started; absent for none
  groups: LibraryGroup[];
  prompts: LibraryPrompt[];
};

/** The `library` event: one library as it is now, whole. */
export type LibraryEvent = { type: "library"; library: LibraryView };
/** The `library_removed` event: the library of this server is gone. */
export type LibraryRemovedEvent = { type: "library_removed"; server: string };

/** The limits a server holds a library to. A page's own checks are a convenience: the server refuses what breaks a rule. */
export const LIBRARY_LIMITS = {
  name: 80,       // characters of a name
  text: 100_000,  // characters of a prompt's text
  items: 5_000,   // groups and prompts of one library together
  bytes: 4 << 20, // bytes of all names and texts of one library together (UTF-8)
  depth: 16,      // groups inside one another, the top one counted
} as const;

/** The `code` of the ApiError a refused library call throws; its message is a sentence to show as it is.
 *  no_server: the server named has no library here. The others each name a rule of the library:
 *  bad_name (empty, too long, with "/" or a line break), name_taken (a group or prompt of the same group has it),
 *  not_found (the group or prompt of the call was deleted meanwhile), no_group (the group to put it in is gone),
 *  bad_move (a group into itself or below itself), bad_text, text_too_long, library_full, too_deep.
 *  A call for another server's library has three more, of the way there: server_unreachable (the server is not
 *  connected: nothing was sent), no_answer (it did not answer in time) and bad_answer (its answer cannot be used). */
export type LibraryCode = "bad_name" | "name_taken" | "not_found" | "no_group" | "bad_move" | "bad_text" | "text_too_long" | "library_full" | "too_deep" | "no_server"
  | "server_unreachable" | "no_answer" | "bad_answer";

/** A snapshot's libraries; a server before the feature sends none. */
export function librariesOf(s: { libraries?: LibraryView[] | null }): LibraryView[] {
  return s.libraries ?? [];
}

/** The list with this library in the place of the one of its server, or at the end. For a `library` event. */
export function upsertLibrary(list: LibraryView[], v: LibraryView): LibraryView[] {
  return list.some((x) => x.server === v.server) ? list.map((x) => (x.server === v.server ? v : x)) : [...list, v];
}

/** The list without the library of this server. For a `library_removed` event. */
export function removeLibrary(list: LibraryView[], server: string): LibraryView[] {
  return list.some((x) => x.server === server) ? list.filter((x) => x.server !== server) : list;
}

/** The list with this group or prompt in its server's library when that library has none with its id; a library that
 *  has it, and a list without the library, stay as they are. For the answer of a call that made an item: the `library`
 *  event with it is the stream's, and this is for a stream that did not bring it. */
export function insertItem(list: LibraryView[], server: string, kind: "group" | "prompt", item: LibraryGroup | LibraryPrompt): LibraryView[] {
  return list.map((v) => {
    if (v.server !== server) return v;
    if (kind === "group") return (v.groups ?? []).some((g) => g.id === item.id) ? v : { ...v, groups: [...(v.groups ?? []), { id: item.id, name: item.name, parent: item.parent }] };
    return (v.prompts ?? []).some((p) => p.id === item.id) ? v : { ...v, prompts: [...(v.prompts ?? []), { id: item.id, name: item.name, parent: item.parent, text: "text" in item ? item.text : "" }] };
  });
}
