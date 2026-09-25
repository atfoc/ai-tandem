// The line to the server: SSE in (state, chat items, rpc calls), POSTs out
// through api.ts. The server lets one tab at a time be the active client; a
// newer tab takes over after this one has written its pending saves.
import { api, clientId } from "./api.ts";
import { setState, getState, applySnapshot, upsertBoard, removeBoard, upsertChat, removeChat } from "./store.ts";
import { runTool, flushAll } from "./board.ts";
import type { Item } from "./types.ts";

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
    case "hello": setState({ connected: true, role: m.active ? "active" : "waiting" }); return;
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

// ---- chat items

type Update = { index: number; item: Item };
const pending = new Map<string, { version: number; updates: Update[] }[]>(); // updates that arrive while a fetch runs

function apply(chat: string, version: number, updates: Update[]) {
  setState((s) => {
    const cur = s.items[chat];
    if (!cur || version <= cur.version) return {};
    const items = cur.items.slice();
    for (const u of updates) items[u.index] = u.item;
    return { items: { ...s.items, [chat]: { version, items } } };
  });
}

/** Applies item updates to a chat whose items are loaded; others are fetched in full when opened. */
export function applyItems(chat: string, version: number, updates: Update[]) {
  const buf = pending.get(chat);
  if (buf) { buf.push({ version, updates }); return; }
  apply(chat, version, updates);
}

/** Fetches a chat's items in full; updates that arrive meanwhile are applied after it. */
export async function loadItems(chat: string) {
  if (pending.has(chat)) return;
  pending.set(chat, []);
  try {
    const r = await api.items(chat);
    if (!r) return;
    setState((s) => {
      const cur = s.items[chat];
      if (cur && cur.version >= r.version) return {};
      return { items: { ...s.items, [chat]: { version: r.version, items: r.items ?? [] } } };
    });
  } catch (e) {
    console.error(`loading chat ${chat}:`, e);
  } finally {
    const buf = pending.get(chat) ?? [];
    pending.delete(chat);
    for (const u of buf) apply(chat, u.version, u.updates);
  }
}

/** Replaces a chat and its items with the server's (after a stale 409). */
export async function refreshChat(chat: string) {
  try { upsertChat(await api.chat(chat)); } catch {}
  try {
    const r = await api.items(chat);
    if (r) setState((s) => ({ items: { ...s.items, [chat]: { version: r.version, items: r.items ?? [] } } }));
  } catch {}
}
