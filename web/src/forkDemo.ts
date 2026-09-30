// PROTOTYPE ONLY (branch fork-chat-feature): demo chats that live in this tab, kept as trees
// (logic/forktree.ts) and answered by a fake agent, so forking can be tried with no agent
// running. They sit in the sidebar with the real chats; the server never sees them. The api calls
// the app makes for a chat are answered here for them.
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { getState, setState, safeGet, safeSet, setExtraChats, removeChat, isBusy } from "./store.ts";
import {
  append, branchName, dropTip, emptyTree, forkOut, landing, leaving, moveTo, preview, setLabel, thread, updateItem,
  type ChatTree, type Entry,
} from "./logic/forktree.ts";
import { UNGROUPED, type ChatView, type Item, type Status } from "./types.ts";

export type Demo = {
  meta: ChatView;
  tree: ChatTree;
  back?: { leaf: string | null; summary?: string; draft?: string }; // undoes the last move: where it came from, what it added
  forkedFrom?: { chat: string; title: string; entry: string; preview: string };
};

/** The navigator (Fork.tsx): open on a chat, the row to start on, and whether to label that row. */
export type Nav = { chat: string; focus?: string | null; label?: boolean };

type DemoState = { chats: Record<string, Demo>; nav: Nav | null };

const KEY = "aiwb.proto.fork";
export const isDemo = (id: string | null | undefined) => !!id && id.startsWith("demo-");

let state: DemoState = { chats: {}, nav: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export const useDemo = (chat: string): Demo | undefined => useSyncExternalStore(subscribe, () => state.chats[chat]);
export const useNav = (): Nav | null => useSyncExternalStore(subscribe, () => state.nav);
export const demo = (chat: string): Demo | undefined => state.chats[chat];
export const currentNav = () => state.nav;

let version = 0;
function sync(d: Demo) {
  setState((s) => ({
    chats: { ...s.chats, [d.meta.id]: d.meta },
    items: { ...s.items, [d.meta.id]: { version: ++version, items: thread(d.tree).map((e) => e.item) } },
  }));
}

function save() {
  const chats = Object.fromEntries(Object.entries(state.chats).map(([k, d]) => [k, { ...d, meta: { ...d.meta, status: "ready" } }]));
  safeSet(KEY, JSON.stringify(chats));
}

function put(d: Demo) {
  state = { ...state, chats: { ...state.chats, [d.meta.id]: d } };
  sync(d); save(); emit();
}

function patch(chat: string, f: (d: Demo) => Partial<Demo>) {
  const d = state.chats[chat];
  if (d) put({ ...d, ...f(d) });
}

const setStatus = (chat: string, status: Status) => patch(chat, (d) => ({ meta: { ...d.meta, status } }));

// ---- composer bridge (Composer.tsx registers each open composer)

const composers = new Map<string, { set: (t: string) => void; get: () => string }>();
export function registerComposer(chat: string, c: { set: (t: string) => void; get: () => string }) {
  composers.set(chat, c);
  return () => { if (composers.get(chat) === c) composers.delete(chat); };
}

// ---- the navigator

export function openNav(chat: string, focus?: string | null, label = false) { state = { ...state, nav: { chat, focus, label } }; emit(); }
export function closeNav() { state = { ...state, nav: null }; emit(); }

// ---- moving in the tree

export type SummaryChoice = null | { focus?: string };

/**
 * Moves the chat to an entry (pi's /tree selection). A message of yours goes back to the composer
 * to be edited; anything else is continued from. With a summary choice, and a branch being left,
 * a summary of that branch is put at the start of the new one. "Back" undoes it until you send.
 */
export function goTo(chat: string, id: string, summary: SummaryChoice = null) {
  const d = state.chats[chat];
  if (!d || isBusy(d.meta.status)) return;
  const from = d.tree.leaf;
  const moved = moveTo(d.tree, id);
  let tree = moved.tree;
  let summaryId: string | undefined;
  const left = leaving(d.tree, from, tree.leaf);
  if (summary && left.length) {
    [tree, summaryId] = append(tree, { kind: "note", text: fakeSummary(d.tree, left, from, summary.focus) }, { summary: { left: left.filter((x) => !d.tree.entries[x].summary).length, from: from! } });
  }
  put({ ...d, tree, back: from === tree.leaf && !summaryId ? d.back : { leaf: from, summary: summaryId, draft: moved.draft } });
  if (moved.draft !== undefined) setTimeout(() => composers.get(chat)?.set(moved.draft!), 0);
}

/** Undoes the last move: back to where the chat was, the summary it made removed, the draft taken back. */
export function goBack(chat: string) {
  const d = state.chats[chat];
  if (!d?.back || isBusy(d.meta.status)) return;
  let tree = d.back.summary ? dropTip(d.tree, d.back.summary) : d.tree;
  tree = { ...tree, leaf: d.back.leaf };
  const c = composers.get(chat);
  if (c && d.back.draft !== undefined && c.get().trim() === d.back.draft.trim()) c.set("");
  put({ ...d, tree, back: undefined });
}

/** Asks for another reply to the message a reply answers: the message is sent again from the same place, as a new branch. */
export function retry(chat: string, reply: string) {
  const d = state.chats[chat];
  const r = d?.tree.entries[reply];
  const u = r?.parent ? d!.tree.entries[r.parent] : undefined;
  if (!d || !u || u.item.kind !== "user" || isBusy(d.meta.status)) return;
  put({ ...d, tree: { ...d.tree, leaf: u.parent }, back: undefined });
  void send(chat, u.item.text ?? "");
}

export function label(chat: string, id: string, text: string) { patch(chat, (d) => ({ tree: setLabel(d.tree, id, text) })); }

/** Copies the way to an entry into a new demo chat (pi's /fork) and returns its id. */
export function forkToChat(chat: string, id: string): string | undefined {
  const d = state.chats[chat];
  const e = d?.tree.entries[id];
  if (!d || !e) return;
  const f = forkOut(d.tree, id, chat);
  const nid = "demo-" + Math.random().toString(36).slice(2, 8);
  const title = d.meta.name ?? "Demo chat";
  put({
    meta: { ...d.meta, id: nid, name: `${title} (fork)`, created: new Date().toISOString(), status: "ready", draft: f.draft ? { text: f.draft } : undefined },
    tree: f.tree,
    forkedFrom: { chat, title, entry: landing(d.tree, id) ?? "", preview: e.item.kind === "user" ? `before “${preview(e, 50)}”` : `after “${preview(e, 50)}”` },
  });
  return nid;
}

// ---- the fake agent

const timers = new Map<string, number[]>();
const later = (chat: string, ms: number, f: () => void) => {
  const t = window.setTimeout(f, ms);
  timers.set(chat, [...(timers.get(chat) ?? []), t]);
};

/** Sends a message from the leaf and has the fake agent answer it. */
async function send(chat: string, text: string) {
  const d = state.chats[chat];
  if (!d) throw new Error("demo chat not found");
  if (isBusy(d.meta.status)) throw new Error("The agent is working");
  const [tree] = append(d.tree, { kind: "user", text });
  put({ ...d, tree, back: undefined, meta: { ...d.meta, status: "thinking", locked: true, draft: undefined } });
  // how many times this text was sent before: a retry gets a different reply
  const n = Object.values(d.tree.entries).filter((e) => e.item.kind === "user" && e.item.text === text).length;
  const r = fakeReply(text, n);
  let at = 500;
  if (r.tool) {
    const [name, input, result] = r.tool;
    let toolId = "";
    later(chat, at, () => {
      patch(chat, (x) => { const [t, id] = append(x.tree, { kind: "tool", toolId: "demo", name, input }); toolId = id; return { tree: t, meta: { ...x.meta, status: "tool" } }; });
    });
    at += 900;
    later(chat, at, () => patch(chat, (x) => ({ tree: updateItem(x.tree, toolId, { ...x.tree.entries[toolId].item, result }) })));
    at += 200;
  }
  let textId = "";
  later(chat, at, () => {
    patch(chat, (x) => { const [t, id] = append(x.tree, { kind: "text", text: "", done: false }); textId = id; return { tree: t, meta: { ...x.meta, status: "writing" } }; });
  });
  const words = r.text.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i += 4) {
    at += 45;
    const upto = words.slice(0, i + 4).join("");
    later(chat, at, () => patch(chat, (x) => ({ tree: updateItem(x.tree, textId, { kind: "text", text: upto, done: false }) })));
  }
  later(chat, at + 60, () => {
    patch(chat, (x) => ({ tree: updateItem(x.tree, textId, { kind: "text", text: r.text, done: true }), meta: { ...x.meta, status: "ready" } }));
    timers.delete(chat);
  });
}

function stop(chat: string) {
  for (const t of timers.get(chat) ?? []) clearTimeout(t);
  timers.delete(chat);
  patch(chat, (d) => {
    let tree = d.tree;
    for (const id of tree.order) {
      const it = tree.entries[id].item;
      if (it.kind === "text" && !it.done) tree = updateItem(tree, id, { ...it, done: true });
      if (it.kind === "tool" && it.result === undefined) tree = updateItem(tree, id, { ...it, result: "stopped" });
    }
    return { tree, meta: { ...d.meta, status: "ready" }, back: undefined };
  });
}

const REPLIES: { match: RegExp; tool?: [string, unknown, string]; texts: string[] }[] = [
  {
    match: /test/i, tool: ["Grep", { pattern: "func Test", path: "internal/ratelimit" }, "internal/ratelimit/bucket_test.go:12"],
    texts: [
      "Added table-driven tests for the bucket:\n\n- **refill**: tokens come back at the configured rate\n- **burst**: a full bucket lets `burst` requests through at once\n- **per key**: two keys never share tokens\n\n```go\nfunc TestBucketRefill(t *testing.T) {\n\tclock := fakeClock{}\n\tb := NewBucket(10, time.Second, &clock)\n\tb.Take(10)\n\tclock.Advance(500 * time.Millisecond)\n\tif got := b.Tokens(); got != 5 {\n\t\tt.Fatalf(\"tokens = %d, want 5\", got)\n\t}\n}\n```",
      "Tests are in `bucket_test.go`. They use a fake clock, so nothing sleeps, and they cover refill, bursts and keys expiring after an hour of silence.",
    ],
  },
  {
    match: /redis/i, tool: ["Read", { file_path: "internal/server/server.go" }, "// The HTTP API…"],
    texts: [
      "With Redis, every instance shares one bucket per key. The check has to be atomic, so it runs as a Lua script:\n\n```lua\nlocal tokens = tonumber(redis.call('HGET', KEYS[1], 't') or ARGV[2])\n-- refill from the time since the last take, then try to take one\n```\n\nThe middleware calls it with `EVALSHA`; one round trip per request.",
      "Redis works if we accept one round trip per request. I'd keep a small local cache in front of it so a hot key doesn't hit Redis on every call.",
    ],
  },
  {
    match: /memory|in-memory|single/i,
    texts: [
      "In memory is simpler: a `map[string]*bucket` behind a mutex, and a goroutine that drops buckets idle for an hour.\n\n```go\ntype Limiter struct {\n\tmu      sync.Mutex\n\tbuckets map[string]*bucket\n}\n```\n\nIf we ever run two instances, each one limits on its own, so the real limit doubles.",
      "A `sync.Map` of buckets is enough for one instance. Restarting the server resets everyone's limits, which is fine at this size.",
    ],
  },
  {
    match: /compare|sliding|window/i,
    texts: [
      "| | Sliding window | Token bucket |\n|---|---|---|\n| Bursts | smoothed out | allowed up to `burst` |\n| Memory per key | a counter per window | two numbers |\n| Fairness at edges | good | good |\n\nFor bursty clients the token bucket is kinder: short bursts go through, a steady flood doesn't.",
    ],
  },
];

function fakeReply(text: string, n: number): { tool?: [string, unknown, string]; text: string } {
  const r = REPLIES.find((x) => x.match.test(text));
  if (r) return { tool: n ? undefined : r.tool, text: r.texts[n % r.texts.length] };
  const short = text.length > 60 ? text.slice(0, 57) + "…" : text;
  const generic = [
    `Here's how I'd go about “${short}”:\n\n1. **Start small**: get the simplest version working end to end.\n2. **Measure**: see where it actually hurts before tuning.\n3. **Write it down**: a short note in the README so the next person knows why.\n\n_Demo reply: no agent ran._`,
    `Short answer: yes, but keep it behind a flag until we've seen it on real traffic.\n\nThe longer answer depends on how many instances we run. Want me to sketch both?\n\n_Demo reply: no agent ran._`,
    `I'd pick the boring option here. It's easier to test and easier to undo, and nothing in “${short}” needs more yet.\n\n_Demo reply: no agent ran._`,
  ];
  const i = [...text].reduce((h, ch) => h + ch.charCodeAt(0), 0) + n;
  return { tool: i % 3 === 1 ? ["Read", { file_path: "README.md" }, "# AI Whiteboard…"] : undefined, text: generic[i % generic.length] };
}

function fakeSummary(t: ChatTree, left: string[], end: string | null, focus?: string): string {
  const es = left.map((id) => t.entries[id]).filter((e) => !e.summary);
  const asks = es.filter((e) => e.item.kind === "user").map((e) => `- You asked: “${preview(e, 80)}”`);
  const last = [...es].reverse().find((e) => e.item.kind === "text");
  return [
    `**From the branch “${branchName(t, end)}”**`,
    focus ? `_Summarized with: ${focus}_` : "",
    ...asks,
    last ? `- It ended with: ${preview(last, 140)}` : "",
    "_Demo summary: made up from the branch, not by an agent._",
  ].filter(Boolean).join("\n");
}

// ---- seed

function seeded(): Record<string, Demo> {
  const now = Date.now();
  const meta = (id: string, name: string, mins: number): ChatView => ({
    id, agent: "claude", name, userNamed: true, group: UNGROUPED, cwd: getState().defaultCwd || "/", model: "opus", effort: "high",
    locked: true, created: new Date(now - mins * 60000).toISOString(), usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, status: "ready",
  });
  let t = emptyTree();
  const add = (item: Item, extra: Partial<Pick<Entry, "summary" | "label">> = {}) => { let id: string; [t, id] = append(t, item, extra, now); return id; };
  const u = (text: string) => add({ kind: "user", text });
  const a = (text: string) => add({ kind: "text", text, done: true });
  u("We need rate limiting on the public API. What are our options?");
  const opts = a("Four common ones:\n\n1. **Fixed window**: count requests per minute. Simple, but lets through double at the window edge.\n2. **Sliding window**: smooths the edge, costs a bit more memory.\n3. **Token bucket**: allows short bursts, holds a steady rate.\n4. **Leaky bucket**: a queue; smooth output, adds latency.\n\nFor an API with bursty clients I'd go with a **token bucket**.");
  u("Go with token bucket. Where should it live?");
  const where = a("As middleware in `internal/server`, in front of every `/api/` route, keyed by API key:\n\n```go\nfunc RateLimit(l *Limiter) func(http.Handler) http.Handler {\n\treturn func(next http.Handler) http.Handler {\n\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\t\tif !l.Allow(apiKey(r)) {\n\t\t\t\thttp.Error(w, \"slow down\", http.StatusTooManyRequests)\n\t\t\t\treturn\n\t\t\t}\n\t\t\tnext.ServeHTTP(w, r)\n\t\t})\n\t}\n}\n```\n\nWhere the buckets are kept is the open question: in memory, or shared.");
  u("Keep the buckets in Redis so every instance shares them.");
  add({ kind: "tool", toolId: "seed1", name: "Read", input: { file_path: "internal/server/server.go" }, result: "// The HTTP API…" });
  a(REPLIES[1].texts[0]);
  u("Add per-API-key limits on top of the global one.");
  const redisEnd = a("Done: each key gets its own bucket (`rl:key:<id>`), and a global one (`rl:all`) guards the whole API. A request needs a token from both; the script takes them together so a refused request never spends one.");
  t = setLabel(t, redisEnd, "redis version");
  // back to "where should it live", with a summary of the Redis branch
  const left = [...t.order.slice(t.order.indexOf(where) + 1)];
  t = { ...t, leaf: where };
  add({ kind: "note", text: fakeSummary(t, left, redisEnd) }, { summary: { left: left.length, from: redisEnd } });
  u("Actually, keep it in memory: we only run one instance.");
  a(REPLIES[2].texts[0]);
  const memEnd = t.leaf;
  // an edit of "Go with token bucket…"
  t = { ...t, leaf: opts };
  u("Before choosing: compare sliding window and token bucket for bursty clients.");
  a(REPLIES[3].texts[0]);
  t = { ...t, leaf: memEnd };
  return {
    "demo-ratelimit": { meta: meta("demo-ratelimit", "Rate limiter (fork demo)", 1), tree: t },
    "demo-empty": { meta: meta("demo-empty", "Empty chat (fork demo)", 2), tree: emptyTree() },
  };
}

function load(): Record<string, Demo> | null {
  try {
    const v = JSON.parse(safeGet(KEY) ?? "null");
    if (!v || typeof v !== "object") return null;
    for (const d of Object.values(v) as Demo[]) {
      d.meta.status = "ready";
      for (const id of d.tree.order) {
        const it = d.tree.entries[id].item;
        if (it.kind === "text" && !it.done) it.done = true;
      }
    }
    return v;
  } catch { return null; }
}

/** Starts the demo over: the seeded chats, as they were. */
export function resetDemo() {
  for (const id of Object.keys(state.chats)) { stop(id); removeChat(id); }
  state = { chats: seeded(), nav: null };
  for (const d of Object.values(state.chats)) sync(d);
  save(); emit();
}

/** A new empty demo chat; returns its id. */
export function newDemoChat(): string {
  const id = "demo-" + Math.random().toString(36).slice(2, 8);
  const base = state.chats["demo-empty"]?.meta ?? Object.values(seeded())[1].meta;
  put({ meta: { ...base, id, name: "New chat (fork demo)", created: new Date().toISOString(), status: "ready", draft: undefined }, tree: emptyTree() });
  return id;
}

// ---- the api, for demo chats

export function initForkDemo() {
  state = { chats: load() ?? seeded(), nav: null };
  setExtraChats(() => Object.values(state.chats).map((d) => d.meta));
  for (const d of Object.values(state.chats)) sync(d);

  const orig = { ...api };
  const itemsOf = (id: string) => ({ version: ++version, items: thread(state.chats[id]?.tree ?? emptyTree()).map((e) => e.item), subagents: [] });
  api.send = (id, text, ctx) => (isDemo(id) ? send(id, text) : orig.send(id, text, ctx));
  api.openChat = (id) => (isDemo(id) ? Promise.resolve() : orig.openChat(id));
  api.items = (id) => (isDemo(id) ? Promise.resolve(itemsOf(id)) : orig.items(id));
  api.chat = (id) => (isDemo(id) ? Promise.resolve(state.chats[id].meta) : orig.chat(id));
  api.saveDraft = (id, d, k) => {
    if (!isDemo(id)) return orig.saveDraft(id, d, k);
    const x = state.chats[id];
    if (x) { state = { ...state, chats: { ...state.chats, [id]: { ...x, meta: { ...x.meta, draft: d.text ? d : undefined } } } }; save(); }
    return Promise.resolve();
  };
  api.renameChat = (id, name) => (isDemo(id) ? Promise.resolve(patch(id, (d) => ({ meta: { ...d.meta, name, userNamed: true } }))) : orig.renameChat(id, name));
  api.interrupt = (id) => (isDemo(id) ? Promise.resolve(stop(id)) : orig.interrupt(id));
  api.deleteChat = (id) => {
    if (!isDemo(id)) return orig.deleteChat(id);
    stop(id);
    const { [id]: _, ...chats } = state.chats;
    state = { ...state, chats, nav: state.nav?.chat === id ? null : state.nav };
    removeChat(id); save(); emit();
    return Promise.resolve();
  };
  api.archive = (k, id) => (k === "chats" && isDemo(id) ? Promise.resolve(patch(id, (d) => ({ meta: { ...d.meta, archived: true } }))) : orig.archive(k, id));
  api.unarchive = (k, id) => (k === "chats" && isDemo(id) ? Promise.resolve(patch(id, (d) => ({ meta: { ...d.meta, archived: undefined } }))) : orig.unarchive(k, id));
  api.contextSplit = (id, fresh) => (isDemo(id) ? Promise.reject(new Error("Demo chat: no agent session")) : orig.contextSplit(id, fresh));
}
