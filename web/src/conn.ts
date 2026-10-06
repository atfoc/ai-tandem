// The line to the server: SSE in (state, chat items, rpc calls), POSTs out
// through api.ts. The server lets one tab at a time be the active client; a
// newer tab takes over after this one has written its pending saves.
import { api, clientId } from "./api.ts";
import { setState, getState, applySnapshot, upsertBoard, removeBoard, upsertChat, removeChat, upsertSub, dropThread,
  onRunEvent, removeRun, shownBranch, currentBranch, branchCount, isBusy } from "./store.ts";
import { runTool, flushAll } from "./board.ts";
import { subKey } from "./logic/subagents.ts";
import { appliesTo, Loads } from "./logic/branchview.ts";
import { RunLoads, type RunFeedEvent } from "./logic/rundetail.ts";
import { normDetail, normPatch } from "./logic/runnorm.ts";
import { dropTexts } from "./run/texts.ts";
import { Holds } from "./logic/holds.ts";
import { checkMove, dropMoves, goBack, moveSent } from "./fork/actions.ts";
import { checkVersion } from "./version.ts";
import type { ChatView, Item, RunDetail, Subagent } from "./types.ts";

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
    case "snapshot": dropMoves(); applySnapshot(m); afterSnapshot(); return; // the open composers end up as after Back
    case "release_request": await flushAll(); await api.release().catch(() => {}); return;
    case "superseded": src.close(); es = null; setState({ role: "superseded" }); return; // TakeoverScreen
    case "server_stopping": await flushAll(); await api.flushed().catch(() => {}); return;
    case "rpc": return answer(m);
    case "groups": setState({ groups: m.groups ?? [] }); return;
    case "board": upsertBoard(m.board); return;
    case "board_removed": removeBoard(m.id); return;
    case "run": if (m.run?.id) onRunEvent(m.run); return;
    case "run_removed": onRunRemoved(m.id); return;
    case "run_detail": onRunFeed(m.run, { version: m.version, patch: normPatch(m.patch, getState().runDetail[m.run]?.startedAt) }); return;
    case "run_activity": onRunFeed(m.run, { agents: m.agents ?? {} }); return;
    case "chat": if (m.chat?.role) onAgent(m.chat); else onChat(m.chat); return; // a run's own agent is kept only while held
    case "chat_removed": removeChat(m.id); return;
    case "chat_items": applyItems(m.chat, m.chat, m.branch, m.version, m.updates ?? []); return;
    case "sub": return applySub(m.chat, m.branch, m.subagent); // queued while the chat's items load
    case "sub_items": applyItems(m.chat, subKey(m.chat, m.sub), m.branch, m.version, m.updates ?? []); return;
    case "defaults": setState({ defaults: m.defaults }); return;
    case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } })); return;
  }
}

/** A fresh snapshot drops cached items and run details; the chat on screen gets its history
 *  again, the run on screen its detail, and the run agents that are held their view and thread. */
function afterSnapshot() {
  listBranch.clear();
  runLoads.reset(); runFetches.clear();
  const { chat, run } = getState().sel;
  if (chat) { void api.openChat(chat).catch(() => {}); void loadItems(chat); void loadTree(chat).catch(() => {}); }
  const r = run ? getState().runs[run] : undefined;
  if (r?.started) void fetchRun(r.id);
  refreshAgents();
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

// ---- threads: a chat's items under its id, a subagent's under subKey(chat, sid). Both are those
// of the branch the chat shows: its pending move's, else the current one.

type Update = { index: number; item: Item };
type Queued = { branch?: string } & ({ version: number; updates: Update[] } | { sub: Subagent });
type Answer = { version: number; items: Item[]; subagents?: Subagent[]; branch?: string };
const pending = new Map<string, Queued[]>(); // by thread key: what arrives while its fetch runs
const loads = new Loads();                   // by thread key: its newest fetch, whose answer is the one kept
const lists = new Map<string, { branch: string; done: Promise<void> }>(); // by chat id: the fetch of its list that runs, and the branch it is for
const listBranch = new Map<string, string>(); // by chat id: the branch of the list it has, or had until it was dropped for another

function apply(key: string, version: number, updates: Update[]) {
  setState((s) => {
    const cur = s.items[key];
    if (!cur || version <= cur.version) return {};
    const items = cur.items.slice();
    for (const u of updates) items[u.index] = u.item;
    return { items: { ...s.items, [key]: { version, items } } };
  });
}

/** Applies a branch's item updates to a thread that is loaded, when its chat shows that branch;
 *  others are fetched in full when wanted. */
export function applyItems(chat: string, key: string, branch: string | undefined, version: number, updates: Update[]) {
  const buf = pending.get(key);
  if (buf) { buf.push({ branch, version, updates }); return; }
  if (!appliesTo(shownBranch(getState(), chat), branch)) return;
  apply(key, version, updates);
  if (key === chat) checkMove(chat);
}

/** Sets a subagent's state; while its chat's items load, after them, so an older response never
 *  overwrites a newer state. */
function applySub(chat: string, branch: string | undefined, sa: Subagent) {
  if (!sa?.id) return;
  const buf = pending.get(chat);
  if (buf) { buf.push({ branch, sub: sa }); return; }
  if (!getState().chats[chat] && !agentHolds.has(chat)) return; // a run agent nobody looks at: its list brings its subagents when it is opened
  if (appliesTo(shownBranch(getState(), chat), branch)) upsertSub(chat, sa);
}

const subsById = (xs: Subagent[] | undefined): Record<string, Subagent> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

/** Ends a thread's fetch: what arrived meanwhile for the branch its chat shows is applied. */
function flush(chat: string, key: string) {
  const buf = pending.get(key) ?? [];
  pending.delete(key);
  const shown = shownBranch(getState(), chat);
  for (const u of buf) {
    if (!appliesTo(shown, u.branch)) continue;
    if ("sub" in u) upsertSub(chat, u.sub);
    else apply(key, u.version, u.updates);
  }
}

/** Fetches a thread (a chat's, or with sid a subagent's) of the branch the chat shows, in full;
 *  what arrives for it meanwhile is applied after it. A chat's response also brings its
 *  subagents. A fetch begun later takes the thread over: the answer of an older one is
 *  discarded, and so is an answer for a branch the chat no longer shows. named: ask for the
 *  branch by its id also when it is the current one. replace: the answer replaces the list
 *  whatever its version. Rejects when the fetch fails. */
async function loadThread(chat: string, sid?: string, o: { named?: boolean; replace?: boolean } = {}): Promise<void> {
  const key = sid ? subKey(chat, sid) : chat;
  const s = getState();
  const shown = shownBranch(s, chat);
  const ask = o.named || shown !== currentBranch(s.chats[chat]) ? shown : undefined;
  const ticket = loads.begin(key);
  if (!pending.has(key)) pending.set(key, []);
  let r: Answer | undefined, failed: unknown;
  try {
    r = sid ? await api.subItems(chat, sid, ask) : await api.items(chat, ask);
  } catch (e) { failed = e ?? new Error("not loaded"); }
  if (!loads.current(key, ticket)) return sid ? undefined : lists.get(chat)?.done; // a newer fetch has the thread
  if (failed) {
    flush(chat, key);
    console.error(`loading thread ${key}:`, failed);
    throw failed;
  }
  const branch = r?.branch ?? shown;
  if (r && branch !== shownBranch(getState(), chat)) {
    if (!sid) return loadList(chat, { ...o, named: true }); // by its id: the server's current branch may be ahead of the view
    r = undefined; // a subagent's thread is asked for again by its row
  }
  if (r) {
    const got = r;
    if (!sid && getState().items[chat] && listBranch.get(chat) !== branch) dropThread(chat); // versions of two branches do not compare
    setState((s) => {
      const cur = s.items[key];
      if (cur && cur.version >= got.version && !o.replace) return {};
      const items = { ...s.items, [key]: { version: got.version, items: got.items ?? [] } };
      return !sid && (got.subagents !== undefined || o.replace) ? { items, subs: { ...s.subs, [chat]: subsById(got.subagents) } } : { items };
    });
    if (!sid) listBranch.set(chat, branch);
  }
  flush(chat, key);
  if (!sid) checkMove(chat);
}

/** Fetches the list of the branch a chat shows, and keeps the fetch for who waits for the list. */
function loadList(chat: string, o?: { named?: boolean; replace?: boolean }): Promise<void> {
  const branch = shownBranch(getState(), chat);
  const done: Promise<void> = loadThread(chat, undefined, o).finally(() => { if (lists.get(chat)?.done === done) lists.delete(chat); });
  lists.set(chat, { branch, done });
  return done;
}

/** Fetches a chat's items and subagents: those of the branch it shows. One fetch at a time for a
 *  branch. */
export function loadItems(chat: string): Promise<void> {
  const running = lists.get(chat);
  return (running?.branch === shownBranch(getState(), chat) ? running.done : loadList(chat)).catch(() => {});
}

/** Fetches a subagent's own thread. */
export const loadSubItems = (chat: string, sid: string): Promise<void> => loadThread(chat, sid).catch(() => {});

/** Makes a chat's list the one of the branch it shows. Called whenever that branch may have
 *  changed: the view names another current branch, a move was set or cleared. A list of another
 *  branch is dropped, with its subagents, their threads and the drawer on them, and the branch
 *  shown is fetched: a branch's versions start at 0, so nothing of the list left may stay.
 *  Resolves when the list is there; rejects when its fetch fails. */
export function showBranch(chat: string): Promise<void> {
  const s = getState();
  const shown = shownBranch(s, chat);
  if (s.items[chat]) {
    if (listBranch.get(chat) === shown) return Promise.resolve();
    dropThread(chat);
    return loadList(chat);
  }
  const running = lists.get(chat);
  if (running?.branch === shown) return running.done;
  // No list: a fetch for another branch is replaced, and a list that was dropped is fetched (the
  // fetch after the drop failed). A chat that was never opened is fetched when it is opened, but
  // a move needs its list now.
  return running || listBranch.has(chat) || s.moves[chat] ? loadList(chat) : Promise.resolve();
}

/** A chat's view from the server. Its pending move is dropped when the chat was archived, and
 *  stays when it became busy (a turn the app started for a subagent's result); another current
 *  branch is shown, and for the selected chat the tree is fetched again: a Send made a branch or
 *  changed the current one, and the tree reaches the client no other way. */
function onChat(c: ChatView) {
  const was = getState().chats[c.id];
  upsertChat(c);
  const moved = currentBranch(was) !== currentBranch(c);
  moveSent(c.id, true);
  checkMove(c.id);
  if (moved) void showBranch(c.id).catch(() => {});
  if ((moved || branchCount(was) !== branchCount(c)) && getState().sel.chat === c.id) void loadTree(c.id).catch(() => {});
}

const treeSeq = new Map<string, number>(); // by chat id: its newest loadTree call, whose answer is the one kept

/** Fetches a chat's tree into State.trees; rejects when the fetch fails. */
export async function loadTree(chat: string): Promise<void> {
  const seq = (treeSeq.get(chat) ?? 0) + 1;
  treeSeq.set(chat, seq);
  const tree = await api.tree(chat);
  if (treeSeq.get(chat) !== seq) return;
  setState((s) => (s.chats[chat] ? { trees: { ...s.trees, [chat]: tree } } : {}));
}

/** Replaces a chat, its items and its subagents with the server's (after a stale 409). A pending
 *  move is dropped, and the list is the current branch's; a chat that is busy keeps its move as
 *  everywhere else (the 409 said that a turn runs: Send waits for its end), and the list is the
 *  move's. */
export async function refreshChat(chat: string) {
  try { onChat(await api.chat(chat)); } catch {}
  // after the view's fetch: the composer holds again what the refused Send took out
  if (!isBusy(getState().chats[chat]?.status)) goBack(chat);
  try { await loadList(chat, { replace: true }); } catch {}
}

// ---- runs: the detail of the run on screen (State.runDetail), kept current by `run_detail` and
// `run_activity` events. One run's detail at a time: select() drops the one it leaves.

const runLoads = new RunLoads();                       // the fetches, and what arrives while one runs
const runFetches = new Map<string, Promise<void>>();   // by run id: the fetch that runs, for who waits for the detail
const runAborts = new Map<string, AbortController>();   // by run id: the way to end the fetch that runs
const runErrors = new Map<string, string>();           // by run id: what the last fetch of its detail failed with

/** Why the last fetch of a run's detail failed, in the server's words; "" when it did not fail. */
export const runLoadError = (run: string): string => runErrors.get(run) ?? "";

const setRunDetail = (run: string, d: RunDetail) => setState((s) => (s.runs[run] ? { runDetail: { ...s.runDetail, [run]: d } } : {}));
const clearRunDetail = (run: string) => setState((s) => {
  if (!s.runDetail[run]) return {};
  const { [run]: _, ...runDetail } = s.runDetail;
  return { runDetail };
});

/** A `run_detail` or `run_activity` event: applied to a detail that is loaded, queued while it is
 *  fetched, dropped otherwise. A version that is not the next one means an event was lost: the
 *  detail is dropped and fetched again (there is no replay). */
function onRunFeed(run: string, ev: RunFeedEvent) {
  const cur = getState().runDetail[run];
  const r = runLoads.event(run, cur, ev);
  if (r === "queued" || r === "ignored" || r === cur) return;
  if (r === "gap") { clearRunDetail(run); void fetchRun(run); return; }
  setRunDetail(run, r);
}

/** Fetches a run's detail in full; what arrives for it meanwhile is applied after it by the rule
 *  above. A fetch begun later takes the run over. */
function fetchRun(run: string): Promise<void> {
  const ticket = runLoads.begin(run);
  runAborts.get(run)?.abort(); // a fetch begun earlier is superseded: its answer is not needed
  const ctl = new AbortController();
  runAborts.set(run, ctl);
  const done: Promise<void> = (async () => {
    let got: RunDetail | undefined;
    try { got = normDetail(await api.runDetail(run, ctl.signal)); runErrors.delete(run); }
    catch (e) { if (!ctl.signal.aborted) { console.error(`loading run ${run}:`, e); runErrors.set(run, e instanceof Error && e.message ? e.message : String(e)); } }
    if (runAborts.get(run) === ctl) runAborts.delete(run);
    const r = runLoads.end(run, ticket, got);
    if (r === "superseded") return runFetches.get(run); // the newer fetch has the run
    if (r === "gap") return fetchRun(run);              // the events queued start past the answer
    if (r !== "failed") setRunDetail(run, r);
  })().finally(() => { if (runFetches.get(run) === done) runFetches.delete(run); });
  runFetches.set(run, done);
  return done;
}

/** Loads a started run's detail into State.runDetail and keeps it current; one fetch at a time
 *  for a run. Resolves when the fetch ended and never rejects: after a failed one the detail is
 *  still absent, and the caller may call again. */
export function loadRun(run: string): Promise<void> {
  if (getState().runDetail[run]) return Promise.resolve();
  return runFetches.get(run) ?? fetchRun(run);
}

/** Forgets a run's detail (another item was opened): a fetch that runs is discarded, and the run's
 *  events are dropped from here on. */
export function dropRun(run: string) {
  runLoads.drop(run);
  runFetches.delete(run);
  runErrors.delete(run);
  runAborts.get(run)?.abort(); runAborts.delete(run); // the answer is not waited for: the next run's detail is
  dropTexts(run);
  clearRunDetail(run);
}

/** `run_removed`: the run goes with its detail and with its agents that were held. */
function onRunRemoved(run: string) {
  for (const a of Object.values(getState().agents)) if (a.run === run) forgetThread(a.id);
  runLoads.drop(run);
  runFetches.delete(run);
  runErrors.delete(run);
  runAborts.get(run)?.abort(); runAborts.delete(run);
  dropTexts(run);
  removeRun(run);
}

// ---- run agents: chat-shaped records that are in no list. One is kept (its view in State.agents,
// its thread in State.items) only while a view holds it to show its transcript.

const LINGER_MS = 5000; // how long an agent is kept after its last view let go: a swap with its subagent, a tab change
const agentHolds = new Holds(LINGER_MS, dropAgent);
const agentViews = new Map<string, ChatView[]>(); // by agent chat id: the `chat` events that arrive while its view is fetched

/** A run agent's view from the server: kept only while the agent is held. */
function onAgent(c: ChatView) {
  if (!agentHolds.has(c.id)) return;
  const buf = agentViews.get(c.id);
  if (buf) { buf.push(c); return; }
  setState((s) => ({ agents: { ...s.agents, [c.id]: c } }));
}

/** Fetches a held agent's view; a `chat` event that arrived meanwhile is newer and wins. */
async function fetchAgent(id: string) {
  if (agentViews.has(id)) return; // its fetch runs
  agentViews.set(id, []);
  let v: ChatView | undefined;
  let why = "";
  try { v = await api.chat(id); } catch (e) { console.error(`loading agent ${id}:`, e); why = e instanceof Error && e.message ? e.message : String(e); }
  const buf = agentViews.get(id) ?? [];
  agentViews.delete(id);
  if (!agentHolds.has(id)) return; // let go meanwhile
  const last = buf.at(-1) ?? v;
  if (last) setState((s) => ({ agents: { ...s.agents, [id]: last }, agentErrors: without(s.agentErrors, id) }));
  else setState((s) => ({ agentErrors: { ...s.agentErrors, [id]: why || "the server did not answer" } })); // the view says so, with a way to try again
}

/** Forgets a thread and everything fetched or queued for it: its items, its subagents and their
 *  threads. A fetch of it that runs is discarded when it answers. */
function forgetThread(chat: string) {
  for (const k of [...pending.keys()]) if (k === chat || k.startsWith(chat + "/")) { pending.delete(k); loads.begin(k); }
  loads.begin(chat); lists.delete(chat); listBranch.delete(chat);
  dropThread(chat);
}

/** The linger after an agent's last release passed: its view and its thread go. */
function dropAgent(id: string) {
  agentViews.delete(id);
  forgetThread(id);
  setState((s) => {
    const agentErrors = without(s.agentErrors, id);
    if (!s.agents[id]) return { agentErrors };
    const { [id]: _, ...agents } = s.agents;
    return { agents, agentErrors };
  });
}

/** Holds a run agent while a view shows its transcript: its view (State.agents) and its thread
 *  (State.items, with its subagents) are fetched and kept current. Returns the release; a few
 *  seconds after the last one the agent is dropped, so the 60 to 100 agents of a long run never
 *  pile up in memory. */
export function holdAgent(id: string): () => void {
  const { release } = agentHolds.hold(id);
  if (!getState().agents[id]) void fetchAgent(id);
  if (!getState().items[id]) void loadItems(id);
  return release;
}

/** A held agent whose view could not be fetched is asked for again. */
export function retryAgent(id: string) {
  setState((s) => ({ agentErrors: without(s.agentErrors, id) }));
  if (!agentHolds.has(id)) return;
  void fetchAgent(id); void loadItems(id);
}

const without = (m: Record<string, string>, id: string): Record<string, string> => {
  if (!(id in m)) return m;
  const { [id]: _, ...rest } = m;
  return rest;
};

/** After a snapshot (it dropped every thread): the view and the thread of each agent that is held
 *  or lingers, again. */
function refreshAgents() {
  for (const id of agentHolds.ids()) { void fetchAgent(id); void loadItems(id); }
}
