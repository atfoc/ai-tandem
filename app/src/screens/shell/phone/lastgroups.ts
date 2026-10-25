// The phone's stack during a server's outage (ux-improvements goal 3.1.2, X2). The store drops a remote server's tree when it leaves
// `connected`, so `sections[server].groups` is empty and `stackOf` finds no group for the open chat's place: the stack would be Home › chat
// and a back would land on Home. Home and a group's screen keep the last tree they drew of each server, in memory (home/lastsync.ts) and draw it
// faded while the server is away; the stack takes its groups from the same copy. Pure apart from reading that copy; nothing is saved.
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import { lastPlace } from "../../home/lastsync.ts";
import type { HomePlace, StackState } from "../stack.ts";

/** `s`, with the groups of every remote server the stack can need (the one of what is open, and Home's) whose live section holds none
 *  filled from the server's last known tree. Live groups always win; `s` itself when nothing is filled. `last` is the copy to read (the
 *  last sync by default). */
export function withLastGroups(s: StackState, place: HomePlace, last: (server: string) => { groups: StackState["groups"] } | undefined = lastPlace): StackState {
  let sections: StackState["sections"] | null = null;
  for (const server of serversOf(s, place)) {
    if (server === LOCAL_SERVER || s.sections[server]?.groups.length) continue;
    const groups = last(server)?.groups;
    if (!groups?.length) continue;
    sections ??= { ...s.sections };
    sections[server] = { ...s.sections[server], groups };
  }
  return sections ? { ...s, sections } : s;
}

/** The servers the open things belong to: the ones a stack can need groups of. */
function serversOf(s: StackState, place: HomePlace): string[] {
  const keys = [s.sel.board, s.sel.chat].filter((k): k is string => !!k);
  return [...new Set(keys.map((k) => serverOfKey(k)).concat(place.server ?? []))];
}
