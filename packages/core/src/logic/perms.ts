// Permission cards: what the answer to one says. DOM-free.
import type { Item } from "../types.ts";

/** POST /api/chats/{id}/permission. */
export type PermAnswer = { requestId: string; allow: boolean; subagent?: string };

/** The answer to a permission card. A request is named by who asked together with its id: the id
 *  alone repeats between a chat's agent and its subagents. A card without a subagent was asked by
 *  the chat's own agent, and its answer names none. */
export function permAnswer(card: Item, allow: boolean): PermAnswer {
  const a: PermAnswer = { requestId: card.requestId ?? "", allow };
  if (card.subagent) a.subagent = card.subagent;
  return a;
}
