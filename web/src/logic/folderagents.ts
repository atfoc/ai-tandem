// The "agents working in this folder" hint: how many agents work in a folder now, counted in the
// client from every branch's record. Branches of one chat, and chats, may share a working folder,
// and then they can change the same files.
import { isBusy } from "./status.ts";
import { serverOf } from "./serverlists.ts";
import type { BranchState, ChatView, RunView } from "../types.ts";

/** The agents working in a folder: `here` in the branches of one chat, `elsewhere` in other chats. */
export type FolderAgents = { total: number; here: number; elsewhere: number };

const trimmed = (p: string) => p.replace(/\/+$/, "") || (p ? "/" : "");

/** Two paths name the same folder: both set, and equal as strings but for trailing slashes. Case
 *  and symlinks are not looked at, and a folder inside the other is another folder. */
export function sameFolder(a?: string, b?: string): boolean {
  return !!a && !!b && trimmed(a) === trimmed(b);
}

/** The last segment of a path, as a folder is called; "/" for the root. */
export function folderName(p: string): string {
  const t = trimmed(p);
  return t.slice(t.lastIndexOf("/") + 1) || t;
}

/** The agents of one branch: its own while it is in a turn (approval included), and each subagent
 *  the app spawned for it that still runs; those work in the same folder. */
export function agentsOf(st: Pick<BranchState, "status" | "subsRunning">): number {
  return (isBusy(st.status) ? 1 : 0) + (st.subsRunning ?? 0);
}

/** The agents working in `cwd`, seen from `chat`. A record counts when its chat is known and not
 *  archived, its folder is `cwd` and it is on the server `chat` is on (the same path on another
 *  machine is another folder). A chat of a run on another server (a chat on it, one of its
 *  agents) is where that run is, whatever its own view says: `runs` gives the runs. */
export function folderAgents(p: { chats: Record<string, ChatView>; states: Iterable<BranchState>; cwd?: string; chat: string; runs?: Record<string, Pick<RunView, "server">> }): FolderAgents {
  let here = 0, elsewhere = 0;
  const on = (c?: Pick<ChatView, "server" | "run">) => (c?.run && p.runs?.[c.run]?.server) || serverOf(c);
  const server = on(p.chats[p.chat]);
  for (const st of p.states) {
    const c = p.chats[st.chat];
    if (!c || c.archived || !sameFolder(st.cwd, p.cwd) || on(c) !== server) continue;
    const agents = agentsOf(st);
    if (st.chat === p.chat) here += agents; else elsewhere += agents;
  }
  return { total: here + elsewhere, here, elsewhere };
}
