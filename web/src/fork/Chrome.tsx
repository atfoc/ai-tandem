// The marks of a chat's branches around the thread: the sidebar's badge, the header's branch name
// and its line about the other branches, and the banner above the composer.
import { useMemo } from "react";
import "./fork.css";
import "./chrome.css";
import { useStore, branchCount, branchState, shownBranch, statesOfChat, threadOf, viewedBranch } from "../store.ts";
import { BranchIcon } from "../icons.tsx";
import { buildTree, nameOfBranch, withLive, type ChatTree } from "../logic/forktree.ts";
import { threadTree, viewFor } from "../logic/forkmessage.ts";
import { bannerOf, bannerText } from "../logic/branchview.ts";
import { alertsOf, alertText, otherBranches } from "../logic/labels.ts";
import { goBack, openTree, viewBranch } from "./actions.ts";
import type { ChatView } from "../types.ts";

/** How many branches a chat has, on its sidebar row; nothing for a chat that was never split. */
export function BranchBadge({ chat }: { chat: ChatView }) {
  const n = branchCount(chat);
  return n > 1 ? <span className="fk-badge" title={`${n} branches`}><BranchIcon size={10} />{n}</span> : null;
}

/** The name of the branch the chat is on here (the one viewed, whatever the server's current one
 *  is), once it has split; the last child of the header's .chat-head-sub. */
export function BranchCrumb({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const viewed = useStore((s) => viewedBranch(s, chatId));
  const tree = useLiveTree(chatId, viewed);
  if (!c || branchCount(c) < 2 || !tree) return null;
  return <> · <span className="fk-crumb"><BranchIcon /> {nameOfBranch(tree, viewed)}</span></>;
}

/** The chat's tree as the thread's messages read it (the shown branch's own part is its live
 *  items, once the list is there); undefined until the tree has the branch asked for. */
function useLiveTree(chatId: string, branch: string): ChatTree | undefined {
  const agent = useStore((s) => s.chats[chatId]?.agent);
  const shown = useStore((s) => shownBranch(s, chatId));
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const view = useStore((s) => viewFor(s.trees[chatId], branch));
  if (!view || !agent) return undefined;
  return items && viewFor(view, shown) ? threadTree(view, shown, agent, items) : buildTree(view);
}

/** What the other branches of the chat need or do, in the chat's header: a branch that is not
 *  the one the chat is on waits for approval, or else one whose turn could not start or ended in
 *  an error (the button puts the chat on it) and, quietly, how many others work (the button opens
 *  the tree). Nothing when there is nothing to tell. */
export function BranchAlert({ chatId }: { chatId: string }) {
  const viewed = useStore((s) => viewedBranch(s, chatId));
  const states = useStore((s) => statesOfChat(s, chatId));
  const o = useMemo(() => otherBranches(states, viewed), [states, viewed]);
  const tree = useLiveTree(chatId, o.asks ?? o.failed ?? viewed);
  const name = (b: string) => (tree ? nameOfBranch(tree, b) : "another branch");
  return (
    <>
      {alertsOf(o).map((kind) => {
        const to = kind === "asks" ? o.asks : kind === "failed" ? o.failed : null;
        return to !== null
          ? <button key={kind} className={`fk-alert ${kind}`} title="Show that branch" onClick={() => void viewBranch(chatId, to)}>{alertText(o, kind, name)}</button>
          : <button key={kind} className="fk-alert quiet" title="Show the chat's tree" onClick={() => openTree(chatId)}>{alertText(o, kind, name)}</button>;
      })}
    </>
  );
}

/** The pending move, above the composer's box: where the next message goes, and Back. The branch
 *  the chat is on stays as it is: the Send stops nothing. Back does nothing while the move's own
 *  Send is in flight. When the branch the chat is on (the one Back returns to) waits for approval,
 *  its card is not in the thread shown for the move, whichever branch the move's point is on: the
 *  banner says so (for a branch the chat is not on the header does). */
export function BranchBanner({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const move = useStore((s) => s.moves[chatId]);
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const tree = useStore((s) => s.trees[chatId]);
  const asks = useStore((s) => { const m = s.moves[chatId]; return !!m && branchState(s, chatId, m.from)?.status === "approval"; });
  const text = useMemo(() => {
    const view = move && viewFor(viewFor(tree, move.branch), move.from);
    if (!c || !move || !items || !view) return "Your next message starts from here.";
    const t = buildTree(withLive(view, move.branch, c.agent, items), { branch: move.branch, count: move.at });
    return bannerText(bannerOf(t, move, items, move.from, asks));
  }, [c?.agent, asks, move, items, tree]);
  if (!c || !move) return null;
  return (
    <div className="fk-banner">
      <BranchIcon size={12} />
      <span className="fk-banner-text">{text}</span>
      <button className="btn ghost sm" onClick={() => goBack(chatId)} title="Go back to where you were">Back</button>
    </div>
  );
}
