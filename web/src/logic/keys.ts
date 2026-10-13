// How the page names a thing. A thing of this computer is named by its id. A thing of a section
// (a remote server, an entry of the server list) is named by two values, the entry id and its id
// on that server: an id is unique on one server only, so the same id can be a local chat and a
// chat of a section, or a chat of two sections. The page joins the two into one key and keys
// everything by it (the store's maps, the selection, the tree, the drop mark, the boards' scenes),
// so a local thing and a section's can never be taken for each other.
//
// The key is the page's own. On the wire the two values stay apart: logic/sectionwire.ts makes
// the keys of what comes in, and api.ts splits a key into the path's entry id and the server's
// own id, and writes that server's own ids into every body. DOM-free.
import { LOCAL_SERVER, UNGROUPED } from "../types.ts";

/** Between the entry id and the id. No id of a server has it: an id is base36, hex or a UUID, with "_" or "-". */
const SEP = "~";

/** The key of a thing: its id on this computer, "<entry id>~<id>" in a section. */
export const keyOn = (server: string | null | undefined, id: string): string =>
  (server && server !== LOCAL_SERVER ? `${server}${SEP}${id}` : id);

/** A key's two values: the entry id (LOCAL_SERVER for a thing of this computer) and the id on that server. */
export function splitKey(key: string): { server: string; id: string } {
  const at = key.indexOf(SEP);
  return at < 0 ? { server: LOCAL_SERVER, id: key } : { server: key.slice(0, at), id: key.slice(at + 1) };
}

/** The entry id of the server a thing is on; LOCAL_SERVER for this computer, and for no key. */
export const serverOfKey = (key?: string | null): string => (key ? splitKey(key).server : LOCAL_SERVER);

/** Whether a key names a thing of a section. */
export const inSection = (key?: string | null): boolean => serverOfKey(key) !== LOCAL_SERVER;

/** A thing's id on its own server: what a path and a body carry. */
export const ownId = (key: string): string => splitKey(key).id;

/** Whether two things are on the same server: nothing is moved, mentioned or dropped across. */
export const sameServer = (a?: string | null, b?: string | null): boolean => serverOfKey(a) === serverOfKey(b);

/** The key of a server's ungrouped area: the group id UNGROUPED is the same on every server. */
export const ungroupedOn = (server: string | null | undefined): string => keyOn(server, UNGROUPED);

/** Whether a group key is a server's ungrouped area. */
export const isUngrouped = (group: string): boolean => ownId(group) === UNGROUPED;

/** Where the local server answers for a server: "/api" for this computer, "/api/on/<entry id>" for a section. */
export const apiRoot = (server: string | null | undefined): string =>
  (server && server !== LOCAL_SERVER ? `/api/on/${encodeURIComponent(server)}` : "/api");

/** The path of a call about a thing: "/api/<kind>/<id>" on this computer, "/api/on/<entry id>/<kind>/<id>" in a
 *  section. The one place a key becomes a path: the id in it is the server's own. */
export function pathOf(kind: "groups" | "boards" | "chats" | "runs", key: string): string {
  const { server, id } = splitKey(key);
  return `${apiRoot(server)}/${kind}/${id}`;
}
