// The marks of a chat's branches around the thread: the sidebar's badge, the header's branch name
// and the banner above the composer.
import { useMemo } from "react";
import "./fork.css";
import "./chrome.css";
import { useStore, branchCount, currentBranch, shownBranch, isBusy } from "../store.ts";
import { BranchIcon } from "../icons.tsx";
import { buildTree, nameOfBranch, withLive } from "../logic/forktree.ts";
import { threadTree, viewFor } from "../logic/forkmessage.ts";
import { bannerOf, bannerText } from "../logic/branchview.ts";
import { goBack } from "./actions.ts";
import type { ChatView } from "../types.ts";

/** How many branches a chat has, on its sidebar row; nothing for a chat that was never split. */
export function BranchBadge({ chat }: { chat: ChatView }) {
  const n = branchCount(chat);
  return n > 1 ? <span className="fk-badge" title={`${n} branches`}><BranchIcon size={10} />{n}</span> : null;
}

/** The name of the branch the chat is on, once it has split; the last child of the header's .chat-head-sub. */
export function BranchCrumb({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const shown = useStore((s) => shownBranch(s, chatId));
  const items = useStore((s) => s.items[chatId]?.items);
  const view = useStore((s) => viewFor(s.trees[chatId], currentBranch(s.chats[chatId])));
  if (!c || branchCount(c) < 2 || !view) return null;
  // The tree the thread's messages read (the shown branch's own part is its live items), once the list is there.
  const tree = items ? threadTree(view, shown, c.agent, items) : buildTree(view);
  return <> · <span className="fk-crumb"><BranchIcon /> {nameOfBranch(tree, currentBranch(c))}</span></>;
}

/** The pending move, above the composer's box: where the next message goes, and Back. */
export function BranchBanner({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const move = useStore((s) => s.moves[chatId]);
  const items = useStore((s) => s.items[chatId]?.items);
  const tree = useStore((s) => s.trees[chatId]);
  const current = currentBranch(c);
  const text = useMemo(() => {
    const view = move && viewFor(viewFor(tree, move.branch), current);
    if (!c || !move || !items || !view) return "Your next message starts from here.";
    const t = buildTree(withLive(view, move.branch, c.agent, items), { branch: move.branch, count: move.at });
    return bannerText(bannerOf(t, move, items, current));
  }, [c?.agent, move, items, tree, current]);
  if (!c || !move) return null;
  return (
    <div className="fk-banner">
      <BranchIcon size={12} />
      <span className="fk-banner-text">{text}</span>
      {!isBusy(c.status) && <button className="btn ghost sm" onClick={() => goBack(chatId)} title="Go back to where you were">Back</button>}
    </div>
  );
}
