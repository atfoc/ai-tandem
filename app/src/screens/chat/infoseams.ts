// The two places Chat info hands over to that other packages own. Each is one function, so the package that builds the screen replaces it
// here and nothing else changes. Chat info closes first: one sheet at a time (goal 3.1.4).
import type { ChatView } from "@aiwb/core/types.ts";

import { openServerDetail } from "../home/serverseam.ts";
import { openRename } from "../home/RenameSheet.tsx";
import { closeChatInfo } from "./chatinfo.ts";

/** The Name row's Rename: H2's one Rename sheet (goal 3.3: the same sheet from a row, from Chat info and for a board). */
export function renameFromInfo(chat: ChatView): void {
  closeChatInfo();
  openRename({ kind: "chat", key: chat.id });
}

/** The Server row. Owner: S2's `openServer(id)` (screens/servers/open.ts). Until it is merged the server's detail: S2's screen when it is
 *  registered, else the Servers dialog. entryId: the server's entry id (`LOCAL_SERVER` for this computer). */
export function serverFromInfo(entryId: string): void {
  closeChatInfo();
  openServerDetail(entryId);
}
