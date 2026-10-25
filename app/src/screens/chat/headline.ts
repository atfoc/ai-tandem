// What the chat's header says under the title on the phone (ux-improvements goal 3.5): one line from the one list of state words. Pure,
// so a test reads it without a screen. The first that applies: the server is not connected, the chat is archived, a state word of the chat,
// else where it is (the agent, and the folder or the board).
import { agentLabel } from "@aiwb/core/logic/agentlist.ts";
import { retryLine } from "@aiwb/core/logic/retry.ts";
import { chatWord, type WordTone } from "@aiwb/core/logic/statewords.ts";
import type { ChatView } from "@aiwb/core/types.ts";

export type Headline = { text: string; tone?: WordTone };

export type HeadlineIn = {
  chat: Pick<ChatView, "agent" | "archived" | "cwd" | "board" | "status" | "approvals" | "subsRunning" | "working" | "retry">;
  /** The chat's server is not connected (`sendOff`). A chat that is gone from a server that is connected is not this: it reads as it did. */
  off: boolean;
  /** The chat is no longer on its server (which is connected): shown as it was, it has no state now (its requests cannot be answered). */
  gone?: boolean;
  /** The server's name as the page says it ("This computer" for this computer's own). */
  server: string;
  /** The name of the chat's board, for a chat on one. */
  boardName?: string;
  legacy: boolean;
  /** Unix ms, for the wait of a chat that is retried ("Retrying in 40 s · 2 of 4" counts down); now by default. */
  now?: number;
};

/** The last segment of a path, for either kind of separator; "" for none. */
export function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function headline({ chat: c, off, gone, server, boardName, legacy, now = Date.now() }: HeadlineIn): Headline {
  const folder = folderOf(c.cwd);
  if (off) return { text: `● ${server} · offline`, tone: "bad" };
  if (c.archived) return { text: folder ? `Archived · ${folder}` : "Archived" };
  // (a chat of the old board connection takes no message and a chat with no agent runs nothing: neither has a state of its own)
  // (nor has a chat that is gone from its server: it is shown as it was, so it gives its place)
  // (an agent retried after a temporary error says so and when, as the wide header does: "Retrying in 40 s · 2 of 4")
  if (!legacy && !gone && c.status === "retrying") return { text: c.retry ? retryLine(c.retry, now) : "Retrying", tone: "wait" };
  const word = legacy || gone || c.agent === "" ? null : chatWord(c);
  // (a chat whose turn has ended and waits for its background work is not writing: it says what it waits for, as the header always did)
  if (word?.key === "writing" && c.status === "waiting") return { text: "Waiting for background work", tone: "wait" };
  if (word) return { text: word.text, tone: word.tone };
  const where = c.board ? `on ${boardName ?? "board"}` : folder;
  return { text: [agentLabel(c.agent), where, legacy ? "Disabled" : ""].filter(Boolean).join(" · ") };
}

/** The words of the Tree button: the branches the chat has, and whether another branch needs the person (it waits for approval, or failed). */
export function treeLabel(branches: number, others: { asks: string | null; failed: string | null }): string {
  const n = branches > 1 ? `, ${branches} branches` : "";
  const alert = others.asks !== null ? ", a branch needs your approval" : others.failed !== null ? ", a branch failed" : "";
  return `Chat tree${n}${alert}`;
}
