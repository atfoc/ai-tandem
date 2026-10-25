// What a delete asks on the phone (ux-improvements goal 3.1.4, h2-design.md §3, H2-3): a chat or a board gets the P4 confirm (a red tile, the
// object in quotes, what is lost and where, "Delete chat" / "Delete whiteboard", Cancel); a group keeps its two-choice dialog (move the
// contents up, or delete everything). A delete is never undone, so the sentence points at archive, which never asks.
import { api } from "@aiwb/core/api.ts";
import { groupsOn, getState } from "@aiwb/core/state/store.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";

import { boardBusy, deleteBoardNow, deleteGroup, there } from "../sidebar/actions.ts";
import { confirm } from "../shell/confirm.ts";
import { itemName, type ItemRef } from "./archive.ts";
import { deleteBody } from "./rowsheetmodel.ts";

export function askDelete(item: ItemRef): void {
  const name = itemName(item);
  if (name === undefined) return;
  const s = getState();
  if (item.kind === "group") {
    const g = groupsOn(s, serverOfKey(item.key)).find((x) => x.id === item.key);
    if (g) deleteGroup(g);
    return;
  }
  const title = `Delete “${name}”?`;
  if (item.kind === "chat") {
    confirm({ title, body: deleteBody("chat", there(item.key)), confirmLabel: "Delete chat", actions: [{ label: "Delete", tone: "danger", run: () => api.deleteChat(item.key).then(() => undefined) }] });
    return;
  }
  const b = s.boards[item.key];
  if (!b) return;
  confirm({ title, body: deleteBody("board", there(item.key), boardBusy(b.id)), confirmLabel: "Delete whiteboard", actions: [{ label: "Delete", tone: "danger", run: () => deleteBoardNow(b) }] });
}
