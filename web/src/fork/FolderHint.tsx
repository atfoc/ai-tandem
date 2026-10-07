// The "agents working in this folder" hint: the chip beside the composer's folder and the line in
// the tree popup's foot. Both read every branch's record, so they are components of their own:
// only they render again when some branch of some chat changes its state.
import { useMemo } from "react";
import "./folderhint.css";
import { useStore, chatTitle, shownBranch, shownView, threadOf, viewedBranch, type State } from "../store.ts";
import { branchKey, currentBranch, stateFromView, stateOf } from "../logic/branches.ts";
import { folderAgents, folderName, type FolderAgents } from "../logic/folderagents.ts";
import type { BranchState, ChatView } from "../types.ts";

/** Every branch's record: the ones kept, and for a chat whose current branch has none (a server
 *  that sends no records) the view's own. */
function allStates(chats: Record<string, ChatView>, states: State["states"]): BranchState[] {
  const all = Object.values(states);
  for (const c of Object.values(chats)) if (!states[branchKey(c.id, currentBranch(c))]) all.push(stateFromView(c));
  return all;
}

const SEP = "\u0001";

/** The other chats in `who`, in its order, with their titles. The titles are read as one string, so
 *  that it can be a useStore selector: an unnamed chat's title is its first message, and the items
 *  change all the time. */
function useOthers(fa: FolderAgents, chatId: string): { id: string; title: string }[] {
  const ids = useMemo(() => [...new Set(fa.who.filter((w) => w.chat !== chatId).map((w) => w.chat))], [fa, chatId]);
  const titles = useStore((s) => ids.map((id) => (s.chats[id] ? chatTitle(s.chats[id], threadOf(s, id)?.items) : "")).join(SEP)).split(SEP);
  return ids.map((id, i) => ({ id, title: titles[i] ?? "" }));
}

/** Beside the composer's folder: the agents working in the shown branch's folder now, this branch
 *  left out. While a move is pending none is left out: the next message starts a new branch, one
 *  more agent beside its source. */
export function FolderHint({ chatId }: { chatId: string }) {
  const chats = useStore((s) => s.chats);
  const states = useStore((s) => s.states);
  const runs = useStore((s) => s.runs);
  const cwd = useStore((s) => shownView(s, chatId)?.cwd);
  const branch = useStore((s) => (s.moves[chatId] ? null : shownBranch(s, chatId)));
  const fa = useMemo(
    () => folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId, self: branch === null ? null : { chat: chatId, branch }, runs }),
    [chats, states, cwd, chatId, branch, runs],
  );
  const others = useOthers(fa, chatId);
  if (fa.total < 1) return null;
  const parts = fa.here ? [`this chat's other branches (${fa.here})`] : [];
  for (const o of others) parts.push(`“${o.title}” (${fa.who.reduce((n, w) => (w.chat === o.id ? n + w.agents : n), 0)})`);
  return (
    <span className="tchip static folder-agents" title={`Working in ${cwd} now: ${parts.join(", ")}. They can change the same files.`}>
      {fa.total === 1 ? "1 other working here" : `${fa.total} others working here`}
    </span>
  );
}

/** In the tree popup's foot: every agent working in the viewed branch's folder, its own too. Shown
 *  from two on: one agent alone shares the folder with nobody. */
export function TreeFolderHint({ chatId }: { chatId: string }) {
  const chats = useStore((s) => s.chats);
  const states = useStore((s) => s.states);
  const runs = useStore((s) => s.runs);
  const cwd = useStore((s) => stateOf(s.states, s.chats[chatId], viewedBranch(s, chatId))?.cwd ?? s.chats[chatId]?.cwd);
  const fa = useMemo(() => folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId, self: null, runs }), [chats, states, cwd, chatId, runs]);
  if (fa.total < 2 || !cwd) return null;
  return (
    <span className="fk-folder-agents" title={cwd}>
      {`${fa.total} agents working in ${folderName(cwd)}${fa.elsewhere > 0 ? `: ${fa.here} in this chat, ${fa.elsewhere} in other chats` : ""}`}
    </span>
  );
}
