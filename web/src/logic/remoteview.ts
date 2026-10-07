// A chat on another server (an entry of the server list) where its thread is, and in the delete
// dialog: what is shown while that server is not connected, and when the chat is no longer on it.
// DOM-free.
import type { ChatView } from "../types.ts";
import { stateLabel, type ServerState } from "./servers.ts";
import { notConnected } from "./status.ts";
import type { ThreadError } from "./serverlists.ts";

export const REMOVE = "Remove from this sidebar";
export const REMOVE_ONLY = "Remove from this sidebar only";
export const SERVERS = "Servers…";
export const TRY_AGAIN = "Try again";

/** The code of a call the remote server answered "no such chat" to. */
const GONE_THERE = "gone_there";

export const goneText = (name: string): string => `This chat is no longer on ${name}.`;
export const unreachableText = (name: string): string => `${notConnected(name)}. This chat shows again when it is back.`;
export const staysText = (name: string): string => `Removing it from this sidebar leaves the chat on ${name}.`;

type Remote = Pick<ChatView, "server" | "gone">;

/** What a remote chat shows where its thread is.
 *  none: the thread as usual (always for a chat of this computer, and while a load runs).
 *  unreachable: no thread is kept and its load failed while the server is not connected: the
 *    sentence, the entry's state (`state`, "" for an entry the list lacks) and "Servers…".
 *  gone: no thread is kept and the chat is no longer there: the sentence and "Remove from this sidebar".
 *  failed: no thread is kept and its load failed for another reason: the server's sentence and "Try again".
 *  bar: the thread kept stays on screen, with a bar above the composer; `gone` when the bar says
 *    the chat is no longer there (it then has the remove button). */
export type RemoteView =
  | { kind: "none" }
  | { kind: "unreachable"; text: string; state: string }
  | { kind: "gone"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "bar"; text: string; gone: boolean };

const NONE: RemoteView = { kind: "none" };

export function remoteView(c: Remote, name: string, state: ServerState | undefined, hasThread: boolean, err?: ThreadError): RemoteView {
  if (!c.server) return NONE;
  const connected = state === "connected";
  const gone = !!c.gone || err?.code === GONE_THERE;
  if (hasThread) return gone ? { kind: "bar", text: goneText(name), gone: true } : connected ? NONE : { kind: "bar", text: `${notConnected(name)}.`, gone: false };
  if (gone) return { kind: "gone", text: goneText(name) };
  if (!err) return NONE;
  return connected ? { kind: "failed", text: err.message } : { kind: "unreachable", text: unreachableText(name), state: state ? stateLabel(state) : "" };
}

/** Whether "Remove from this sidebar only" is offered for a chat: it is on another server and is
 *  gone, or its delete was answered 503 (`server_unreachable`: nothing was sent). Never for a chat
 *  of this computer, and not after another refusal (no answer, a 409). */
export function offersLocalOnly(c: Remote, err?: unknown): boolean {
  if (!c.server) return false;
  if (c.gone) return true;
  const e = err as { status?: unknown; code?: unknown } | null | undefined;
  return e?.status === 503 || e?.code === "server_unreachable";
}

/** A dialog about deleting a chat. local: its one action removes this sidebar's record only. */
export type DeleteAsk = { title: string; body: string; action: string; local: boolean };

/** The dialog the row's Delete (or, for a gone chat, "Remove from this sidebar") opens. */
export function deleteAsk(c: Remote, title: string, name: string): DeleteAsk {
  if (offersLocalOnly(c)) return { title: `Remove ${title} from this sidebar?`, body: goneText(name), action: REMOVE_ONLY, local: true };
  return { title: `Delete ${title}?`, body: c.server ? `Its history is removed on ${name}. This can't be undone.` : "Its history is removed. This can't be undone.", action: "Delete", local: false };
}

/** The dialog that follows a refused delete: the offer of this sidebar only, with the server's
 *  sentence and one saying the chat stays there; null when the refusal offers nothing (the
 *  dialog then shows the server's sentence, as for any error). */
export function deleteRefused(c: Remote, title: string, name: string, err: unknown): DeleteAsk | null {
  if (c.gone || !offersLocalOnly(c, err)) return null;
  const said = err instanceof Error && err.message ? err.message : `${notConnected(name)}.`;
  return { title: `Remove ${title} from this sidebar?`, body: `${said} The chat was not deleted. ${staysText(name)}`, action: REMOVE_ONLY, local: true };
}
