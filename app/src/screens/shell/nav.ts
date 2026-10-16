// What is on screen, and the ways to change it: the selection helpers every part of the app opens boards and chats through
// (the old page's Sidebar.tsx's first part, and the sidebar's hide control), the Ui seam of @aiwb/core (ports.ts `Ui`), and the
// confirm and error dialogs' requests. They set the store (AD-71: navigation follows the store; a back sets it, never the
// other way round).
import { Dimensions } from "react-native";

import { api, type ChatPlace } from "@aiwb/core/api.ts";
import { sideSaved } from "@aiwb/core/logic/layout.ts";
import { selOf } from "@aiwb/core/logic/sel.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";
import { boardChats } from "@aiwb/core/logic/tree.ts";
import { dropLeft, loadItems, loadTree } from "@aiwb/core/state/conn.ts";
import type { Ui } from "@aiwb/core/state/ports.ts";
import { getState, lastChat, safeSet, setState, shownBranch, upsertBoard, upsertChat, type ConfirmRequest, type Sel } from "@aiwb/core/state/store.ts";
import { attempt, confirm, reportError } from "./confirm.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { focusIn, focusTid } from "../../platform/focus";
import { layoutOf } from "../../ui/breakpoints.ts";
import { boardApp } from "./boardside.ts";

const CREATE_FAILED = "Couldn't create the whiteboard";
const CHAT_FAILED = "Couldn't start the chat";

/** The testIDs of the two controls that hide and show the sidebar, and of the two parts they belong to. */
export const SIDE_IDS = { pane: "side-pane", rail: "side-rail", show: "side-show", hide: "side-hide" } as const;

// ---------------------------------------------------------------- the composer's focus (K3 registers it)

let focusBox: () => void = () => {};

/** The composer registers what puts the caret in its text box (a moment later, not under a popup of the prompt library). */
export function setFocusComposer(f: () => void): void { focusBox = f; }

export function focusComposer(): void { focusBox(); }

// ---------------------------------------------------------------- dialogs

export { attempt, confirm, reportError };

// ---------------------------------------------------------------- selection

/** Selects a board, with one of its chats in the panel, or a plain chat alone. Selecting never takes a board: the canvas shows it in
 *  view mode (the bar over it offers "Edit here"), and a window becomes its writer only when the user presses that button (or
 *  has made the board: newBoard).
 *  What was on screen of a section whose server is not connected, or that is no longer on its server, was kept only for being on
 *  screen: left, it goes, and cannot be opened again until that server is back (conn.ts dropLeft). */
export function select(sel: Sel): void {
  const prev = getState().sel;
  if (prev.board && prev.board !== sel.board) void boardApp.flush(prev.board); // closing a board writes it
  setState({ sel }); safeSet("aiwb.sel", JSON.stringify(sel));
  if (sel.chat !== prev.chat) setState({ subDrawer: null });
  if (sel.board && getState().boards[sel.board]?.new && reachable(getState(), sel.board)) void api.seenBoard(sel.board).catch(() => {});
  if (sel.board && sel.chat) lastChat.set(sel.board, sel.chat);
  dropLeft();
  if (sel.chat) {
    setState({ panel: true });
    if (reachable(getState(), sel.chat)) {
      void api.openChat(sel.chat, shownBranch(getState(), sel.chat)).catch(() => {});
      void loadItems(sel.chat);
      void loadTree(sel.chat).catch(() => {});
    }
    focusComposer();
  }
}

/** Opens a board with the last chat opened on it if it still exists, else its newest chat, else none. On the phone a board opens alone, with the canvas on screen (the stack's chat screen
 *  would hide it): its chat is one press away on the bar ("Chats N"); `withChat` says otherwise. */
export function openBoard(id: string, withChat = layoutOf(Dimensions.get("window").width) !== "phone"): void {
  const s = getState();
  const last = lastChat.get(id);
  const lc = last && s.chats[last]?.board === id && (s.showArchived || !s.chats[last].archived) ? last : null;
  select({ board: id, chat: withChat ? lc ?? boardChats(s.chats, id, s.showArchived)[0]?.id ?? null : null });
}

/** A board chat opens on its board; a plain chat opens alone. */
export function openChat(c: ChatView): void {
  select(selOf(c));
}

/** "New chat": made at once where it was asked for, in a group or on a board. That place decides the server the chat lives on,
 *  this computer or the section's: nothing asks, and nothing moves it later. A refusal is shown with the server's sentence, and
 *  nothing was made. */
export async function newChat(where: ChatPlace): Promise<void> {
  try {
    const c = await api.newChat(where);
    upsertChat(c);
    openChat(c);
  } catch (e) { reportError(CHAT_FAILED, e); }
}

/** Returns the new board's key. The board is made on the server its group is on, and this window takes it at once: making a board
 *  is the person's own act, and a new empty board opened view-only would ask for a second press (D12). */
export async function newBoard(group: string): Promise<string> {
  const b = await api.newBoard(group);
  upsertBoard(b);
  select({ board: b.id, chat: null });
  void boardApp.takeBoard(b.id);
  return b.id;
}

let editRow: (key: string | null) => void = () => {}; // puts a row of the sidebar in rename mode (the sidebar sets it while it is mounted)

/** The sidebar registers what puts one of its rows in rename mode (`board:<key>`, `chat:<key>`, `group:<key>`); nothing while it is not mounted. */
export function setEditRow(f: (key: string | null) => void): void { editRow = f; }

/** "New whiteboard": the board is made at once in its group, its row in rename mode. */
export function addBoard(group: string): void {
  attempt(CREATE_FAILED, async () => editRow("board:" + await newBoard(group)));
}

// ---------------------------------------------------------------- the sidebar's hiding

/** Hides the sidebar or shows it: ⌘B, the control in its head, and the control of the rail a hidden one leaves. Only its pane is
 *  not drawn: the sidebar stays mounted. The choice is saved ("aiwb.side"). A focus in the part that goes away moves to the
 *  control that undoes this, the rail's after a hiding and the head's after a showing; focus: it goes there wherever it was (the
 *  press on one of the two controls). */
export function setSideHidden(hidden: boolean, focus = false): void {
  if (getState().sideHidden === hidden) return;
  const leaves = focusIn(hidden ? SIDE_IDS.pane : SIDE_IDS.rail);
  setState({ sideHidden: hidden }); safeSet("aiwb.side", sideSaved(hidden));
  // (once the page is drawn anew: the control is not there before, and what the sidebar had open has ended)
  if (focus || leaves) setTimeout(() => focusTid(hidden ? SIDE_IDS.show : SIDE_IDS.hide));
}

/** The Ui of @aiwb/core (ports.ts) as this app has it. */
export const appUi: Ui = { openChat, select, focusComposer, reportError, confirm };
