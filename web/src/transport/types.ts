// The page's one way to the network (the app-as-client plan, C6). A call names the server by its entry id and
// carries a path of the client API; the stream carries the events of every server, each with its entry's id;
// a picture has an address of its own. The page does not know which way the transport is made: IPC to the app's
// main process, or HTTP to the test host (ipc.ts, http.ts). DOM-free.
import type { ServerView } from "../logic/servers.ts";
import type { DesktopPick } from "../logic/chatimage.ts";

/** "local" for this computer, "s_" and 12 hex digits for an entry of the server list. */
export type ServerId = string;

export type CallBody = { json: string } | { bytes: Uint8Array | Blob; type: string };

export type CallRequest = {
  server: ServerId;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A path of the client API with its query: "/api/chats/c_1/items?branch=main". */
  path: string;
  body?: CallBody;
  signal?: AbortSignal;
  /** Lets the call finish while the page unloads. */
  keepalive?: boolean;
};

/** What a call answered: its status (also a refusal's, or one the way made up for a server that is not there) and its body as text. sceneRev: the revision header of a board's scene read. */
export type CallAnswer = { status: number; text: string; sceneRev: number | null };

export type AppEvent = { type: "servers"; servers: ServerView[]; notice: string } | { type: "server_state"; server: ServerView };

/** One thing the stream carries: an event of a server's own stream, or one about the app's list of servers. */
export type Envelope = { server: ServerId; event: any } | { app: AppEvent };

/** "closed": the stream ended for good and is not opened again by the way; the page opens it again. */
export type StreamState = "open" | "closed";

export type AppAnswer = { status: number; text: string };

export interface Transport {
  readonly way: "ipc" | "http";
  /** Rejects only on abort (an AbortError), or when the way itself failed (a TransportError). */
  call(req: CallRequest): Promise<CallAnswer>;
  stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void): { close(): void };
  pictureURL(server: ServerId, chat: string, image: string): string;
  /** An operation of the app itself: the server list ("servers.*") and the owner's things ("owner.*"). */
  app(op: string, args?: unknown): Promise<AppAnswer>;
  /** The IPC way only: the app's own dialog for images. */
  pickImages?(): Promise<DesktopPick>;
}

/** The way itself failed: not a server's answer. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "TransportError"; }
}

/** The error of an aborted call, as fetch makes it. */
export const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException("The call was aborted.", "AbortError");
