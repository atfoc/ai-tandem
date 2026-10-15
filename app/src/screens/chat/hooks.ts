// What the chat view reads from the store that more than one part of it needs (the old page's ChatChoices.tsx's useWhere and useOffWhy,
// Composer.tsx's tildify, ChatView.tsx's usePrefixEnd). The composer (K3) and the fork parts (S8) use them from here.
import { getState, shownBranch } from "@aiwb/core/state/store.ts";
import { prefixEnd } from "@aiwb/core/logic/prefix.ts";
import { offWhy, tildeBy, type Where } from "@aiwb/core/logic/chatserver.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";
import { listsOf, serverConnected, serverName, serverOf } from "@aiwb/core/logic/serverlists.ts";

import { useStore } from "../../state/useStore.ts";

/** A thing's server as its views read it (logic/chatserver.ts): of a chat or a board, whose key names the server it is on, or of a
 *  server named by its entry id (`server`). connected: that server takes a call now, which for a section is while the app holds
 *  its tree. */
export function useWhere(of?: { id?: string } | { server: string } | null): Where {
  const server = of && "server" in of ? of.server : serverOf(of);
  const name = useStore((s) => serverName(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  return { server, name, connected };
}

/** Why a chat takes no call now (logic/chatserver.ts offWhy): its server is not connected, or no longer has it; "" for a chat that
 *  takes one, which a chat of this computer always does. chat: its key. */
export function useOffWhy(chat: string): string {
  const w = useWhere({ id: chat });
  const gone = useStore((s) => !!s.gone[chat]);
  return offWhy(w, gone);
}

/** The item count the branch a chat shows shares with where it came from (logic/prefix.ts). */
export const usePrefixEnd = (chatId: string): number =>
  useStore((s) => prefixEnd(s.trees[chatId], shownBranch(s, chatId), s.chats[chatId]?.forkedAt));

/** A path of this computer, or of the server named, with that server's home as "~". */
export const tildify = (p?: string, server: string = LOCAL_SERVER): string => tildeBy(listsOf(getState(), server)?.home, p);

/** The last name of a path ("/" for none). */
export const base = (p?: string): string => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
