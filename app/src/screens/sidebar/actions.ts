// What the sidebar does, with no screen in it (the old page's Sidebar.tsx, the part between the selection helpers and the component): the
// calls its menus make, the questions before a delete, a group shown moved or renamed before its server has answered, and the
// moves a drag ends in. The selection helpers themselves (select, openBoard, openChat, newChat, newBoard, addBoard) are the shell's
// (`screens/shell/nav.ts`).
import { api } from "@aiwb/core/api.ts";
import { dropMark, type DropEvent } from "@aiwb/core/logic/dropmark.ts";
import { deleteAsk } from "@aiwb/core/logic/remoteview.ts";
import { boardDeleteBody } from "@aiwb/core/logic/boardrow.ts";
import { inSection, isUngrouped, sameServer, serverOfKey, ungroupedOn } from "@aiwb/core/logic/keys.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { putBack, shownAhead, type Ahead } from "@aiwb/core/logic/sections.ts";
import { workingBranches, workingOn } from "@aiwb/core/logic/status.ts";
import { subtree } from "@aiwb/core/logic/tree.ts";
import { chatTitle, getState, groupsOn, setSectionCollapsed, setSectionGroups, setState, statesOfChat, threadOf, upsertBoard, viewedBranch } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER, type Board, type ChatView, type Group } from "@aiwb/core/types.ts";

import { showToast } from "../../ui/toaststore.ts";
import { attempt, confirm, reportError } from "../shell/confirm.ts";
import { boardApp } from "../shell/boardside.ts";

// ---------------------------------------------------------------- groups shown ahead of their server

const ahead = new Map<string, Ahead>(); // by entry id: the change of a section's groups the page shows before that server answered (logic/sections.ts)

/** Sets the groups of one server as the page shows them, until that server's `groups` event says the same. A change
 *  of a section's groups is noted, so that a call that fails can put back what that server has (groupsBack). */
function setGroups(server: string, change: (groups: Group[]) => Group[]): void {
  if (server === LOCAL_SERVER) { setState((s) => ({ groups: change(s.groups) })); return; }
  const had = getState().sections[server]?.groups;
  if (!had) return;
  const a = shownAhead(had, ahead.get(server), change);
  ahead.set(server, a);
  setSectionGroups(server, a.shown);
}

/** The call of a change of a section's groups that the page showed at once (a rename, a move) was refused, or got no
 *  answer: the section shows again what its server told last. No event would say so: nothing changed there. When
 *  that server told its groups meanwhile, its word stands (logic/sections.ts putBack). */
function groupsBack(server: string): void {
  const back = putBack(getState().sections[server]?.groups, ahead.get(server));
  ahead.delete(server);
  if (back) setSectionGroups(server, back);
}

/** A call that makes on its server a change of a group the page shows already; a section's is put back when it fails. */
const shownCall = (group: string, call: () => Promise<unknown>): Promise<unknown> =>
  call().catch((e) => { if (inSection(group)) groupsBack(serverOfKey(group)); throw e; });

/** Whether a group shows collapsed: the collapse of every group is this app's own, and is neither read from its server's tree
 *  nor sent to it. */
export const isCollapsed = (s: { collapsed: Record<string, true> }, g: Group): boolean => !!s.collapsed[g.id];

export const setCollapsed = setSectionCollapsed;

/** Returns the new group's key; the header opens in rename mode (the caller's). server: the entry id of the server it is made on
 *  (this computer: LOCAL_SERVER). A subgroup's parent opens to show it, and so does a collapsed section. */
export async function newGroup(server: string = LOCAL_SERVER, parent = ""): Promise<string> {
  const g = await api.newGroup(server, undefined, parent || undefined);
  // (the group is there: the call's answer is its server's word, and no change shown ahead of it)
  const add = (groups: Group[]) => (groups.some((x) => x.id === g.id) ? groups : [...groups, g]);
  if (server === LOCAL_SERVER) setGroups(server, add); else if (getState().sections[server]) setSectionGroups(server, add(getState().sections[server].groups));
  const s = getState(), p = parent ? groupsOn(s, server).find((x) => x.id === parent) : undefined;
  if (p && isCollapsed(s, p)) setCollapsed(p.id, false);
  if (server !== LOCAL_SERVER && s.collapsed[server]) setSectionCollapsed(server, false);
  return g.id;
}

// ---------------------------------------------------------------- menus

/** The name of a thing's server for a dialog: "" for a thing of this computer, which names none. */
export const there = (key: string): string => (inSection(key) ? serverName(getState(), serverOfKey(key)) : "");

const busyChats = (board: string) => workingOn(Object.values(getState().chats), board, (chat) => statesOfChat(getState(), chat)); // a branch busy, or waiting on running subagents

/** Stops every working branch of each chat; the branch shown when its records name none. */
const stopAll = async (chats: ChatView[]) => {
  const stops = chats.flatMap((c) => {
    const working = workingBranches(statesOfChat(getState(), c.id)).map((st) => st.branch);
    const branches = working.length ? working : [viewedBranch(getState(), c.id)];
    return branches.map((branch) => api.interrupt(c.id, branch).catch(() => {}));
  });
  await Promise.all(stops);
};

/** onDone: called once the board is archived (the phone's toast with Undo); the wide callers pass none. */
export function archiveBoard(b: Board, onDone?: () => void): void {
  const run = async () => { await boardApp.flush(b.id); await api.archive("boards", b.id); onDone?.(); };
  const busy = busyChats(b.id);
  if (!busy.length) return attempt("Couldn't archive the board", run);
  confirm({
    title: "An agent is working on this board. Stop it and archive?",
    actions: [{ label: "Stop and archive", tone: "primary", run: async () => { await stopAll(busy); await run(); } }],
  });
}

/** Whether an agent works on the board (a branch busy, or waiting on running subagents). */
export const boardBusy = (board: string): boolean => busyChats(board).length > 0;

/** Deletes a board on its server: stops the chats working on it, saves it, deletes it. No question: the caller asked. */
export async function deleteBoardNow(b: Board): Promise<void> {
  await stopAll(busyChats(b.id));
  await boardApp.flush(b.id);
  await api.deleteBoard(b.id);
}

/** A board of a section is deleted on its server, for everyone who uses it. A refusal is shown with the server's sentence, and
 *  nothing was deleted. */
export function deleteBoard(b: Board): void {
  const busy = busyChats(b.id);
  confirm({
    title: `Delete ${b.name}?`,
    body: boardDeleteBody(busy.length > 0, there(b.id)),
    actions: [{ label: "Delete", tone: "danger", run: () => deleteBoardNow(b) }],
  });
}

/** A chat of a section is deleted on its server, for everyone who uses it. */
export function deleteChat(c: ChatView): void {
  const ask = deleteAsk(chatTitle(c, threadOf(getState(), c.id)?.items), there(c.id));
  confirm({ title: ask.title, body: ask.body, confirmLabel: "Delete chat", actions: [{ label: "Delete", tone: "danger", run: () => api.deleteChat(c.id) }] });
}

/** The groups of the server a group is on. */
export const groupsOf = (group: string): Group[] => groupsOn(getState(), serverOfKey(group));

/** onDone: called once the group is archived (the phone's toast with Undo); the wide callers pass none. */
export function archiveGroup(g: Group, onDone?: () => void): void {
  attempt("Couldn't archive the group", async () => {
    const s = getState();
    const inside = subtree(groupsOf(g.id), g.id);
    await Promise.all(Object.values(s.boards).filter((b) => inside.has(b.group)).map((b) => boardApp.flush(b.id)));
    await api.archive("groups", g.id);
    onDone?.();
  });
}

/** Keeping the contents moves them, and the subgroups, up to the parent (ungrouped at the top level). A group of a section is
 *  deleted on its server, with the rules of a local one: for everyone who uses it. */
export function deleteGroup(g: Group): void {
  const parent = g.parent && groupsOf(g.id).find((x) => x.id === g.parent);
  const on = there(g.id);
  confirm({
    title: `Delete ${g.name}?`,
    body: on ? `The group is on ${on}: it is deleted there, for everyone who uses that server.` : undefined,
    actions: [
      { label: `Move contents to ${parent ? parent.name : "ungrouped"}`, run: () => api.deleteGroup(g.id, "keep") },
      { label: "Delete everything in it", tone: "danger", run: () => api.deleteGroup(g.id, "delete") },
    ],
  });
}

/** Renames a chat on its server; the same name, or none, asks nothing. The name shows when the chat's server tells it (a `chat`
 *  event): nothing is shown ahead. A section's server that refuses the rename, or does not answer, is said: no event would. */
export function renameChat(chat: ChatView, name: string, title = chatTitle(chat)): void {
  if (!name || name === title) return;
  void api.renameChat(chat.id, name).catch((e) => { console.error(e); if (inSection(chat.id)) reportError("Couldn't rename the chat", e); });
}

// ---------------------------------------------------------------- moves (the menus' "Move to…" and a drag's end)

/** Moves a board or a plain chat into a group of its own server. Nothing is moved from one section to another, or between this
 *  computer's section and another: for such a pair no call is made. key: "board:<key>" or "chat:<key>". */
export function moveTo(key: string, group: string): void {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (!sameServer(id, group)) return;
  const s = getState();
  if (kind === "board" && s.boards[id] && s.boards[id].group !== group) attempt("Couldn't move the board", () => api.moveBoard(id, group));
  if (kind === "chat" && s.chats[id] && !s.chats[id].board && (s.chats[id].group || ungroupedOn(serverOfKey(id))) !== group) attempt("Couldn't move the chat", () => api.moveChat(id, group));
}

/** Tells the sidebar's one drop mark what a drag did (logic/dropmark.ts): the zone or the header that is lit, the group being
 *  dragged, so drop targets can refuse the group itself and its subgroups, and the server what is dragged is on, so that no zone
 *  of another server takes it. */
export const markDrop = (e: DropEvent): void => setState((s) => ({ dropAt: dropMark(s.dropAt, e) }));

/** Whether the dragged group may go into (or before) target: only a group of the target's own server, not into an archived group,
 *  nor into itself. */
export function canTakeGroup(target: string, into: boolean): boolean {
  const { dropAt: { group: dragged } } = getState();
  if (!dragged || !sameServer(dragged, target)) return false;
  if (into && isUngrouped(target)) return true;
  const groups = groupsOf(target);
  if (into && groups.find((g) => g.id === target)?.archived) return false;
  return !subtree(groups, dragged).has(target);
}

/** Nests a group in parent ("" = top level), before group before ("" = last among all groups). The three are of one server: a
 *  group is never moved to another. The move shows at once; a section's is put back when its server refuses it or does not answer. */
export function moveGroup(dragged: string, parent: string, before = ""): void {
  if ((parent && !sameServer(dragged, parent)) || (before && !sameServer(dragged, before))) return;
  const groups = groupsOf(dragged);
  const moving = groups.find((g) => g.id === dragged);
  if (!moving || dragged === before || (!before && (moving.parent ?? "") === parent)) return;
  const rest = groups.filter((g) => g.id !== dragged);
  const at = before ? rest.findIndex((g) => g.id === before) : -1;
  const moved = { ...moving, parent: parent || undefined };
  setGroups(serverOfKey(dragged), () => (at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)]));
  attempt("Couldn't move the group", () => shownCall(dragged, () => api.moveGroup(dragged, parent, before)));
}

/** Renames a group. The name shows at once; a section's is put back when its server refuses it or does not answer. */
export function renameGroup(g: Group, name: string): void {
  if (!name || name === g.name) return;
  setGroups(serverOfKey(g.id), (list) => list.map((x) => (x.id === g.id ? { ...x, name } : x)));
  attempt("Couldn't rename the group", () => shownCall(g.id, () => api.renameGroup(g.id, name)));
}

// ---------------------------------------------------------------- Chat info's archive (the phone)

/** Archives a chat on its server and says so with a toast whose Undo puts it back: archiving asks no question (goal 3.1.3). */
export function archiveChat(c: ChatView): void {
  attempt("Couldn't archive the chat", async () => {
    await api.archive("chats", c.id);
    showToast({ text: "Chat archived", kind: "archived", action: { label: "Undo", run: () => unarchiveChat(c) } });
  });
}

export function unarchiveChat(c: ChatView): void {
  attempt("Couldn't unarchive the chat", () => api.unarchive("chats", c.id));
}

/** Renames a board on its server and waits for it: the board's own file is flushed first, the answer is the board as its server has it. A
 *  refusal is thrown (the Rename sheet shows it). The board row's inline rename (rows.tsx) does the same with its own error line. */
export async function renameBoard(b: Board, name: string): Promise<void> {
  await boardApp.flush(b.id);
  upsertBoard(await api.renameBoard(b.id, name));
}
