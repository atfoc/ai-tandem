// A chat of a section (a remote server of the server list) where its thread is, and in the delete
// dialog: what is shown while that server is not connected, and when the chat is no longer on it.
// DOM-free.
import { stateLabel, type ServerState } from "./servers.ts";
import { notConnected } from "./status.ts";
import type { ThreadError } from "./serverlists.ts";

export const SERVERS = "Servers…";
export const TRY_AGAIN = "Try again";

/** The code of a call whose chat, board or group is not on its server (any more). */
export const NOT_FOUND = "not_found";

export const goneText = (name: string): string => `This chat is no longer on ${name}.`;
export const unreachableText = (name: string): string => `${notConnected(name)}. This chat shows again when it is back.`;
/** The warning over a chat that is on screen while its server is not connected. */
export const awayText = (name: string): string => `${notConnected(name)}. This chat is shown as it was when the connection ended.`;

/** What these read of a thing: whether it is of a section, whether its server takes a call now (the local server
 *  holds its tree), and whether the page knows that the thing is no longer on its server (it was removed there, or
 *  was not in the tree that came back). */
export type Remote = { remote: boolean; connected: boolean; gone?: boolean };

/** The server list's words for the state of an entry that is not connected, as the view of one of its things says
 *  them after its own sentence: why it is not ("Unreachable", "Too old: update the server on that machine",
 *  "Certificate changed", any state that waits for the user), which the sentence alone does not tell. An entry whose
 *  state is connected while the local server holds no tree of it yet is connecting, as its section says. "" for an
 *  entry the list lacks. */
export const stateSaid = (state: ServerState | undefined): string => (state ? stateLabel(state === "connected" ? "connecting" : state) : "");

/** What a section's chat shows where its thread is.
 *  none: the thread as usual (always for a chat of this computer, and while a load runs).
 *  unreachable: no thread is kept while the server is not connected: the sentence, the entry's
 *    state (`state`: stateSaid) and "Servers…".
 *  gone: no thread is kept and the chat is no longer there: the sentence.
 *  failed: no thread is kept and its load failed for another reason: the server's sentence and "Try again".
 *  bar: the thread kept stays on screen, read-only, under a warning above the composer; `gone`
 *    when it says that the chat is no longer there, else that the server is not connected, with
 *    the entry's state (`state`: stateSaid) and "Servers…". */
type RemoteView =
  | { kind: "none" }
  | { kind: "unreachable"; text: string; state: string }
  | { kind: "gone"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "bar"; text: string; gone: boolean; state?: string };

const NONE: RemoteView = { kind: "none" };

export function remoteView(at: Remote, name: string, state: ServerState | undefined, hasThread: boolean, err?: ThreadError): RemoteView {
  if (!at.remote) return NONE;
  const gone = !!at.gone || err?.code === NOT_FOUND;
  if (hasThread) return gone ? { kind: "bar", text: goneText(name), gone: true } : at.connected ? NONE : { kind: "bar", text: awayText(name), gone: false, state: stateSaid(state) };
  if (gone) return { kind: "gone", text: goneText(name) };
  if (!at.connected) return { kind: "unreachable", text: unreachableText(name), state: stateSaid(state) };
  return err ? { kind: "failed", text: err.message } : NONE;
}

/** A dialog about deleting a chat. */
type DeleteAsk = { title: string; body: string };

/** The dialog the row's Delete opens. name: the server's, "" for a chat of this computer. A chat of a section is
 *  deleted on its server, for its owner and every client of it. */
export function deleteAsk(title: string, name = ""): DeleteAsk {
  return { title: `Delete ${title}?`, body: name ? `Its history is removed on ${name}, for everyone who uses that server. This can't be undone.` : "Its history is removed. This can't be undone." };
}
