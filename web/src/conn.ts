// The line to the server: SSE in (state, chat items, rpc calls), POSTs out
// through api.ts. The server lets one tab at a time be the active client; a
// newer tab takes over after this one has written its pending saves.
import { api, clientId } from "./api.ts";
import { setState, getState, applySnapshot, upsertBoard, removeBoard, upsertChat, removeChat, upsertSub } from "./store.ts";
import { runTool, flushAll } from "./board.ts";
import { subKey } from "./logic/subagents.ts";
import { checkVersion } from "./version.ts";
import type { Item, Subagent } from "./types.ts";

let es: EventSource | null = null;

export function connect() {
  es?.close();
  setState({ role: "connecting" });
  const src = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
  es = src;
  src.onerror = () => { if (es === src) setState({ connected: false }); }; // EventSource reconnects by itself
  src.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    void handle(m, src);
  };
}

async function handle(m: any, src: EventSource) {
  if (es !== src) return;
  switch (m.type) {
    case "hello": setState({ connected: true, role: m.active ? "active" : "waiting" }); void checkVersion(); return;
    case "snapshot": applySnapshot(m); afterSnapshot(); return;
    case "release_request": await flushAll(); await api.release().catch(() => {}); return;
    case "superseded": src.close(); es = null; setState({ role: "superseded" }); return; // TakeoverScreen
    case "server_stopping": await flushAll(); await api.flushed().catch(() => {}); return;
    case "rpc": return answer(m);
    case "groups": setState({ groups: m.groups ?? [] }); return;
    case "board": upsertBoard(m.board); return;
    case "board_removed": removeBoard(m.id); return;
    case "chat": upsertChat(m.chat); return;
    case "chat_removed": removeChat(m.id); return;
    case "chat_items": applyItems(m.chat, m.version, m.updates ?? []); return;
    case "sub": return applySub(m.chat, m.subagent);           // queued while the chat's items load
    case "sub_items": applyItems(subKey(m.chat, m.sub), m.version, m.updates ?? []); return;
    case "defaults": setState({ defaults: m.defaults }); return;
    case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } })); return;
  }
}

/** A fresh snapshot drops cached items; the chat on screen gets its history again. */
function afterSnapshot() {
  const chat = getState().sel.chat;
  if (chat) { void api.openChat(chat).catch(() => {}); void loadItems(chat); }
}

async function answer(m: any) {
  let reply: { result?: unknown; error?: string };
  try {
    if (m.method !== "tool") throw new Error(`unknown method ${m.method}`);
    reply = { result: await runTool(m.params) };
  } catch (err: any) {
    reply = { error: `${err?.code ? err.code + ": " : ""}${err?.message ?? String(err)}` };
  }
  await api.rpcReply(m.id, reply).catch((e) => console.error("rpc reply:", e));
}

export function takeBack() { connect(); } // "Use here" button

// ---- threads: a chat's items under its id, a subagent's under subKey(chat, sid)

type Update = { index: number; item: Item };
type Queued = { version: number; updates: Update[] } | { sub: Subagent };
const pending = new Map<string, Queued[]>(); // by thread key: what arrives while its fetch runs

function apply(key: string, version: number, updates: Update[]) {
  setState((s) => {
    const cur = s.items[key];
    if (!cur || version <= cur.version) return {};
    const items = cur.items.slice();
    for (const u of updates) items[u.index] = u.item;
    return { items: { ...s.items, [key]: { version, items } } };
  });
}

/** Applies item updates to a thread that is loaded; others are fetched in full when wanted. */
export function applyItems(key: string, version: number, updates: Update[]) {
  const buf = pending.get(key);
  if (buf) { buf.push({ version, updates }); return; }
  apply(key, version, updates);
}

/** Sets a subagent's state; while its chat's items load, after them, so an older response never
 *  overwrites a newer state. */
function applySub(chat: string, sa: Subagent) {
  if (!sa?.id) return;
  const buf = pending.get(chat);
  if (buf) { buf.push({ sub: sa }); return; }
  upsertSub(chat, sa);
}

const subsById = (xs: Subagent[] | undefined): Record<string, Subagent> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

/** Fetches a thread in full; what arrives for it meanwhile is applied after it. A chat's response
 *  also brings its subagents. */
async function loadThread(key: string, fetch: () => Promise<{ version: number; items: Item[]; subagents?: Subagent[] }>) {
  if (pending.has(key)) return;
  pending.set(key, []);
  try {
    const r = await fetch();
    if (!r) return;
    setState((s) => {
      const cur = s.items[key];
      if (cur && cur.version >= r.version) return {};
      const items = { ...s.items, [key]: { version: r.version, items: r.items ?? [] } };
      return r.subagents !== undefined ? { items, subs: { ...s.subs, [key]: subsById(r.subagents) } } : { items };
    });
  } catch (e) {
    console.error(`loading thread ${key}:`, e);
  } finally {
    const buf = pending.get(key) ?? [];
    pending.delete(key);
    for (const u of buf) {
      if ("sub" in u) upsertSub(key, u.sub);
      else apply(key, u.version, u.updates);
    }
  }
}

/** Fetches a chat's items and subagents. */
export const loadItems = (chat: string) => loadThread(chat, () => api.items(chat));

/** Fetches a subagent's own thread. */
export const loadSubItems = (chat: string, sid: string) => loadThread(subKey(chat, sid), () => api.subItems(chat, sid));

/** Replaces a chat, its items and its subagents with the server's (after a stale 409). */
export async function refreshChat(chat: string) {
  try { upsertChat(await api.chat(chat)); } catch {}
  try {
    const r = await api.items(chat);
    if (r) setState((s) => ({
      items: { ...s.items, [chat]: { version: r.version, items: r.items ?? [] } },
      subs: { ...s.subs, [chat]: subsById(r.subagents) },
    }));
  } catch {}
}
