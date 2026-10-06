// The "agents working in this folder" hint: how many agents work in a folder now, counted in the
// client from every branch's record. Branches of one chat, and chats, may share a working folder,
// and then they can change the same files.
import { isBusy } from "./status.ts";
import type { BranchState, ChatView } from "../types.ts";

/** The agents working in a folder: `here` in the branches of one chat, `elsewhere` in other chats;
 *  `who` names the branches, that chat's first, then by chat id and branch. */
export type FolderAgents = { total: number; here: number; elsewhere: number; who: { chat: string; branch: string; agents: number }[] };

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
 *  archived and its folder is `cwd`. `self` is the branch that asks and is left out with its
 *  subagents; null leaves none out (a branch about to start is one more agent beside them all). */
export function folderAgents(p: { chats: Record<string, ChatView>; states: Iterable<BranchState>; cwd?: string; chat: string; self?: { chat: string; branch: string } | null }): FolderAgents {
  const who: FolderAgents["who"] = [];
  let here = 0, elsewhere = 0;
  for (const st of p.states) {
    const c = p.chats[st.chat];
    if (!c || c.archived || !sameFolder(st.cwd, p.cwd)) continue;
    if (p.self && p.self.chat === st.chat && p.self.branch === st.branch) continue;
    const agents = agentsOf(st);
    if (!agents) continue;
    if (st.chat === p.chat) here += agents; else elsewhere += agents;
    who.push({ chat: st.chat, branch: st.branch, agents });
  }
  const rank = (w: { chat: string }) => (w.chat === p.chat ? 0 : 1);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  who.sort((a, b) => rank(a) - rank(b) || cmp(a.chat, b.chat) || cmp(a.branch, b.branch));
  return { total: here + elsewhere, here, elsewhere, who };
}
