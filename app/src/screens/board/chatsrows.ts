// What the Chats sheet lists (package B1, plans/ux-improvements/b1-design.md §4), with no React and no react-native, so that Node tests it
// (test/board.chatssheet.test.ts): the sub-line of the head, whether "New chat on this board" is offered, and a chat's row.
import { agentShortName } from "@aiwb/core/agents.ts";
import { chatWord } from "@aiwb/core/logic/statewords.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";
import { boardChats } from "@aiwb/core/logic/tree.ts";
import type { State } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { pickTarget } from "../voice/pill/logic.ts";

/** The head's sub-line: how many chats the sheet lists. */
export const chatsCount = (n: number): string => (n === 0 ? "No chats yet" : n === 1 ? "1 chat" : `${n} chats`);

/** The head's title; the quotes are typographic, as in the mockup. */
export const chatsTitle = (name: string): string => `Chats on “${name}”`;

export const NEW_CHAT_LABEL = "New chat on this board";
export const NEW_CHAT_NOTE = "The agent can read and draw on this board";

/** "New chat on this board" is offered unless the board is archived or its server is not reachable. */
export function canStartChat(s: Pick<State, "boards" | "sections" | "gone" | "connected">, board: string): boolean {
  const b = s.boards[board];
  return !!b && !b.archived && reachable(s, board);
}

/** A chat's second line: "<Agent short> · <state word, else the model>", the agent alone when it has neither. */
export function chatLine(c: Pick<ChatView, "agent" | "status" | "approvals" | "subsRunning" | "working">, model: string): string {
  const then = chatWord(c)?.text ?? (model || "");
  return then ? `${agentShortName(c.agent)} · ${then}` : agentShortName(c.agent);
}

export type ChatsRow = { id: string; chat: ChatView; title: string; line: string; voice: boolean; open: boolean; label: string };

/** The rows under "New chat": the board's chats as the sidebar lists them, the one voice talks to marked. `title` and `model` name a chat
 *  and its model the way the screen does (the thread's first message names a chat that has no name; the catalog labels the model). */
export function chatsRows(
  s: Pick<State, "chats" | "showArchived">, board: string, o: { last: string | undefined; open: string | null; title(c: ChatView): string; model(c: ChatView): string },
): ChatsRow[] {
  const voice = pickTarget(s.chats, board, o.last, s.showArchived);
  return boardChats(s.chats, board, s.showArchived).map((c) => {
    const title = o.title(c), line = chatLine(c, o.model(c)), isVoice = c.id === voice;
    return { id: c.id, chat: c, title, line, voice: isVoice, open: c.id === o.open, label: `${title}, ${line}${isVoice ? ", Voice" : ""}` };
  });
}
