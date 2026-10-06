// The line to the server: SSE in (state, chat items, rpc calls), POSTs out
// through api.ts. The server lets one tab at a time be the active client; a
// newer tab takes over after this one has written its pending saves.
import { api, clientId } from "./api.ts";
import { setState, getState, applySnapshot, upsertBoard, removeBoard, upsertChat, removeChat, setThread, setSubs, upsertSub,
  upsertState, setDrawer, setShown, threadAt, shownBranch, shownKey, currentBranch, branchState, isBusy,
  onRunEvent, removeRun, type ThreadKey } from "./store.ts";
import { runTool, flushAll } from "./board.ts";
import { subKey } from "./logic/subagents.ts";
import { branchKey, keyOfChat, type BranchKey } from "./logic/branches.ts";
import { Loads } from "./logic/branchview.ts";
import { afterAnswer, answerStateTaken, applyUpdates, drawerStays, withoutChat, type Queued, type Update } from "./logic/threads.ts";
import { RunLoads, type RunFeedEvent } from "./logic/rundetail.ts";
import { normDetail, normPatch } from "./logic/runnorm.ts";
import { dropTexts } from "./run/texts.ts";
import { Holds } from "./logic/holds.ts";
import { checkMove, dropMoves, goBack, moveSent } from "./fork/actions.ts";
import { checkVersion } from "./version.ts";
import { patchTree, type TreePatch } from "./logic/treepatch.ts";
import type { BranchState, ChatView, Item, RunDetail, Subagent, TreeView } from "./types.ts";

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
    case "snapshot": applySnapshot(m, dropMoves()); afterSnapshot(); return; // the open composers end up as after Back; a move being sent stays
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
    case "chat_removed": removed.add(m.id); treeQueue.delete(m.id); treeLoads.delete(m.id); removeChat(m.id); return;
    case "branch_state": applyState(m.state); return; // before the `chat` event of the same change, and for any branch
    case "tree": applyTree(m); return; // after the `branch_state` and `chat` events of the same change
    case "chat_items": applyItems(m.chat, branchKey(m.chat, m.branch), m.version, m.updates ?? []); return;
    case "sub": return applySub(branchKey(m.chat, m.branch), m.subagent); // queued while its branch's list loads
    case "sub_items": applyItems(m.chat, subKey(branchKey(m.chat, m.branch), m.sub), m.version, m.updates ?? []); return;
    case "defaults": setState({ defaults: m.defaults }); return;
    case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } })); return;
  }
}

/** A fresh snapshot drops every thread, tree and run detail kept; the chat on screen gets its
 *  history and its tree again, the run on screen its detail, and the run agents that are held
 *  their view and thread. The tree fetches that run are of before it: their answers are not
 *  applied, and what was queued behind them is dropped. A tree fetch that fails is made once more
 *  a little later, when the chat is still the one on screen and no snapshot came since. */
function afterSnapshot() {
  treeLoads.clear();
  treeQueue.clear();
  if (treeRetry !== null) { clearTimeout(treeRetry); treeRetry = null; }
  const snap = ++snapshots;
  runLoads.reset(); runFetches.clear();
  const { chat, run } = getState().sel;
  const r = run ? getState().runs[run] : undefined;
  if (r?.started) void fetchRun(r.id);
  refreshAgents();
  if (!chat) return;
  void api.openChat(chat, shownBranch(getState(), chat)).catch(() => {});
  void loadItems(chat);
  void loadTree(chat, true).catch(() => {
    if (snap !== snapshots) return;
    treeRetry = setTimeout(() => {
      treeRetry = null;
      if (getState().sel.chat === chat && getState().chats[chat]) void loadTree(chat).catch(() => {});
    }, TREE_RETRY_MS);
  });
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

// ---- threads: a branch's list under branchKey(chat, branch), a subagent's under subKey(that,
// sid). A thread is fetched when its chat first shows the branch, and is kept from then on: the
// events of its branch are applied to it whatever branch the chat shows, until the next snapshot
// or the chat's removal. The events of a thread that is not loaded are dropped: it is fetched in
// full when wanted.

type Answer = { version: number; items: Item[]; subagents?: Subagent[]; branch?: string; state?: BranchState };
const pending = new Map<ThreadKey, Queued[]>();     // by thread key: what arrives while its fetch runs
const loads = new Loads();                          // by thread key: its newest fetch, whose answer is the one kept
const lists = new Map<BranchKey, Promise<void>>();  // by branch key: the fetch of its list that runs
const removed = new Set<string>();                  // the chats removed in this session: what still comes for one is dropped

function apply(key: ThreadKey, version: number, updates: Update[]) {
  const cur = threadAt(getState(), key), next = applyUpdates(cur, version, updates);
  if (next && next !== cur) setThread(key, next);
}

/** Applies item updates to the thread they are for, when it is loaded. A pending move is judged
 *  again when the list is the one its chat shows. */
function applyItems(chat: string, key: ThreadKey, version: number, updates: Update[]) {
  const buf = pending.get(key);
  if (buf) { buf.push({ version, updates }); return; }
  apply(key, version, updates);
  if (key === shownKey(getState(), chat)) checkMove(chat);
}

/** Sets a subagent's state on its branch, when the branch's list is loaded (the list's answer
 *  brings the subagents); while it loads, after it, so an older response never overwrites a
 *  newer state. */
function applySub(key: BranchKey, sa: Subagent) {
  if (!sa?.id) return;
  const buf = pending.get(key);
  if (buf) { buf.push({ sub: sa }); return; }
  if (threadAt(getState(), key)) upsertSub(key, sa);
}

/** Sets a branch's state, whatever is loaded and also for a chat not known yet (its view may
 *  come after its first state), but not for one that was removed: nothing would take the record
 *  away again. A list that is being fetched notes it: its answer's record may be older. No tree is
 *  fetched when the branch became busy or came to rest: a `tree` event follows with the branch's
 *  part as it is then. */
function applyState(st: BranchState | undefined) {
  if (!st?.chat || removed.has(st.chat)) return;
  upsertState(st);
  pending.get(branchKey(st.chat, st.branch))?.push({ state: st });
}

const subsById = (xs: Subagent[] | undefined): Record<string, Subagent> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

/** Ends a thread's fetch: what arrived meanwhile is applied, when the thread is loaded (the
 *  fetch may have failed, and the thread be one kept from before, or none). */
function flush(key: ThreadKey, list: BranchKey | null) {
  const buf = pending.get(key) ?? [];
  pending.delete(key);
  for (const u of buf) {
    if ("sub" in u) { if (list && threadAt(getState(), list)) upsertSub(list, u.sub); }
    else if ("updates" in u) apply(key, u.version, u.updates);
  }
}

/** Fetches a thread (a branch's list, or with sid the thread of one of its subagents) in full;
 *  what arrives for it meanwhile is applied after it. The branch is always asked for by its id,
 *  and the answer is kept under the key of the branch it names, also when the chat shows another
 *  one by then. A list's answer also brings the branch's subagents and its record. A fetch begun
 *  later takes the thread over: the answer of an older one is discarded, and so is the answer for
 *  a chat that is gone by then. replace: the answer replaces the list whatever its version. The
 *  first list of a chat that loads puts the chat on the server's current branch (setShown): from
 *  then on only this client changes the branch it is on. Rejects when the fetch fails. */
async function loadThread(chat: string, branch: string, sid?: string, o: { replace?: boolean } = {}): Promise<void> {
  const list = branchKey(chat, branch);
  const key: ThreadKey = sid ? subKey(list, sid) : list;
  const ticket = loads.begin(key);
  if (!pending.has(key)) pending.set(key, []);
  let r: Answer | undefined, failed: unknown;
  try {
    r = sid ? await api.subItems(chat, branch, sid) : await api.items(chat, branch);
    // A branch asked for by its id is the one served: an answer for another has no place, since
    // what arrived for that one meanwhile was not kept for it.
    if (r?.branch && branchKey(chat, r.branch) !== list) throw new Error(`asked for branch ${branch}, got ${r.branch}`);
  } catch (e) { failed = e ?? new Error("not loaded"); }
  if (!loads.current(key, ticket)) return sid ? undefined : lists.get(list); // a newer fetch has the thread
  if (!getState().chats[chat] && !agentHolds.has(chat)) { pending.delete(key); return; } // removed meanwhile (a run agent: let go): nothing of it is kept
  if (failed || !r) {
    flush(key, sid ? null : list);
    console.error(`loading thread ${key}:`, failed);
    throw failed ?? new Error("not loaded");
  }
  const cur = threadAt(getState(), key);
  const next = afterAnswer(cur, { version: r.version, items: r.items ?? [] }, o.replace);
  if (next !== cur) {
    setThread(key, next);
    if (!sid && (r.subagents !== undefined || o.replace)) setSubs(list, subsById(r.subagents));
  }
  const listed = !!getState().chats[chat]; // not a run agent's chat, which has main alone and no record: its view tells its state
  if (!sid && listed && r.state && answerStateTaken(pending.get(key) ?? [])) upsertState(r.state);
  if (!sid && listed && getState().shown[chat] === undefined) setShown(chat, currentBranch(getState().chats[chat]));
  flush(key, sid ? null : list);
  if (!sid && list === shownKey(getState(), chat)) checkMove(chat);
}

/** Fetches the list of a branch (the one its chat shows, when none is named), and keeps the fetch
 *  for who waits for the list. */
function loadList(chat: string, o?: { replace?: boolean }, branch = shownBranch(getState(), chat)): Promise<void> {
  const key = branchKey(chat, branch);
  const done: Promise<void> = loadThread(chat, branch, undefined, o).finally(() => { if (lists.get(key) === done) lists.delete(key); });
  lists.set(key, done);
  return done;
}

/** Fetches a chat's items and subagents: those of the branch it shows. One fetch at a time for a
 *  branch. */
export function loadItems(chat: string): Promise<void> {
  return (lists.get(shownKey(getState(), chat)) ?? loadList(chat)).catch(() => {});
}

/** Fetches the own thread of a subagent of the branch a chat shows. */
export const loadSubItems = (chat: string, sid: string): Promise<void> => loadThread(chat, shownBranch(getState(), chat), sid).catch(() => {});

/** Makes sure the list of a branch is kept, whatever branch its chat shows: who has to read a
 *  branch before showing it (a move's point is judged on its items) asks for it. From then on it
 *  is kept current as every loaded list. Rejects when its fetch fails. */
export function keepBranch(chat: string, branch: string): Promise<void> {
  const key = branchKey(chat, branch);
  if (threadAt(getState(), key)) return Promise.resolve();
  return lists.get(key) ?? loadList(chat, undefined, branch);
}

/** Makes sure a chat has the list of the branch it shows. Called whenever that branch may have
 *  changed: another branch is looked at, a move was set or cleared. The list is
 *  fetched only when it is not kept; the list of the branch left stays, and so do its subagents
 *  and their threads. The drawer on a subagent of another branch is closed. A chat that is
 *  neither open nor has a move is fetched when it is opened. Resolves when the list is there;
 *  rejects when its fetch fails. */
export function showBranch(chat: string): Promise<void> {
  const s = getState();
  const key = shownKey(s, chat);
  if (!drawerStays(s.subDrawer, chat, shownBranch(s, chat))) setDrawer(chat, null);
  if (threadAt(s, key)) return Promise.resolve();
  return lists.get(key) ?? (s.sel.chat === chat || s.moves[chat] ? loadList(chat) : Promise.resolve());
}

/** A chat's view from the server. Its pending move is dropped when the chat was archived, and
 *  stays when it became busy (a turn the app started for a subagent's result). Another current
 *  branch is not followed: the chat stays on the branch it is on here, and only a chat whose list
 *  never loaded (it is on no branch yet) shows the new current one. No tree is fetched when a Send
 *  made a branch or changed the current one: a `tree` event follows with the branch and the
 *  current one. */
function onChat(c: ChatView) {
  const was = getState().chats[c.id];
  removed.delete(c.id);
  upsertChat(c);
  const moved = currentBranch(was) !== currentBranch(c);
  moveSent(c.id);
  checkMove(c.id);
  if (moved && getState().shown[c.id] === undefined) void showBranch(c.id).catch(() => {});
}

// ---- trees: a chat's tree is fetched once, when something first shows it, and is kept current
// from then on by the `tree` events, until the next snapshot or the chat's removal. The events of
// a chat whose tree is not kept are dropped: it is fetched in full when wanted, and for the chat on
// screen such an event starts that fetch (its tree is wanted: an earlier fetch of it failed).

const TREE_RETRY_MS = 2000;
let snapshots = 0;                                                             // the snapshots taken: a retry is of its own snapshot only
let treeRetry: ReturnType<typeof setTimeout> | null = null;                    // the retry that waits, of the newest snapshot's failed fetch
let treeTicket = 0;                                                            // one for all chats: no two fetches share a ticket, also across a snapshot
const treeLoads = new Map<string, { ticket: number; done: Promise<void> }>();  // by chat id: the fetch of its tree that runs
const treeQueue = new Map<string, TreePatch[]>();                              // by chat id: what arrives while its fetch runs

/** Applies a `tree` event to the chat's kept tree; while the tree is fetched, after the answer.
 *  A part older than the answer does no harm there: it is equal to the answer, or a newer part
 *  of the same branch is behind it in the stream. With no tree kept and none being fetched, the
 *  event is dropped, and for the chat on screen the tree is fetched: its answer has the event's
 *  change. */
function applyTree(m: { chat?: string } & TreePatch) {
  const chat = m.chat;
  if (!chat || removed.has(chat)) return;
  const p: TreePatch = { branch: m.branch ?? undefined, labels: m.labels ?? undefined, current: m.current ?? undefined };
  const buf = treeQueue.get(chat);
  if (buf) { buf.push(p); return; }
  const s = getState();
  if (!s.trees[chat]) {
    if (s.sel.chat === chat && s.chats[chat] && !treeLoads.has(chat)) void loadTree(chat).catch(() => {});
    return;
  }
  setState((s) => (s.trees[chat] ? { trees: { ...s.trees, [chat]: patchTree(s.trees[chat], p) } } : {}));
}

/** Makes sure a chat's tree is kept in State.trees: resolves at once when it is, and fetches it
 *  otherwise, or in any case with force. One fetch runs per chat at a time: who asks meanwhile
 *  gets the one that runs. Rejects when the fetch fails. */
export function loadTree(chat: string, force = false): Promise<void> {
  if (!force && getState().trees[chat]) return Promise.resolve();
  const running = treeLoads.get(chat);
  if (running) return running.done;
  const ticket = ++treeTicket;
  treeQueue.set(chat, []); // before the request is made: nothing that comes after the answer was built is lost
  const done = fetchTree(chat, ticket);
  treeLoads.set(chat, { ticket, done });
  return done;
}

/** One fetch of a chat's tree. Its answer, then what arrived meanwhile, is kept when the fetch is
 *  still the chat's (no snapshot and no removal since). When it fails, what arrived meanwhile is
 *  applied to the tree kept from before, if any. */
async function fetchTree(chat: string, ticket: number) {
  let tree: TreeView | undefined, err: unknown;
  try { tree = await api.tree(chat); } catch (e) { err = e; }
  if (treeLoads.get(chat)?.ticket === ticket) {
    const buf = treeQueue.get(chat) ?? [];
    treeLoads.delete(chat);
    treeQueue.delete(chat);
    setState((s) => {
      const base = tree ?? s.trees[chat];
      return base && s.chats[chat] ? { trees: { ...s.trees, [chat]: buf.reduce(patchTree, base) } } : {};
    });
  }
  if (!tree) throw err;
}

/** Replaces a chat, and the items and subagents of the branch it shows, with the server's (after
 *  a refused Send; code: the refusal's). Only `busy` can drop a pending move, which is then judged
 *  by the branch shown, its source, alone, once that branch's record is here with its list: while
 *  the source is busy the move stays (the refusal said that a turn runs: Send waits for its end),
 *  and when it is at rest the move is dropped, and the list is then the one of the branch the chat
 *  is on. What other branches do drops nothing, and neither does `cap` (too many turns run), any
 *  other code, or a refusal without one (the folder is missing, the chat is locked or not active):
 *  the move can be sent later as it is. An archived chat's move goes by checkMove. */
export async function refreshChat(chat: string, code?: string) {
  try { onChat(await api.chat(chat)); } catch {}
  try { await loadList(chat, { replace: true }); } catch {}
  const s = getState(), was = shownKey(s, chat);
  if (code !== "busy" || !s.moves[chat] || isBusy(branchState(s, chat, shownBranch(s, chat))?.status)) return;
  goBack(chat); // the composer holds again what the refused Send took out
  if (shownKey(getState(), chat) !== was) try { await loadList(chat, { replace: true }); } catch {}
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
// its thread in State.items under its main branch's key) only while a view holds it to show its
// transcript.

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
  for (const k of [...pending.keys()]) if (keyOfChat(k, chat)) { pending.delete(k); loads.begin(k); }
  const list = branchKey(chat);
  loads.begin(list); lists.delete(list);
  setState((s) => ({ items: withoutChat(s.items, chat), subs: withoutChat(s.subs, chat), subDrawer: s.subDrawer?.chat === chat ? null : s.subDrawer }));
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
  if (!threadAt(getState(), branchKey(id))) void loadItems(id);
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
