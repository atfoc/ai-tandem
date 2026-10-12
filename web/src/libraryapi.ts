// The routes of the prompt library (/api/library), which the local server answers on loopback
// alone. A page reads the libraries of every server in one list and names the server in each
// call that changes one, by its id in the server list (LOCAL_SERVER = this computer); the local
// server passes a call for another server on. After a change every window gets the changed
// library whole in a `library` event (logic/library.ts), the window that made the call too.
//
// A call that breaks a rule of the library throws an ApiError whose message is a sentence to
// show as it is and whose code is a LibraryCode.
import { call } from "./api.ts";
import type { LibraryGroup, LibraryPrompt, LibraryView } from "./logic/library.ts";

/** GET /api/library: this computer's library first. */
export type LibraryList = { libraries: LibraryView[] };
/** A change of a group; a field left out keeps its value. parent moves the group, "" to the top. */
export type GroupChange = { name?: string; parent?: string };
/** A change of a prompt; a field left out keeps its value. All given fields are saved together or not at all. */
export type PromptChange = { name?: string; parent?: string; text?: string };

const at = (server: string) => `/api/library/${encodeURIComponent(server)}`;
const item = (server: string, kind: "groups" | "prompts", id: string) => `${at(server)}/${kind}/${encodeURIComponent(id)}`;

export const libraryApi = {
  read: () => call<LibraryList>("GET", "/api/library"),
  /** Makes a group in the group `parent` of that server's library; "" = at the top. */
  createGroup: (server: string, name: string, parent = "") => call<{ group: LibraryGroup }>("POST", `${at(server)}/groups`, { name, parent }),
  /** Makes a prompt in the group `parent` of that server's library; "" = at the top. */
  createPrompt: (server: string, name: string, parent: string, text: string) => call<{ prompt: LibraryPrompt }>("POST", `${at(server)}/prompts`, { name, parent, text }),
  /** Renames a group, moves it, or both. */
  changeGroup: (server: string, id: string, change: GroupChange) => call<{ group: LibraryGroup }>("PATCH", item(server, "groups", id), change),
  /** Renames a prompt, moves it, changes its text, or all of it. The later of two saves wins. */
  changePrompt: (server: string, id: string, change: PromptChange) => call<{ prompt: LibraryPrompt }>("PATCH", item(server, "prompts", id), change),
  /** Deletes a group with every group and prompt in it. */
  deleteGroup: (server: string, id: string) => call<{ ok: boolean }>("DELETE", item(server, "groups", id)),
  deletePrompt: (server: string, id: string) => call<{ ok: boolean }>("DELETE", item(server, "prompts", id)),
};
