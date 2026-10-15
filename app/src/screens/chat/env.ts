// What the Markdown of a message needs from the app around it (screens/markdown/env.tsx): a press on a reference chip shows that
// reference on the chat's board, a hook gives the boards of the text's own server, and a press on a mention opens that board.
import { boardsOn } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import type { MarkdownEnv } from "../markdown/env.tsx";
import { boardApp } from "../shell/boardside.ts";
import { openBoard } from "../shell/nav.ts";

export const chatMarkdownEnv: MarkdownEnv = {
  showRef: (board, ref, agent) => boardApp.showRef(board, ref, agent),
  useBoards: (server) => useStore((s) => boardsOn(s, server)), // a board of the text's own server, never one of that name elsewhere
  openBoard: (id) => openBoard(id),
};
