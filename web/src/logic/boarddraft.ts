// A new whiteboard whose server is not chosen yet: the "Untitled" row in the sidebar and the
// choice in the main area (BoardChoice.tsx). With no server but this computer there is no draft:
// the board is made here at once. The server cannot be changed afterwards.
import { LOCAL_SERVER } from "../types.ts";
import { THIS_COMPUTER, type ServerOption } from "./serverlists.ts";
import { stateLabel, type ServerView } from "./servers.ts";

export type BoardDraft = { group: string; busy?: boolean; error?: string };

export const CHOICE_TITLE = "Where should this board live?";
/** The draft row's text, and the name the board is made with. */
export const DRAFT_NAME = "Untitled";
export const CREATE_FAILED = "Couldn't create the whiteboard";

const remote = (v: ServerView): boolean => !v.local && v.id !== LOCAL_SERVER;

/** Whether the server list has an entry besides this computer: only then a new board asks where it is to live. */
export const hasRemote = (servers: ServerView[]): boolean => servers.some(remote);

/** The servers a new board can be put on: this computer first, then every entry with its name.
 *  One that is not connected is disabled with its state as the reason, also one that may come
 *  back by itself: the board is made at once. */
export function boardOptions(servers: ServerView[]): ServerOption[] {
  const options: ServerOption[] = [{ id: LOCAL_SERVER, label: THIS_COMPUTER }];
  for (const v of servers) {
    if (!remote(v)) continue;
    options.push(v.state === "connected" ? { id: v.id, label: v.name } : { id: v.id, label: v.name, disabled: true, reason: stateLabel(v.state) });
  }
  return options;
}

/** The line for a creation the server refused, with the answer's own sentence. */
export const createError = (e: unknown): string => {
  const said = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return said ? `${CREATE_FAILED}: ${said}` : CREATE_FAILED;
};
