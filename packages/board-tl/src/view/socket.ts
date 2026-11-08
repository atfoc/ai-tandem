// tldraw's sync client over core's `TlLink` (design 2.5): a `TLPersistentClientSocket` whose transport is the link, so the page
// opens no socket of its own (goal 4.6).
//
// - `connectionStatus` follows the link: connecting → offline, online → online, offline → offline. A link that goes offline with
//   one of tldraw's fatal close reasons (the room rejected this client: `INVALID_RECORD`, `CLIENT_TOO_OLD`…, which the board host
//   passes on as the `tl_closed` reason) is `error` with that reason: `TLSyncClient` reports it (`onSyncError`) and closes itself,
//   and sync.ts decides what comes next.
// - Status listeners hear a change only, so a link that goes online → connecting → online gives offline, online, and the client
//   sends its `connect` on each `online` (as on a WebSocket open).
// - `sendMessage(msg)` → `link.send([JSON.stringify(msg)])`; nothing is given to a link that is not online (it would not send it).
// - Each received string → `JSON.parse` → the listeners. A string that is not JSON is dropped (logged).
// - `restart()` → `link.restart()`; `close()` stops listening to the link and never closes it: the app owns the link.
//
// The link is typed structurally (`LinkLike`, the subset of core's `TlLink` used here) so tl.js pulls none of core's code.
import type { TLPersistentClientSocket, TLSocketStatusChangeEvent } from "@tldraw/sync-core";
import type { TlLink, TlLinkStatus } from "@aiwb/core/tl/link.ts";

/** What the socket needs of a link (core's `TlLink` satisfies it). */
export type LinkLike = Pick<TlLink, "status" | "send" | "onMessages" | "onStatus" | "restart">;
export type { TlLinkStatus };

type SocketStatus = TLPersistentClientSocket["connectionStatus"];

/** tldraw's fatal close reasons (`TLSyncErrorCloseEventReason` of @tldraw/sync-core 5.6.0): a link closed with one of them was
 *  rejected by the room, not cut. Listed here so the socket does not import sync-core's runtime for a list of names. */
export const FATAL_REASONS: ReadonlySet<string> = new Set([
  "NOT_FOUND", "FORBIDDEN", "NOT_AUTHENTICATED", "UNKNOWN_ERROR", "CLIENT_TOO_OLD", "SERVER_TOO_OLD", "INVALID_RECORD",
  "RATE_LIMITED", "ROOM_FULL", "MESSAGE_TOO_LARGE",
]);

/** The socket status for a link status (and the reason it went offline with). */
export function socketStatusOf(s: TlLinkStatus, reason?: string): SocketStatus {
  if (s === "online") return "online";
  if (s === "offline" && reason && FATAL_REASONS.has(reason)) return "error";
  return "offline";
}

export class TransportSocket implements TLPersistentClientSocket<object, object> {
  connectionStatus: SocketStatus;
  /** The reason of the last `error` status (a fatal close reason). */
  lastError: string | undefined;
  private readonly link: LinkLike;
  private readonly msgListeners = new Set<(m: object) => void>();
  private readonly statusListeners = new Set<(e: TLSocketStatusChangeEvent) => void>();
  private readonly off: Array<() => void>;
  private closed = false;

  constructor(link: LinkLike) {
    this.link = link;
    this.connectionStatus = socketStatusOf(link.status);
    this.off = [
      link.onStatus((s, reason) => this.setStatus(socketStatusOf(s, reason), reason)),
      link.onMessages((messages) => this.receive(messages)),
    ];
  }

  sendMessage(msg: object): void {
    if (this.closed || this.connectionStatus !== "online") return;
    this.link.send([JSON.stringify(msg)]);
  }

  onReceiveMessage = (cb: (m: object) => void) => {
    this.msgListeners.add(cb);
    return () => void this.msgListeners.delete(cb);
  };

  onStatusChange = (cb: (e: TLSocketStatusChangeEvent) => void) => {
    this.statusListeners.add(cb);
    return () => void this.statusListeners.delete(cb);
  };

  restart(): void {
    if (this.closed) return;
    this.link.restart();
  }

  /** Stops listening to the link (the link itself stays open: the app owns it). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.off) f();
    this.msgListeners.clear();
    this.statusListeners.clear();
  }

  private receive(messages: string[]) {
    if (this.closed) return;
    for (const text of messages) {
      let msg: object;
      try {
        msg = JSON.parse(text);
      } catch {
        console.warn("board-tl: a sync message that is not JSON was dropped");
        continue;
      }
      for (const cb of [...this.msgListeners]) cb(msg);
      if (this.closed) return;
    }
  }

  private setStatus(next: SocketStatus, reason?: string) {
    if (this.closed || next === this.connectionStatus) return;
    this.connectionStatus = next;
    let ev: TLSocketStatusChangeEvent;
    if (next === "error") {
      this.lastError = reason ?? "UNKNOWN_ERROR";
      ev = { status: "error", reason: this.lastError };
    } else ev = { status: next };
    for (const cb of [...this.statusListeners]) cb(ev);
  }
}
