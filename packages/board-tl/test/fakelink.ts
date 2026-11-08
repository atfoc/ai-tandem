// A stand-in for core's TlLink in tests: a plain fake (statuses and sends recorded), or one wired to an in-process TLSocketRoom
// (RoomLink: a session per open, messages delivered on a later macrotask, cut/reopen as the real link's sessions are).
import type { TlLinkStatus } from "@aiwb/core/tl/link.ts";

export class FakeLink {
  status: TlLinkStatus = "connecting";
  sent: string[][] = [];
  restarts = 0;
  private msgCbs = new Set<(m: string[]) => void>();
  private statusCbs = new Set<(s: TlLinkStatus, reason?: string) => void>();
  send(messages: string[]) { this.sent.push(messages); }
  onMessages(cb: (m: string[]) => void) { this.msgCbs.add(cb); return () => void this.msgCbs.delete(cb); }
  onStatus(cb: (s: TlLinkStatus, reason?: string) => void) { this.statusCbs.add(cb); return () => void this.statusCbs.delete(cb); }
  restart() { this.restarts++; }
  close() {}
  get listeners() { return this.msgCbs.size + this.statusCbs.size; }
  setStatus(s: TlLinkStatus, reason?: string) { this.status = s; for (const cb of [...this.statusCbs]) cb(s, reason); }
  deliver(messages: string[]) { for (const cb of [...this.msgCbs]) cb(messages); }
}

type RoomLike = {
  handleSocketConnect(o: { sessionId: string; socket: unknown }): void;
  handleSocketMessage(sessionId: string, data: string, socket: unknown): void;
  handleSocketClose(sessionId: string, socket: unknown): void;
  isClosed(): boolean;
};

const later = (fn: () => void) => setImmediate(fn);

/** A link with sessions on a room: `open()` (and `restart()`) start one, `cut()` ends it as a lost connection would. */
export class RoomLink extends FakeLink {
  private room: RoomLike;
  private n = 0;
  private gen = 0;
  private proxy: { readyState: number; send(d: string): void; close(code?: number, reason?: string): void } | null = null;
  private session = "";
  readonly name: string;
  /** Every message the room sent to this link, in order. */
  readonly inbox: string[] = [];
  /** Pushes this link sent that the room has not answered yet (tldraw's `push` / `push_result`). */
  get unanswered() {
    const count = (list: string[], what: string) => list.reduce((n, m) => n + m.split(what).length - 1, 0);
    return count(this.sent.flat(), '"type":"push"') - count(this.inbox, '"type":"push_result"');
  }
  override deliver(messages: string[]) {
    this.inbox.push(...messages);
    super.deliver(messages);
  }
  constructor(room: RoomLike, name: string) {
    super();
    this.room = room;
    this.name = name;
  }
  open() {
    if (this.proxy) return;
    const gen = ++this.gen;
    this.session = `${this.name}-${++this.n}`;
    this.setStatus("connecting");
    const self = this;
    const proxy = {
      readyState: 1,
      send(d: string) { if (this.readyState === 1) later(() => { if (gen === self.gen) self.deliver([d]); }); },
      close(_code?: number, reason?: string) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (gen !== self.gen) return;
        self.proxy = null;
        self.gen++;
        later(() => self.setStatus("offline", reason || "closed"));
      },
    };
    this.proxy = proxy;
    this.room.handleSocketConnect({ sessionId: this.session, socket: proxy });
    later(() => { if (gen === this.gen) this.setStatus("online"); });
  }
  override send(messages: string[]) {
    super.send(messages);
    const proxy = this.proxy, gen = this.gen, session = this.session;
    if (!proxy || this.status !== "online") return;
    later(() => {
      if (gen !== this.gen || this.room.isClosed()) return;
      for (const m of messages) this.room.handleSocketMessage(session, m, proxy);
    });
  }
  /** The session is lost (in-flight messages too); the link is offline until `open()`. */
  cut(reason = "cut") {
    const proxy = this.proxy;
    this.proxy = null;
    this.gen++;
    if (proxy) {
      proxy.readyState = 3;
      if (!this.room.isClosed()) this.room.handleSocketClose(this.session, proxy);
    }
    this.setStatus("offline", reason);
  }
  override restart() {
    super.restart();
    this.cut("restart");
    this.open();
  }
}
