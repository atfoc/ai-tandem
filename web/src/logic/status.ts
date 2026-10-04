// What a chat is doing, read from its view: its status and the two counts the server derives from
// its subagents (subsRunning, subsOwed). DOM-free.
import type { ChatView, Status } from "../types.ts";

type Doing = Pick<ChatView, "status" | "subsRunning" | "subsOwed">;

/** The agent is in a turn or waits for the user's approval: the chat takes no message. */
export const isBusy = (s: Status | undefined) => s === "thinking" || s === "writing" || s === "tool" || s === "approval";

/** The chat has work that a restart, or archiving or deleting its board, ends: its agent is busy,
 *  or the subagents it spawned still run while it waits for them. Results not sent yet do not
 *  count: they are kept, and go to the agent with the next message. */
export const isWorking = (c: Doing): boolean => isBusy(c.status) || (c.subsRunning ?? 0) > 0;

/** The chats working on a board, archived ones left out: the ones the board's archive and delete
 *  confirmations warn about and stop. */
export function workingOn<C extends Doing & Pick<ChatView, "board" | "archived">>(chats: Iterable<C>, board: string): C[] {
  return [...chats].filter((c) => c.board === board && !c.archived && isWorking(c));
}

/** What the composer does in the chat's state.
 *  stop: the Stop control shows; for an idle chat whose subagents run, it stops them.
 *  blocked: no message can be sent, because the agent is busy; an idle chat takes one while its
 *  subagents run.
 *  esc: Esc stops, only while the agent is busy. */
export function composerControls(c: Doing): { stop: boolean; blocked: boolean; esc: boolean } {
  const busy = isBusy(c.status);
  return { stop: isWorking(c), blocked: busy, esc: busy };
}
