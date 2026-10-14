// The routes of the prompt library (/api/library/local/…): every server answers them for its own library, which is
// the one the page calls "local" there. A page keeps the libraries of every server (store `libraries`, filled from each
// entry's snapshot and `own_library` events, logic/library.ts) and names the server in each call that changes one, by
// its id in the server list (LOCAL_SERVER = this computer): the call goes to that server. After a change that server
// sends its library whole in an `own_library` event.
//
// A call that breaks a rule of the library throws an ApiError whose message is a sentence to
// show as it is and whose code is a LibraryCode.
import { call } from "./api.ts";
import type { LibraryGroup, LibraryPrompt } from "./logic/library.ts";

/** A change of a group; a field left out keeps its value. parent moves the group, "" to the top. */
export type GroupChange = { name?: string; parent?: string };
/** A change of a prompt; a field left out keeps its value. All given fields are saved together or not at all. */
export type PromptChange = { name?: string; parent?: string; text?: string };

// (a server's library is its own: the id in the path is always "local")
const at = "/api/library/local";
const item = (kind: "groups" | "prompts", id: string) => `${at}/${kind}/${encodeURIComponent(id)}`;

export const libraryApi = {
  /** Makes a group in the group `parent` of that server's library; "" = at the top. */
  createGroup: (server: string, name: string, parent = "") => call<{ group: LibraryGroup }>(server, "POST", `${at}/groups`, { name, parent }),
  /** Makes a prompt in the group `parent` of that server's library; "" = at the top. */
  createPrompt: (server: string, name: string, parent: string, text: string) => call<{ prompt: LibraryPrompt }>(server, "POST", `${at}/prompts`, { name, parent, text }),
  /** Renames a group, moves it, or both. */
  changeGroup: (server: string, id: string, change: GroupChange) => call<{ group: LibraryGroup }>(server, "PATCH", item("groups", id), change),
  /** Renames a prompt, moves it, changes its text, or all of it. The later of two saves wins. */
  changePrompt: (server: string, id: string, change: PromptChange) => call<{ prompt: LibraryPrompt }>(server, "PATCH", item("prompts", id), change),
  /** Deletes a group with every group and prompt in it. */
  deleteGroup: (server: string, id: string) => call<{ ok: boolean }>(server, "DELETE", item("groups", id)),
  deletePrompt: (server: string, id: string) => call<{ ok: boolean }>(server, "DELETE", item("prompts", id)),
};
