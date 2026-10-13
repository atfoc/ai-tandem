// The line to the server: SSE in (state, chat items, rpc calls), POSTs out
// through api.ts. Several tabs work on one server at once; each board is held
// by one of them, which hands it over after it has written its pending save
// (board.ts keeps the roles).
import { api, clientId } from "./api.ts";
import { setState, getState, applySnapshot, applySection, dropLeftBehind, dropServer, markGone, setSectionGroups, setSectionDefaults, setServers, upsertBoard, removeBoard, upsertChat, removeChat, setThread, setSubs, upsertSub,
  upsertState, setDrawer, setShown, setThreadError, setLoading, dropLoading, threadAt, shownBranch, shownKey, currentBranch, branchState, isBusy,
  type ThreadKey } from "./store.ts";
import { runTool, flushAll, boardLost, granted, handOver, streamOpened, takeAfterSnapshot, sectionBack as boardSectionBack } from "./board.ts";
import { subKey } from "./logic/subagents.ts";
import { branchKey, keyOfChat, type BranchKey } from "./logic/branches.ts";
import { Loads } from "./logic/branchview.ts";
import { afterAnswer, answerStateTaken, applyUpdates, drawerStays, withoutChat, type Queued, type Update } from "./logic/threads.ts";
import { checkMove, dropMoves, goBack, moveSent } from "./fork/actions.ts";
import { checkVersion } from "./version.ts";
import { patchTree, type TreePatch } from "./logic/treepatch.ts";
import { LOCAL_SERVER, type BranchState, type ChatView, type Item, type SectionTree, type Subagent, type TreeView } from "./types.ts";
import { LOCAL_ENTRY, upsertServer, type ServerView } from "./logic/servers.ts";
import { removeLibrary, upsertLibrary } from "./logic/library.ts";
import { onUnknownClient, streamGone } from "./logic/unknownclient.ts";
import { sectionBack, threadError, withLists, withoutThread } from "./logic/serverlists.ts";
import { draftBacks } from "./logic/draftsback.ts";
import { inSection, keyOn, serverOfKey } from "./logic/keys.ts";
import { boardIn, chatIn, groupIn, stateIn, toolCallIn } from "./logic/sectionwire.ts";
import { entriesGone, onScreen } from "./logic/sections.ts";
import { NOT_FOUND } from "./logic/remoteview.ts";

let es: EventSource | null = null;

export function connect() {
  es?.close();
  setState({ role: "connecting" });
  const src = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
  es = src;
  src.onerror = () => { if (es === src) setState({ connected: false }); }; // EventSource reconnects by itself, unless the browser gave it up: see onUnknownClient below
  src.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    void handle(m, src);
  };
}

// A write was refused as `unknown_client`: the server has no stream of this page. One the browser
// closed for good is opened again; one that is open or reconnecting is left to the browser.
onUnknownClient(() => { if (streamGone(es)) connect(); });

/** The events that are about a thing: with a top-level `server` (an entry id of the server list) the thing is of that
 *  section, and every id in the event is that server's own; without it the thing is this computer's. In `server_state`,
 *  `server_lists`, `library_removed` and `section` the field is the event's own subject. */
const OF_A_THING = new Set(["groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state", "tree", "chat_items", "sub",
  "sub_items", "held", "release_request", "superseded", "rpc"]);

async function handle(m: any, src: EventSource) {
  if (es !== src) return;
  // on: the section the event's thing is of ("": this computer). The local server sends an event with `server` only
  // while it holds that entry's tree: one that names an entry this page has no tree of is dropped.
  const on: string = OF_A_THING.has(m.type) && typeof m.server === "string" ? m.server : "";
  if (on && !getState().sections[on]) return;
  const key = (id: string) => keyOn(on, id);
  switch (m.type) {
    case "hello": streamOpened(); setState({ connected: true, role: "active" }); void checkVersion(); draftBacks.opened(); return; // a new stream holds no board; a draft that could not be saved without one is saved
    case "snapshot": onSnapshot(m); return;
    case "section": if (typeof m.server === "string" && m.server) onSection(m.server, m.tree ?? null); return; // a server's whole tree as it is now, or none: it takes the place of what the page had for the entry
    case "release_request": if (m.board) await handOver(key(m.board)); return; // another window asks for one board
    case "superseded": if (m.board) boardLost(key(m.board)); return; // that board's canvas gives way to the panel (TakeoverPanel); the stream stays
    case "held": if (m.board) granted(key(m.board), m.rev ?? 0); return; // a board handed over to this window, or given to it for a tool call; for a board of a section also after its server is back
    case "server_stopping": await flushAll(); await api.flushed().catch(() => {}); return;
    case "rpc": return answer(on ? { ...m, params: toolCallIn(on, m.params) } : m);
    case "groups": if (on) setSectionGroups(on, (m.groups ?? []).map((g: any) => groupIn(on, g))); else setState({ groups: m.groups ?? [] }); return;
    case "board": if (m.board?.id) upsertBoard(boardIn(on, m.board)); return;
    case "board_removed": if (m.id) onBoardRemoved(key(m.id)); return;
    case "servers": { const before = getState().servers; setServers(m.servers ?? [LOCAL_ENTRY], m.notice ?? ""); dropRemoved(before); return; } // an entry that left the list takes what is open of its server with it
    case "server_state": setState((s) => ({ servers: upsertServer(s.servers, m.server) })); return;
    case "library": if (m.library?.server) setState((s) => ({ libraries: upsertLibrary(s.libraries, m.library) })); return; // one library, whole, after every change of it
    case "library_removed": if (m.server) setState((s) => ({ libraries: removeLibrary(s.libraries, m.server) })); return; // its server left the server list
    case "chat": if (m.chat?.id) { const c = chatIn(on, m.chat); if (!c.run) onChat(c); } return; // (a server that still has runs: their chats are not kept)
    case "chat_removed": if (m.id) onChatRemoved(key(m.id)); return;
    case "branch_state": if (m.state?.chat) applyState(stateIn(on, m.state)); return; // before the `chat` event of the same change, and for any branch
    case "tree": if (m.chat) applyTree({ ...m, chat: key(m.chat) }); return; // after the `branch_state` and `chat` events of the same change
    case "chat_items": if (m.chat) { const chat = key(m.chat); applyItems(chat, branchKey(chat, m.branch), m.version, m.updates ?? []); } return;
    case "sub": if (m.chat) return applySub(branchKey(key(m.chat), m.branch), m.subagent); return; // queued while its branch's list loads
    case "sub_items": if (m.chat) { const chat = key(m.chat); applyItems(chat, subKey(branchKey(chat, m.branch), m.sub), m.version, m.updates ?? []); } return;
    case "defaults": if (on) setSectionDefaults(on, m.defaults ?? { groups: {} }); else setState({ defaults: m.defaults }); return;
    case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } })); return;
    case "agents": setState({ usable: m.agents ?? [] }); return; // the local server's usable agents changed
    case "server_lists": if (m.server) setState((s) => ({ lists: withLists(s.lists, m.server, m.lists) })); return; // what another server offers; null: its entry is gone
  }
}

/** A snapshot: this computer's own part first (the open composers end up as after Back; a move being sent stays), then
 *  each section the snapshot or the page names, with its tree or with none; then the drafts kept of the composers that
 *  are not open are saved. */
function onSnapshot(m: any) {
  const had = Object.keys(getState().sections), listed = getState().servers;
  applySnapshot(m, dropMoves());
  afterSnapshot();
  const trees: Record<string, SectionTree> = m.sections && typeof m.sections === "object" ? m.sections : {};
  for (const server of new Set([...had, ...Object.keys(trees)])) onSection(server, trees[server] ?? null);
  dropRemoved(listed); // (an entry that left the list while the stream was down)
  draftBacks.snapshot();
}

/** A fresh snapshot drops every thread and tree kept of this computer's things; the chat on screen gets its history
 *  and its tree again. The tree fetches that run are of before it: their answers are not applied, and what was
 *  queued behind them is dropped. A tree fetch that fails is made once more a little later, when the chat is still the
 *  one on screen and no snapshot came since. What is on screen of a section is read again when that section's tree
 *  arrives (onSection), and is left as it is while there is none. */
function afterSnapshot() {
  treeLoads.clear();
  treeQueue.clear();
  if (treeRetry !== null) { clearTimeout(treeRetry); treeRetry = null; }
  const snap = ++snapshots;
  stale.clear(); // the snapshot dropped every thread of this computer's; a section's are judged anew when its tree follows
  const { chat } = getState().sel;
  takeAfterSnapshot(); // the board on screen and those with an unsaved edit, if no other window holds them
  if (!chat || inSection(chat)) return;
  void api.openChat(chat, shownBranch(getState(), chat)).catch(() => {});
  void loadList(chat).catch(() => {}); // a new fetch, and not one that runs: a read made while the stream was down started no follow
  void loadTree(chat, true).catch(() => {
    if (snap !== snapshots) return;
    treeRetry = setTimeout(() => {
      treeRetry = null;
      if (getState().sel.chat === chat && getState().chats[chat]) void loadTree(chat).catch(() => {});
    }, TREE_RETRY_MS);
  });
}

// ---- sections: a remote server's tree comes and goes (`section`, and a snapshot's `sections`)

/** A section's tree arrived (tree), or the local server holds none of it any more (null).
 *
 *  With a tree the server is connected, for the first time or again, and this is its whole tree as it is now: it takes
 *  the place of what the page had for the entry, and from here on the entry's calls work. What is on screen of it is
 *  brought level with its server: the thread and the tree of the chat are read again (which follows
 *  them again: the local server ended this page's follows with the connection), the open board is taken if this window
 *  does not hold it, and the draft that waited in the open composer is saved. What is on screen and not in the new
 *  tree says that it is no longer on that server.
 *
 *  With none, the section shows no rows from here on. What is on screen stays as the page has it (store.ts
 *  applySection): nothing of it is read, and what was being read is given up. */
function onSection(server: string, tree: SectionTree | null) {
  if (!server || server === LOCAL_SERVER) return; // this computer is no section: its things come in the snapshot and in events with no `server`
  const left = applySection(server, tree);
  for (const id of left) forgetThing(id);
  if (!tree) { givenUp(server); return; }
  for (const id of [...removed]) if (serverOfKey(id) === server) removed.delete(id); // what the tree has is there
  onSectionBack(server);
  boardSectionBack(server);
  draftBacks.sectionBack(server);
}

/** The server list changed (before: the list the page had): an entry that left it was removed in the Servers dialog,
 *  which is no outage. That server never comes back to bring a view level, or to take a draft or a drawing, so
 *  everything the page has of it goes, what is on screen too. The `section` event with no tree of the same removal
 *  comes in no fixed order with the list's: before it, it left what was on screen, which goes here; after it, it finds
 *  nothing. */
function dropRemoved(before: ServerView[]) {
  for (const server of entriesGone(before, getState().servers)) {
    givenUp(server);
    for (const id of dropServer(server)) forgetThing(id);
    for (const id of [...removed]) if (serverOfKey(id) === server) removed.delete(id);
  }
}

/** This page removed an entry from the server list (the Servers dialog), and the local server answered that it is
 *  removed. The list is without the entry from here on, and what the page has of its server goes, as at the `servers`
 *  event of the same removal: the answer and the event come in no fixed order, the first of the two does it, and the
 *  other finds the entry gone already. */
export function entryRemoved(id: string) {
  const before = getState().servers;
  if (!before.some((v) => v.id === id)) return; // the `servers` event was here first
  setServers(before.filter((v) => v.id !== id), getState().serversNotice);
  dropRemoved(before);
}

/** The user left what was on screen (Sidebar.tsx select): what the page kept of a section's things only because they
 *  were on screen goes, from the store (store.ts dropLeftBehind) and from here. */
export function dropLeft() {
  for (const id of dropLeftBehind()) forgetThing(id);
}

/** What the event layer keeps of a thing that went: the fetches that run, and what is queued behind them. */
function forgetThing(id: string) {
  treeQueue.delete(id); treeLoads.delete(id);
  forgetThreadLoads(id);
}

/** A section's tree went: the reads of its things that run are given up (their answers are not waited for: the server
 *  is not connected), and nothing waits behind them. What is kept on screen stays. */
function givenUp(server: string) {
  const s = getState();
  for (const id of Object.keys(s.chats)) if (serverOfKey(id) === server) { forgetThreadLoads(id); treeLoads.delete(id); treeQueue.delete(id); }
}

/** `board_removed`. A board of a section that is on screen stays there, and its view says that it is no longer on that
 *  server; its row is gone with the others. */
function onBoardRemoved(id: string) {
  if (inSection(id) && onScreen(getState(), id)) markGone(id); else removeBoard(id);
}

/** `chat_removed`. A chat of a section that is on screen stays there, read-only, and its view says that it is no longer
 *  on that server; its row is gone with the others. */
function onChatRemoved(id: string) {
  removed.add(id); treeQueue.delete(id); treeLoads.delete(id);
  if (inSection(id) && onScreen(getState(), id)) { forgetThreadLoads(id); markGone(id); } else removeChat(id);
}

async function answer(m: any) {
  let reply: { result?: unknown; error?: string };
  try {
    if (m.method !== "tool") throw new Error(`unknown method ${m.method}`);
    reply = { result: await runTool(m.params) };
  } catch (err: any) {
    reply = { error: `${err?.code ? err.code + ": " : ""}${err?.message ?? String(err)}` };
  }
  // (409: the call is no longer this window's to answer, its board went to another one or it timed out)
  await api.rpcReply(m.id, reply).catch((e) => { if (e?.status !== 409) console.error("rpc reply:", e); });
}

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
const stale = new Set<ThreadKey>();                 // the threads a section's return left on screen until a read of them answers

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
 *  a chat that is gone by then. replace: the answer replaces the list whatever its version, as it
 *  does for a thread a section's return left on screen (stale); a fetch of such a thread that fails
 *  takes it away. The first list of a chat that loads puts the chat on the server's current
 *  branch (setShown): from then on only this client changes the branch it is on. Rejects when the
 *  fetch fails. */
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
  if (!getState().chats[chat]) { pending.delete(key); stale.delete(key); return; } // removed meanwhile: nothing of it is kept
  if (failed || !r) {
    if (stale.delete(key)) dropStale(chat, key); // kept, it would stay at its old version, and what is queued is not for it
    flush(key, sid ? null : list);
    console.error(`loading thread ${key}:`, failed);
    if (!sid) setThreadError(chat, threadError(failed)); // the chat's view says so in place of the thread
    if (!sid && inSection(chat) && threadError(failed).code === NOT_FOUND && getState().chats[chat]) markGone(chat); // the chat is no longer on its server: its view says so, and its row goes
    throw failed ?? new Error("not loaded");
  }
  if (!sid) setThreadError(chat, null);
  const was = stale.delete(key), replace = !!o.replace || was;
  const cur = threadAt(getState(), key);
  const next = afterAnswer(cur, { version: r.version, items: r.items ?? [] }, replace);
  if (next !== cur) {
    setThread(key, next);
    if (!sid && (r.subagents !== undefined || replace)) setSubs(list, subsById(r.subagents));
  }
  if (!sid && r.state && answerStateTaken(pending.get(key) ?? [])) upsertState(r.state);
  if (!sid && getState().shown[chat] === undefined) setShown(chat, currentBranch(getState().chats[chat]));
  flush(key, sid ? null : list);
  if (!sid && list === shownKey(getState(), chat)) checkMove(chat);
}

/** Fetches the list of a branch (the one its chat shows, when none is named), and keeps the fetch
 *  for who waits for the list. The store is told that the list is being fetched, until the newest
 *  fetch of it has ended (State.waits: a thread that has no list yet says so meanwhile). */
function loadList(chat: string, o?: { replace?: boolean }, branch = shownBranch(getState(), chat)): Promise<void> {
  const key = branchKey(chat, branch);
  const done: Promise<void> = loadThread(chat, branch, undefined, o).finally(() => { if (lists.get(key) === done) { lists.delete(key); setLoading(chat, branch, false); } });
  lists.set(key, done);
  setLoading(chat, branch, true);
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

/** A section's tree arrived: its server is connected, for the first time or again. It may have
 *  restarted, and its thread versions then start again: a thread kept at version 10 would drop
 *  every event up to 10. So everything kept of that server's chats goes (threads, subagents, trees,
 *  the fetches that run and what is queued behind them, load errors; the branch records are the new
 *  tree's), and the chat on screen is read again; another one is when it is opened next. The local
 *  server ended this page's follows of them with the connection: the reads are the new ones.
 *  The chat on screen keeps the list it shows, its subagents and an open subagent pane with its
 *  thread until the reads answer, so the reader keeps the place: the reads start here, what
 *  arrives meanwhile waits behind them, and their answers replace what is kept whatever its
 *  version. What is kept is marked (stale) until a read of it answers: the newest read of it that
 *  fails takes it away, also when that is not the read started here (a refused Send began a newer
 *  one, and this one's answer was then discarded). Only what was kept goes: the read of another
 *  branch the chat shows by then keeps its place.
 *  The pane's thread is read whenever a pane is open, kept or not: the read of it that ran was
 *  given up with the others, and the pane asks only once (Subagents.tsx useSubThread).
 *  A chat on screen that the new tree does not have is left as it is: its view says that it is no
 *  longer on that server (logic/serverlists.ts sectionBack names no such chat). */
function onSectionBack(server: string) {
  const back = sectionBack(getState(), server);
  const chat = back.load, s = getState();
  const list = chat ? shownKey(s, chat) : null;
  const pane = chat && list && s.subDrawer?.chat === chat && drawerStays(s.subDrawer, chat, shownBranch(s, chat)) ? s.subDrawer.sub : "";
  const sub = list && pane ? subKey(list, pane) : null;
  const keep = [list, sub].filter((k): k is NonNullable<typeof k> => !!k && !!threadAt(s, k));
  for (const id of back.chats) { forgetThread(id, id === chat && list ? keep : undefined); treeLoads.delete(id); treeQueue.delete(id); }
  for (const k of keep) stale.add(k);
  setState(back.patch);
  if (!chat) return;
  const branch = shownBranch(getState(), chat);
  void api.openChat(chat, branch).catch(() => {});
  void loadList(chat, { replace: true }).catch(() => {});
  if (pane) void loadThread(chat, branch, pane, { replace: true }).catch(() => {});
  void loadTree(chat, true).catch(() => {});
}

/** Takes away a thread a section's return left on screen, whose read failed: a list with its subagents,
 *  their threads and the pane on one of them; a subagent's thread alone (the pane reads it
 *  again). Nothing else of the chat is touched, and no fetch is given up. */
function dropStale(chat: string, key: ThreadKey) {
  setState((s) => {
    const items = withoutThread(s.items, key), subs = withoutThread(s.subs, key);
    const pane = s.subDrawer?.chat === chat && branchKey(chat, s.subDrawer.branch) === key ? null : s.subDrawer;
    return { items, subs, subDrawer: pane };
  });
}

/** Forgets a thread and everything fetched or queued for it: its items, its subagents and their
 *  threads. A fetch of it that runs is discarded when it answers. keep: the threads (a branch's
 *  list, with its subagents, and a subagent's thread) that stay until the caller's reads of them
 *  answer, and with them the subagent pane. */
function forgetThread(chat: string, keep?: ThreadKey[]) {
  forgetThreadLoads(chat, keep);
  const kept = <V,>(m: Record<string, V>): Record<string, V> => {
    const out = withoutChat(m, chat);
    for (const k of keep ?? []) if (k in m) out[k] = m[k];
    return out;
  };
  setState((s) => ({ items: kept(s.items), subs: kept(s.subs), subDrawer: !keep && s.subDrawer?.chat === chat ? null : s.subDrawer }));
}

/** Gives up the fetches of a chat's threads and what is queued behind them: a fetch that runs is discarded when it
 *  answers. What the store keeps of the chat stays as it is. keep: the threads whose mark (stale) stays. */
function forgetThreadLoads(chat: string, keep?: ThreadKey[]) {
  for (const k of [...pending.keys()]) if (keyOfChat(k, chat)) { pending.delete(k); loads.begin(k); }
  loads.begin(branchKey(chat));
  for (const k of [...lists.keys()]) if (keyOfChat(k, chat)) lists.delete(k); // of every branch: none is left for who asks next
  dropLoading(chat); // (and none of them tells of its end any more)
  for (const k of [...stale]) if (keyOfChat(k, chat) && !keep?.includes(k)) stale.delete(k);
}
