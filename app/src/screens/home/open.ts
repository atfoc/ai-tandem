// What a press on a row of Home opens (package H1): a group is browsed into (the stack pushes its screen), a board and a chat are opened.
// The row hands its item over; the chat is read from the store at the press, so the press opens what is there now.
import { getState } from "@aiwb/core/state/store.ts";

import { pushGroup } from "../shell/homeplace.ts";
import { openBoard, openChat } from "../shell/nav.ts";
import type { RowItem } from "./model.ts";

export function openItem(item: Pick<RowItem, "kind" | "key">): void {
  if (item.kind === "group") pushGroup(item.key);
  else if (item.kind === "board") openBoard(item.key);
  else {
    const c = getState().chats[item.key];
    if (c) openChat(c);
  }
}
