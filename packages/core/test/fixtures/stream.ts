// What the page's tests push into the stream, in the words they use: an event of the stream as one message, with `server`
// naming a section's thing, `section` for a server's tree arriving or going, and a snapshot that carries `servers`,
// `sections`, `lists` and `libraries` beside this computer's own. The transport carries something else: an envelope for
// each server's own event, and the app's events for the server list and the state of each entry (src/transport/types.ts).
// This turns the one into the other, so that a test says what happened and not how the transport carries it.
import type { Envelope } from "../../src/transport/index.ts";

type Entry = { id: string; name?: string; state?: string; [k: string]: unknown };
/** What the page knew when the message came: the server list, and the entries whose tree it holds. */
export type Context = { servers?: Entry[]; sections?: string[] };

const LOCAL = "local";
const own = (e: Record<string, unknown>): Envelope => ({ server: LOCAL, event: e });

/** A section's tree as its server's snapshot: its own lists (agents, catalogs, home, defaultCwd) and its library beside. */
function snapshotOf(tree: Record<string, any>, lists?: Record<string, any>, library?: Record<string, any>): Record<string, unknown> {
  return { type: "snapshot", ...(lists ?? { agents: [], catalogs: {}, home: "", defaultCwd: "" }), ...tree, ...(library ? { library: { groups: library.groups ?? [], prompts: library.prompts ?? [] } } : {}) };
}

export function envelopesOf(m: Record<string, any>, ctx: Context = {}): Envelope[] {
  switch (m.type) {
    case "snapshot": {
      const { servers, serversNotice, sections, lists, libraries, dataDir: _, ...mine } = m;
      const out: Envelope[] = [];
      if (servers) out.push({ app: { type: "servers", servers, notice: serversNotice ?? "" } });
      const lib = (id: string) => (libraries as any[] | undefined)?.find((l) => l.server === id);
      out.push(own({ ...mine, ...(lib(LOCAL) ? { library: lib(LOCAL) } : {}) }));
      const given = new Set<string>();
      for (const [id, tree] of Object.entries<any>(sections ?? {})) if (tree) { out.push({ server: id, event: snapshotOf(tree, lists?.[id], lib(id)) }); given.add(id); }
      // an entry the page held a tree of, and this snapshot has none of: it is not connected
      for (const id of ctx.sections ?? []) if (!given.has(id)) out.push(...left(id, ctx));
      return out;
    }
    case "section": return m.tree ? [{ server: m.server, event: snapshotOf(m.tree) }] : left(m.server, ctx);
    case "servers": return [{ app: { type: "servers", servers: m.servers, notice: m.notice ?? "" } }];
    case "server_state": return [{ app: { type: "server_state", server: m.server } }];
    case "library": return [{ server: m.library.server, event: { type: "own_library", groups: m.library.groups, prompts: m.library.prompts } }];
    default: {
      const { server, ...event } = m;
      return [{ server: server ?? LOCAL, event }];
    }
  }
}

/** An entry that is not connected any more: its state says so. */
function left(id: string, ctx: Context): Envelope[] {
  const had = ctx.servers?.find((v) => v.id === id);
  if (ctx.servers && !had && !ctx.sections?.includes(id)) return []; // an entry that is gone from the list, and has no tree, has no state to tell
  return [{ app: { type: "server_state", server: { name: id, ...had, id, state: had && had.state !== "connected" ? had.state : "unreachable" } as any } }];
}

/** The stream of a fake transport for a test that bundles the page's modules itself: the test installs `transport` in its
 *  bundle (`tr.useTransport(fake.transport)`, `tr` being the bundle's src/transport) and pushes with `push`. */
export function fakeStream() {
  type Open = { onEnvelope: (e: Envelope) => void; onState: (s: string) => void; closed: boolean };
  const streams: Open[] = [];
  const open = (): Open | undefined => streams.filter((x) => !x.closed).at(-1);
  const transport = {
    way: "ipc" as const,
    stream: (onEnvelope: Open["onEnvelope"], onState: Open["onState"]) => { const x = { onEnvelope, onState, closed: false }; streams.push(x); return { close() { x.closed = true; } }; },
    call: async () => { throw new Error("no call in this test"); },
    app: async () => { throw new Error("no app operation in this test"); },
    pictureURL: (server: string, chat: string, image: string) => `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`,
    picture: async (server: string, chat: string, image: string) => `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`,
  };
  /** Pushes an old-style message (envelopesOf) to the open stream. */
  const push = (m: Record<string, unknown>, ctx: Context = {}) => { for (const e of envelopesOf(m, ctx)) open()!.onEnvelope(e); };
  return { transport, streams, open, push };
}
