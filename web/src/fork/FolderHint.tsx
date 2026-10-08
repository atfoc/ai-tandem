// The "agents working in this folder" hint: the line in the tree popup's foot. It reads every
// branch's record, so it is a component of its own: only it renders again when some branch of
// some chat changes its state.
import { useMemo } from "react";
import "./folderhint.css";
import { useStore, viewedBranch, type State } from "../store.ts";
import { branchKey, currentBranch, stateFromView, stateOf } from "../logic/branches.ts";
import { folderAgents, folderName } from "../logic/folderagents.ts";
import type { BranchState, ChatView } from "../types.ts";

/** Every branch's record: the ones kept, and for a chat whose current branch has none (a server
 *  that sends no records) the view's own. */
function allStates(chats: Record<string, ChatView>, states: State["states"]): BranchState[] {
  const all = Object.values(states);
  for (const c of Object.values(chats)) if (!states[branchKey(c.id, currentBranch(c))]) all.push(stateFromView(c));
  return all;
}

/** In the tree popup's foot: every agent working in the viewed branch's folder, its own too. Shown
 *  from two on: one agent alone shares the folder with nobody. */
export function TreeFolderHint({ chatId }: { chatId: string }) {
  const chats = useStore((s) => s.chats);
  const states = useStore((s) => s.states);
  const runs = useStore((s) => s.runs);
  const cwd = useStore((s) => stateOf(s.states, s.chats[chatId], viewedBranch(s, chatId))?.cwd ?? s.chats[chatId]?.cwd);
  const fa = useMemo(() => folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId, runs }), [chats, states, cwd, chatId, runs]);
  if (fa.total < 2 || !cwd) return null;
  return (
    <span className="fk-folder-agents" title={cwd}>
      {`${fa.total} agents working in ${folderName(cwd)}${fa.elsewhere > 0 ? `: ${fa.here} in this chat, ${fa.elsewhere} in other chats` : ""}`}
    </span>
  );
}
