// What the chat tree shows and does, for both of its shapes (the dialog of the wide layouts in TreePopup.tsx, the full-height sheet of the phone in
// TreeSheet.tsx): the tree fetched for the chat, the server's tree with the live items laid over it, the rows the filter and the search leave, the marks and
// notes on them, and what opening a row, a menu's item, Stop and a label do. The shapes keep what is theirs: which row is picked (the dialog), which menu is
// open, how a label is typed, and how it all is laid out.
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@aiwb/core/api.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { buildTree, forkLinks, rowActions, rows, tipBranch, withLive, type Entry, type Filter, type ForkLink } from "@aiwb/core/logic/forktree.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { busyBranches, modelNotes, pickedRow, rowMarks, startEntry, type MenuItem as TreeItem } from "@aiwb/core/logic/treepopup.ts";
import { heldReason } from "@aiwb/core/logic/waits.ts";
import { closeTree, forkChat, labelMessage, startMove, viewBranch } from "@aiwb/core/state/actions.ts";
import { loadTree } from "@aiwb/core/state/conn.ts";
import { branchCount, getState, isLegacy, shownBranch, statesOfChat, threadOf, viewedBranch, type State } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { useOffWhy } from "../chat/index.ts";
import { focusComposer, openChat, reportError } from "../shell/nav.ts";

export type Nav = NonNullable<State["treeNav"]>;

/** `picked`: the row the dialog has picked (the sheet has none: null). */
export function useTreeNav(nav: Nav, picked: string | null) {
  const c = useStore((s) => s.chats[nav.chat]);
  const view = useStore((s) => s.trees[nav.chat]);
  const items = useStore((s) => threadOf(s, nav.chat)?.items);
  const shown = useStore((s) => shownBranch(s, nav.chat));
  const move = useStore((s) => s.moves[nav.chat]);
  const states = useStore((s) => statesOfChat(s, nav.chat));
  const waits = useStore((s) => s.waits[nav.chat]);
  // where the chat's composer is: an upload of it holds Branch and edit, and with a move pending what opens another branch
  const on = { branch: useStore((s) => viewedBranch(s, nav.chat)), move: !!move };
  const chats = useStore((s) => s.chats);
  const cat = useStore((s) => { const k = s.chats[nav.chat]; return k ? catalogFor(s, serverOf(k), k.agent) : undefined; });
  const off = useOffWhy(nav.chat); // why the chat takes no call now: its tree is then read only
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0); // counts the fetches asked for again
  const [filter, setFilter] = useState<Filter>("default");
  const [query, setQuery] = useState("");
  const loads = useRef(0); // the newest load, whose answer is the one kept
  const start = useRef<string | null | undefined>(undefined); // the entry the popup opened on, once the tree is there

  // openTree only sets treeNav: the tree is fetched here, each time the popup is opened, again when the tree is dropped under it (a snapshot), and
  // on Retry.
  const none = view === undefined;
  useEffect(() => {
    const n = ++loads.current;
    setLoading(true);
    loadTree(nav.chat).then(
      () => {
        if (loads.current !== n) return;
        // a snapshot took the fetch over and its answer was not kept: the one that runs now is waited for
        if (!getState().trees[nav.chat] && getState().chats[nav.chat]) { setTries((x) => x + 1); return; }
        setLoading(false); setErr("");
      },
      (e) => { if (loads.current === n) { setLoading(false); setErr(e instanceof Error ? e.message : String(e)); } },
    );
  }, [nav, none, tries]);

  // The branches whose turn is running: each gates its own rows only.
  const busy = useMemo(() => busyBranches(states), [states]);
  // The server's tree with the shown branch's live items laid over it; the leaf is the pending move's point, else the end of the branch this client
  // views (not the server's current one).
  const agent = c?.agent;
  const live = busy.has(shown);
  const tree = useMemo(() => {
    if (!view || !agent) return null;
    return buildTree(items ? withLive(view, shown, agent, items, live) : view, move ? { branch: move.branch, count: move.at } : { branch: shown, count: Infinity });
  }, [view, shown, agent, items, live, move]);
  const notes = useMemo(() => (tree ? modelNotes(tree, states, cat) : {}), [tree, states, cat]);
  const links = useMemo(() => (tree ? forkLinks(tree, Object.values(chats), nav.chat) : []), [tree, chats, nav.chat]);
  const list = useMemo(() => (tree ? rows(tree, { filter, query, links }) : []), [tree, filter, query, links]);
  // A branch whose end row the filter or the search hides is marked on its last row shown.
  const marks = useMemo(() => (tree ? rowMarks(tree, states, list) : {}), [tree, states, list]);
  // The branch each end row shows when it is opened, by entry id.
  const ends = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of list) {
      const b = tree && r.isTip ? tipBranch(tree, r.id) : null;
      if (b !== null) out[r.id] = b;
    }
    return out;
  }, [tree, list]);
  if (tree && start.current === undefined) start.current = startEntry(tree, nav.focus);
  const cur = picked ?? start.current ?? null;
  const selId = useMemo(() => (tree ? pickedRow(tree, list, cur) : null), [tree, list, cur]);

  const readOnly = !!c && (!!c.archived || isLegacy(c) || !!off);

  // Opens the chat at an entry: what is sent next branches off there; the end of a branch is just shown. Nothing is opened, and the popup stays, while
  // the chat's message is on its way (the rows say so).
  const noOpen = off || heldReason(waits, "open", on);
  const open = (id: string) => {
    const o = tree && rowActions(tree, id, { busy, readOnly }).open;
    if (!o || noOpen) return;
    if ("view" in o) void viewBranch(nav.chat, o.view).then(focusComposer);
    else if (o.edit !== undefined && heldReason(waits, "branchEdit", on)) return; // a message's row is Branch and edit
    else void startMove(nav.chat, o.target, o.edit);
    closeTree();
  };
  const openFork = (l: ForkLink) => {
    const fork = chats[l.chat];
    if (!fork) return;
    openChat(fork);
    closeTree();
  };
  // Stops a branch's turn, or its subagents when only they run: what the composer's Stop does for the branch shown.
  const stop = (branch: string) => { if (!off) api.interrupt(nav.chat, branch).catch((e) => reportError("Couldn't stop the branch", e)); };
  // A menu item that forks or branches (Label is typed by the shape): what a wait of the chat holds does nothing.
  const perform = (e: Entry, a: Exclude<TreeItem, { id: "label" | "note" }>) => {
    if (off || heldReason(waits, a.id, on)) return;
    if (a.id === "branchEdit") void startMove(nav.chat, { branch: e.branch, at: a.at, new: true }, e.item.i);
    else void forkChat(nav.chat, e.branch, a.at, a.id === "forkEdit" ? e.item.i : undefined);
    closeTree();
  };
  // A label typed: unchanged is nothing, empty removes it.
  const label = (e: Entry, v: string | null) => {
    if (v !== null && v !== (e.label ?? "")) void labelMessage(nav.chat, e.branch, e.item.i, v);
  };

  return {
    c, items, tree, list, links, marks, notes, ends, selId, states, busy, waits, on, chats, off, readOnly, noOpen, branches: c ? branchCount(c) : 0,
    loading, err, retry: () => setTries((x) => x + 1), filter, setFilter, query, setQuery, open, openFork, stop, perform, label,
  };
}
