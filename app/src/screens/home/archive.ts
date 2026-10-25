// Archive and unarchive with their toast and Undo (ux-improvements goal 3.1.3, h2-design.md §3, H2-8): an archive is never asked about
// (a board an agent works on is: archiveBoard says so first) and always undoable. The toast waits for the call to be done.
import { api } from "@aiwb/core/api.ts";
import { chatTitle, getState, groupsOn, threadOf } from "@aiwb/core/state/store.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";

import { showToast } from "../../ui/Toast.tsx";
import { attempt } from "../shell/confirm.ts";
import { archiveBoard, archiveGroup } from "../sidebar/actions.ts";
import type { RowKind } from "./model.ts";

export type ItemRef = { kind: RowKind; key: string };

const NOUN: Record<RowKind, string> = { chat: "chat", board: "board", group: "group" };
const KIND_OF: Record<RowKind, "chats" | "boards" | "groups"> = { chat: "chats", board: "boards", group: "groups" };

/** The name a row shows, read from the store now; undefined when the item is gone. */
export function itemName({ kind, key }: ItemRef): string | undefined {
  const s = getState();
  if (kind === "chat") { const c = s.chats[key]; return c ? chatTitle(c, threadOf(s, key)?.items) : undefined; }
  if (kind === "board") return s.boards[key]?.name;
  return groupsOn(s, serverOfKey(key)).find((g) => g.id === key)?.name;
}

/** Archives a chat, a board or a group; shows "Archived “X”" with Undo when it is done. */
export function archiveItem(item: ItemRef): void {
  const name = itemName(item);
  if (name === undefined) return;
  const done = () => showToast({ text: `Archived “${name}”`, kind: "archived", action: { label: "Undo", run: () => unarchiveCall(item, `Couldn't undo the archive`) } });
  const s = getState();
  if (item.kind === "board") { const b = s.boards[item.key]; if (b) archiveBoard(b, done); return; }
  if (item.kind === "group") { const g = groupsOn(s, serverOfKey(item.key)).find((x) => x.id === item.key); if (g) archiveGroup(g, done); return; }
  attempt(`Couldn't archive the chat`, async () => { await api.archive("chats", item.key); done(); });
}

/** Brings an archived item back (Archived's right swipe); shows "Unarchived “X”" with Undo, which archives it again. */
export function unarchiveItem(item: ItemRef): void {
  const name = itemName(item);
  if (name === undefined) return;
  attempt(`Couldn't unarchive the ${NOUN[item.kind]}`, async () => {
    await api.unarchive(KIND_OF[item.kind], item.key);
    showToast({ text: `Unarchived “${name}”`, kind: "unarchived", action: { label: "Undo", run: () => archiveItem(item) } });
  });
}

const unarchiveCall = (item: ItemRef, title: string): void => attempt(title, () => api.unarchive(KIND_OF[item.kind], item.key));
