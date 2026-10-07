// What forking adds to the chat's own thread: a message's actions, label and branch marker, and
// the note at the top of a forked chat.
//
// The message's extras are drawn inside the message element, after its .md, so the thread's
// entries stay its direct children (⌘L, quoteDom.ts). Their texts are drawn by CSS from
// data-text, not as text nodes: quoteDom reads a message's text nodes to tell which messages a
// selection takes text from, and the extras must never count.
import { useRef, useState } from "react";
import "./fork.css";
import "./message.css";
import { useStore, isBusy, isLegacy, shownBranch, threadOf } from "../store.ts";
import { openChat } from "../Sidebar.tsx";
import { BranchIcon } from "../icons.tsx";
import { messageActions } from "../logic/forkpoints.ts";
import { labelAt, markerAt } from "../logic/forktree.ts";
import { messageButtons, threadTree, viewFor, type MessageButton } from "../logic/forkmessage.ts";
import { forkChat, labelMessage, openTree, startMove } from "./actions.ts";
import { LabelInput } from "./LabelInput.tsx";
import type { ChatView, Item } from "../types.ts";

const EMPTY: Item[] = [];

/** A message's fork actions and label; the last child of the chat's own .msg.user and .msg.assistant. */
export function MessageExtras({ chat, index, item }: { chat: ChatView; index: number; item: Item }) {
  // The shown branch's full list, even while the thread is shown cut for a pending move.
  const items = useStore((s) => threadOf(s, chat.id)?.items) ?? EMPTY;
  const shown = useStore((s) => shownBranch(s, chat.id));
  const view = useStore((s) => viewFor(s.trees[chat.id], shownBranch(s, chat.id)));
  const [labeling, setLabeling] = useState(false);
  const running = useRef(false); // a fork or a move was asked for and has not answered yet

  // chat is the view of the branch shown (shownView): its status is that branch's, not the chat's.
  // (a chat with no agent has no message: the kind given for it is never read)
  const acts = messageActions({ agent: chat.agent || "claude", items, index, busy: isBusy(chat.status), readOnly: !!chat.archived || isLegacy(chat) });
  const label = labelAt(view, shown, index);
  const marker = view && chat.agent ? markerAt(threadTree(view, shown, chat.agent, items), shown, index) : null;
  const buttons = messageButtons(acts, items, !!label);
  if (!marker && !label && !buttons.length && !labeling) return null;

  const once = (p: Promise<void>) => { running.current = true; void p.finally(() => { running.current = false; }); };
  const run = (b: MessageButton) => {
    if (b.id === "label") return setLabeling(true);
    if (running.current || b.at === undefined) return;
    switch (b.id) {
      case "branchEdit": return once(startMove(chat.id, { branch: shown, at: b.at, new: true }, index));
      case "branch": return once(startMove(chat.id, { branch: shown, at: b.at, new: true }));
      case "forkEdit": return once(forkChat(chat.id, shown, b.at, index));
      case "fork": return once(forkChat(chat.id, shown, b.at));
    }
  };
  return (
    <>
      {marker && (
        <button className="fk-marker" title="Open the chat tree here" aria-label={`Branch ${marker.n} of ${marker.m}`}
          onClick={() => openTree(chat.id, { branch: shown, item: index })}>
          <span className="fk-marker-line" />
          <span className="fk-marker-chip" data-text={`Branch ${marker.n} of ${marker.m}`}><BranchIcon /></span>
          <span className="fk-marker-line" />
        </button>
      )}
      {label && <div className="fk-label-tag" title="Label" data-text={label} />}
      {buttons.length > 0 && !labeling && (
        <div className="fk-acts">
          {buttons.map((b) => (
            <button key={b.id} className={`fk-act k-${b.id}`} title={b.title} aria-label={b.text} data-text={b.text} onClick={() => run(b)}>
              {(b.id === "branchEdit" || b.id === "branch") && <BranchIcon />}
            </button>
          ))}
        </div>
      )}
      {labeling && (
        <div className="fk-label-float">
          <LabelInput initial={label ?? ""} onDone={(v) => { if (v !== null && v !== (label ?? "")) void labelMessage(chat.id, shown, index, v); setLabeling(false); }} />
        </div>
      )}
    </>
  );
}

/** The note that the chat was forked from another; the first child of .thread. */
export function ForkedFrom({ chat }: { chat: ChatView }) {
  const src = useStore((s) => (chat.forkedFrom ? s.chats[chat.forkedFrom] : undefined));
  if (!chat.forkedFrom) return null;
  const title = chat.forkedFromTitle || "another chat";
  return (
    <div className="fk-forked">
      <BranchIcon /> Forked from{" "}
      {src ? <button className="link" onClick={() => openChat(src)}>{title}</button> : <b>{title}</b>}.
      The history below was copied; this chat has its own agent session.
    </div>
  );
}
