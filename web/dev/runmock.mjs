// A mock of the server for working on the client's run pages without the Go server and without an
// agent. Plain Node, no dependency; it serves web/dist.
//
// IT IS NOT THE CONTRACT. The Go server is (internal/runs, internal/server, internal/model/run.go):
// where the two differ, the server is right and this file is wrong. Known differences:
//   - `blocked` and `folderMissing` are computed on every view here; the server computes them
//     only when a run is asked for (GET /api/runs/{id}, PATCH, start, resume)
//   - the active-client header (X-AIWB-Client) is not required, and several tabs are all served
//   - `run` events go out at once; the server sends counts and cost at most once a second. No
//     `defaults` event and no `run_detail` version 1 at a start; a patch always names records
//   - `run_activity` may carry "" or 0; an agent's `tools` is on every agent, not only a running one
//   - a changed file has no rename marker on the server ("a → b" here); a report may be "" with 200
//   - an agent that failed is launched again at once (the server waits 30 s × n²); the engine
//     ignores maxParallel, and never makes `deps`, `blocked`, `chatOps`, `learned`, `costPartial`,
//     or a stall by cost or by idle turns (the hand-written runs have them)
//   - delivery (`delivery`, POST …/apply, GET …/delivery) is made up: nothing is merged, an apply
//     answers after 600 ms, and the delivery of a halted run ("pending", "halted") stays in the
//     detail after a resume (a patch removes nothing); `dirty` is a flag of the scenario
//   - tokens and `peakContext` are made up from the cost; the engine waits for the one task it
//     queued (wait_for), so its turns start with their wait met, or early after a failure
//   - a new run always has a model; a name given when a run is created sets `userNamed`
//   - a run stops within a second (the server: up to 30 s, and an archive may then answer 409;
//     here only with flags.archive409)
//   - guessed, the server's answer is not known: the status and body of an unreadable run's
//     detail (500, {"error": …}), of a failed delete (500), of a goal that is too long (400 with a
//     sentence over 200,000 characters; flags.start413: a bare 413)
//
//   cd web && npm run build && node dev/runmock.mjs        then open http://127.0.0.1:4791
//   PORT=4899 TICK=1000 node dev/runmock.mjs               another port, a live event every second
//   PAUSED=1 node dev/runmock.mjs                          starts with the timers stopped (see /mock/tick)
//   DIST=/some/folder node dev/runmock.mjs                 serves another build of the client
//
// Everything is in memory: a restart is a reset. It binds 127.0.0.1 only.
//
// Scenarios (one group "Shop" g_shop, one board b_arch; every run is in the group but r_draft):
//   r_draft     draft, ungrouped, with a saved goal draft; chat c_draft_ask on it
//   r_nogit     draft whose folder is not a git repository (git false, not blocked)
//   r_blocked   draft with `blocked` set (a repository with no commit)
//   r_missing   draft whose folder is gone (folderMissing)
//   r_live      running: the real 53-task run cut at +106 min, the cut being "now". Chats c_live_ask
//               (a transcript that calls the run tools) and c_live_new (empty, with a draft).
//               Agents with a written transcript: a_live_turn-014 (the running orchestrator turn),
//               a_live_T11-work (a task agent with a running subagent s1), a_live_T27-merge (a
//               merge agent), a_live_T23-work (streams its events always, watched or not).
//   r_stopped   stopped by the user at +62 min, an open stop
//   r_stalled   stalled by its turn limit (12 turns); resume needs {maxTurns} above 12
//   r_error     error: its last turn failed
//   r_done      completed: the full real detail (53 tasks, 35 turns, 88 agents)
//   r_gaveup    gave_up
//   r_cursor    a Cursor run, completed, every cost null
//   r_arch      archived (stopped before)
//   r_trouble   running, written by hand (12 tasks, 6 turns, 3 slots), its engine off so that it
//               stays as it is; `run_activity` still moves. It has what the engine never makes:
//               T05 failed and T06 blocked by it; T03 failed and was retried (two attempts); T02's
//               merge had conflicts a merge agent resolved; T11 is being merged with conflicts now;
//               T07's agent was restarted (two launches, the first with an error); T12 is ready with
//               no free slot; a stop → resume break (T03, T04, T05 ran across it; turn 4 is the
//               "resume" turn); the running turn 6 had an add_task refused; and chat c_trouble_ask
//               (still replying) cancelled T09, added T08 and updated T10 outside a turn (chatOps),
//               so T08 and T10 are held by that chat. A cost limit of $25.
//   r_stallcost stalled by its cost limit; resume needs {maxCost} above what it spent
//   r_stallidle stalled by idle turns (idleStreak 3): resumes as it is
//   r_stopblk   stopped because the app quit, with `blocked` set: it cannot resume as it is
//   r_cases     stopped, written by hand (8 tasks, 6 turns), for the dock's views: the app quit while
//               it worked, so turn 6 still says "running", T03's agent and turn 6's are "interrupted"
//               and T07 stands in its merge phase. T02's merge conflicted twice: two merge agents
//               (T02-merge, T02-merge-r2), the attempt naming only the second. T03's agent has four
//               launches: one failed, one stopped with the app, one "no session", one interrupted
//               (one restart). T03's title is 200 characters long; T01's report has a wide table and a
//               long code line; T02's changes have a 150-character path, a rename, a binary file and
//               three conflicted files; T04 has a result but its report answers 404; T05 (writes)
//               changed nothing; T06 was cancelled by turn 4 before it started; T07 was added by a chat
//               the client does not know (c_gone), which also wrote notes v5 and had a retry refused.
//               Turn 2 failed and turn 3 carries its event again; turn 5 had finish_run refused. The
//               stops: the app quit and started by itself, the user stopped and resumed, the app quit.
//   r_unreadable  a run whose record cannot be read: status error, no `started`, its detail answers 500
//   r_err2      as r_error, in the server's order: the halt first, the turn fails 40 ms later
//   r_old       completed two days ago, over midnight; git.dirtyAtStart is true
//   r_big       only with BIG=1: 297 tasks, 98 turns (dev/runmock-big.js), its engine off
//   r_waiting   running, written by hand, its engine off: no turn is running and the run waits for
//               two tasks at work (`wait` on its view: T02 and T03, "all", declared by turn 2)
//   r_dirty     draft whose folder has uncommitted changes (`dirty`)
//   r_plain     completed, written by hand, in a folder that is not a git repository: no `git` in
//               its detail, no branch on its attempts, no merge phase, and its changes answer 404
//   chats       c_plain (in the group), c_board (on the board); and one record with a role in the
//               snapshot's chats on purpose (a_live_T28-work): the client must drop it
//
// Tiers, waits, usage and delivery (process v3):
//   tiers       every run has `tiers` (Claude: deep opus/high, standard opus/medium, light sonnet/medium;
//               r_cursor: gpt-5.4/medium in all three), a draft also `tierDefaults`. A task's tier follows
//               its kind (review, research: deep; verify, docs: light; the rest: standard). r_trouble's T03
//               failed on standard and was retried on deep (the retry_task op of turn 3 carries the tier).
//               Agents: orchestrators deep, merge agents standard, each with model, effort, tokens and
//               peakContext; r_cursor's have `tokens: null` and no peakContext.
//   turns       most start with reason "wait", their wait met, and end with a wait_for op. Started early
//               (waitMet false): r_trouble turn 3 and 5 ("events", a task_failed), turn 4 ("resume") and
//               turn 6 (a chat's change); r_cases turn 5 ("resume"); the last three turns of r_stallidle
//               ("idle"). edit_notes ops with a heading: every fourth turn of the real run, r_trouble
//               turn 3, r_waiting turn 2. Turns that changed nothing in the plan: the real run's 2, 12,
//               17, 18, 20, 23, 27, 31–33; r_trouble 5; r_plain 3.
//   delivery    r_done applied (fast-forward, by the app); r_cursor blocked by local changes (3 files):
//               its first Apply answers blocked / conflict with 2 files, the next one applies; r_gaveup
//               pending, not_achieved; r_old pending, manual (settings.applyResult "manual"); r_plain
//               none, no_git; a halted run with git (r_stopped, r_stalled, r_error, r_cases, …) pending,
//               halted: Apply gives an applied, partial delivery; a live run and a draft have none.
//               POST …/apply answers after 600 ms (409 for a live run or a draft); a `branch` in its
//               body is the branch of the answer.
// Every agent id of every detail answers the chat routes (GET /api/chats/{id}, /items, /tree, …).
//
// A run that is "running" has a small engine: every TICK ms (default 3000) one `run_detail` event,
// version +1, whole records: a turn starts, calls get_run / add_task (or retry_task, on the deep
// tier) / set_notes / wait_for and ends; the task goes slot → setup → work (an agent launch, then a second launch) → merge →
// done (every fourth one fails and is retried by the next turn; every third one has conflicts and
// a merge agent). `run_activity` goes out every 2 s, `run` whenever the light view changed. A run
// started here gets the same life; a run stalls when it reaches its turn limit.
//
// `chat`, `chat_items` and `sub` events of an agent go to a tab only after that tab fetched the
// agent's /items on its current connection (as the server does), except a_live_T23-work, whose
// events go to every tab. Several tabs can be open: all get the run events (there is no takeover).
//
// The texts that are loaded on demand (goal, brief revisions, reports, changes, notes versions) are
// written from the records, so that they read like real ones: a report has headings, a code block
// and a table; every brief revision and every notes version has a text of its own; an attempt's
// changes have a renamed and a binary file, and its conflicted files. Every request for one of them
// is counted (GET /mock/state: `texts`, by path).
//
// Starting a run answers after 400 ms; a goal that contains "fail" answers 400 "claude is not
// installed", one over 200,000 characters 400. A folder under ~/.aiwb-demo is refused (400) by PATCH cwd.
//
// Controls (POST, no body; they answer the mock's state as GET /mock/state does):
//   /mock/gap        skips a version of r_live silently: the next run_detail event is a gap
//   /mock/snapshot   sends the snapshot again on the open stream
//   /mock/pause      stops the timers (engine, activity, agent streams); /mock/resume starts them
//   /mock/tick       one engine step of every running run now (also while paused)
//   /mock/activity   one run_activity round now; /mock/stream: one round of agent stream events
//   /mock/eval       body {"code": "…"}: runs the code inside this file (an async function body; `runs`,
//                    `view`, `send`, `sendRun`, `commit`, `chats`, `flags`, `halt`, … are in scope) and
//                    answers {ok, r: what it returned}. Examples:
//                      a draft as an old server sent it:  send({ type: "run", run: { ...view(runs.r_draft), cost: null } })
//                      a long blocked sentence:           runs.r_draft.meta.blocked = "…"; sendRun(runs.r_draft)
//                      a crash:                           runs.r_stopblk.meta.reason = CRASH; delete runs.r_stopblk.meta.blocked; sendRun(runs.r_stopblk)
//                    flags (set them with eval): flags.archive409 (archive answers 409), flags.delete500
//                    (delete answers 500 and the run stays), flags.start413 (start answers a bare 413),
//                    flags.stopDelay = ms (the stop's answer waits that long; its events do not)
//   /mock/delay?ms=  answers GET /api/runs/{id}/detail that much later (0: at once), so that what a
//                    view shows while its detail is fetched again can be seen; DETAIL_DELAY=ms sets it at start
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.DIST || path.resolve(HERE, "../dist"));
const PORT = Number(process.env.PORT || 4791);
const TICK_MS = Number(process.env.TICK || 3000);
let detailDelay = Number(process.env.DETAIL_DELAY || 0); // ms before a detail is answered (/mock/delay)
const REAL = JSON.parse(fs.readFileSync(path.resolve(HERE, "../test/fixtures/run-detail-qa.json"), "utf8"));

const T0 = Date.now();
const MIN = 60000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
const newId = (p) => p + Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const UNGROUPED = "__ungrouped__";

// ---- catalogs and folders

const claude = { default: { model: "opus", effort: "high" }, models: [
  { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 200000 },
  { id: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200000 },
  { id: "haiku", label: "Haiku 4.5", contextWindow: 200000 } ] };
const cursor = { default: { model: "gpt-5.4", effort: "medium" }, models: [
  { id: "gpt-5.4", label: "GPT-5.4", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "gpt-5.4-nano", label: "GPT-5.4 nano" } ] };
const catalogs = { claude, cursor, pi: null }; // pi has reported no models yet: a run on it has no model to start with
const catalogOf = (agent) => catalogs[agent] ?? null;

const HOME = "/Users/demo", DATA = HOME + "/.aiwb-demo";
const TREE = { // the folders that exist
  [HOME]: ["notes", "projects"], [HOME + "/notes"]: [], [HOME + "/projects"]: ["empty-repo", "scratch", "shop"],
  [HOME + "/projects/shop"]: ["docs", "web"], [HOME + "/projects/shop/docs"]: [], [HOME + "/projects/shop/web"]: [],
  [HOME + "/projects/empty-repo"]: [], [HOME + "/projects/scratch"]: [], [DATA]: ["runs"], [DATA + "/runs"]: [],
};
const REPOS = [HOME + "/projects/shop", HOME + "/projects/empty-repo"];
const SHOP = HOME + "/projects/shop";
const expand = (p) => { p = String(p ?? "").trim().replace(/\/+$/, ""); return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p || "/"; };
const exists = (p) => Object.hasOwn(TREE, p);
const inside = (p, root) => p === root || p.startsWith(root + "/");
const isGit = (p) => REPOS.some((r) => inside(p, r));
/** Why a run in this folder cannot start, other than a missing folder; "" when it can. */
const blockedOf = (cwd) => (inside(cwd, HOME + "/projects/empty-repo") ? "this repository has no commit yet: make a first commit, then start the run" : "");
// The reason sentences, in the server's form: lower case, no full stop.
const BY_USER = "stopped by the user", QUIT = "the app was closed while the run was working";
const CRASH = "the app ended unexpectedly while the run was working; resume it when you are ready";
const UNREADABLE = "the run's record could not be read: unexpected end of JSON input";
const turnsReason = (n) => `reached the limit of ${n} orchestrator turns`;

// ---- the run model: a light record (meta) and, once started, a detail in the contract's shape

const DEFAULT_SETTINGS = { maxParallel: 8, maxTurns: 60, maxCost: 0, wake: "declared", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 };
const TASK_STATES = ["held", "deps", "blocked", "slot", "setup", "work", "merge", "done", "failed", "cancelled"];
const taskState = (t) => { const a = t.attempts.at(-1); return a.outcome ?? a.phases.at(-1).k; };
const isTime = (k) => k === "t" || k === "at" || k.endsWith("At");

// ---- tiers, usage, waits

const TIERS = ["deep", "standard", "light"];
/** What a new run of an agent kind starts with: Claude has a model per tier, another kind its default model in all three. */
function tierDefaults(agent) {
  if (agent === "claude") return { deep: { model: "opus", effort: "high" }, standard: { model: "opus", effort: "medium" }, light: { model: "sonnet", effort: "medium" } };
  const c = catalogOf(agent)?.default ?? { model: "" };
  return { deep: { ...c }, standard: { ...c }, light: { ...c } };
}
const TIER_OF = { review: "deep", research: "deep", verify: "light", docs: "light" }; // by a task's kind; the rest: standard
const TIER_WHY = { deep: "It has to judge what is right across several parts of the code.", standard: "A contained change with a clear brief.", light: "A mechanical job with nothing to decide." };
const tierOf = (kind) => TIER_OF[kind] ?? "standard";
/** The tokens an agent that cost `cost` used, and its fullest context. */
function usageOf(cost, model) {
  const c = cost ?? 0.5, k = model === "opus" ? 1 : 5;
  return { tokens: { in: Math.round(c * 900 * k), out: Math.round(c * 4200 * k), cacheRead: Math.round(c * 520000 * k), cacheWrite: Math.round(c * 43000 * k) }, peakContext: Math.min(186000, 24000 + Math.round(c * 15500 * k)) };
}
/** The tier fields of an agent of run `R`: its model and effort, and its usage (none for Cursor). */
function onTier(R, tier, cost) {
  const c = R.meta.tiers[tier], cursorRun = R.meta.agent === "cursor";
  return { tier, model: c.model, ...(c.effort ? { effort: c.effort } : {}), ...(cursorRun ? { tokens: null } : usageOf(cost, c.model)) };
}
/** Gives a detail written without them its tier fields: what a record already has stays. */
function fillTiers(R) {
  const d = R.detail;
  if (!d) return;
  const byId = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
  for (const t of d.tasks) {
    t.tier ??= tierOf(t.kind); t.tierReason ??= TIER_WHY[t.tier]; t.needsReport ??= [];
    for (const a of t.attempts) a.tier ??= t.tier;
  }
  for (const o of [...d.turns.flatMap((t) => t.ops), ...d.chatOps]) {
    const t = byId[o.task];
    if (o.op === "add_task" && t && !o.error) { o.tier ??= t.attempts[0].tier; o.tierReason ??= o.tier === t.tier ? t.tierReason : TIER_WHY[o.tier]; if (t.needsReport.length) o.needsReport ??= t.needsReport; }
  }
  for (const a of Object.values(d.agents)) {
    const tier = a.tier ?? (a.role === "orchestrator" ? "deep" : a.role === "merge" ? "standard" : byId[a.task]?.attempts[(a.attempt ?? 1) - 1]?.tier ?? "standard");
    const had = { tokens: a.tokens, peakContext: a.peakContext };
    Object.assign(a, onTier(R, tier, a.cost));
    if (R.meta.agent === "cursor") delete a.peakContext; else if (had.tokens) Object.assign(a, had);
  }
}
/** Gives the turns of a run written by hand their waits. `spec[n] = [tasks, mode]`: turn n ends with
 *  a wait_for op, and the next turn starts under that wait: met, unless `early` names that turn (its
 *  reason and wokenBy then say what started it). */
function declare(turns, spec, early = []) {
  let wait;
  for (const t of turns) {
    if (wait) { t.wait = wait; t.waitMet = !early.includes(t.n); if (t.waitMet && t.reason === "events") t.reason = "wait"; }
    wait = undefined;
    if (!spec[t.n]) continue;
    const [tasks, mode = "all"] = spec[t.n], last = t.ops.at(-1)?.t ?? t.startedAt;
    t.ops.push({ i: t.ops.length, t: Math.max(last, (t.endedAt ?? last + 4000) - 3000), op: "wait_for", tasks, mode });
    wait = { tasks, mode, turn: t.n };
  }
  return turns;
}
/** What a live run waits for now: the wait its last turn declared, while no turn is running. */
function waitOf(d) {
  if (!d || d.status !== "running" || d.turns.some((t) => t.status === "running")) return undefined;
  const t = d.turns.at(-1), o = t?.ops.findLast((x) => x.op === "wait_for" && !x.error);
  return o ? { tasks: o.tasks, mode: o.mode, turn: t.n } : undefined;
}

/** Adds `by` ms to every time of a value, in place. */
function shift(v, by) {
  if (Array.isArray(v)) { for (const x of v) shift(x, by); return v; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (typeof x === "number" && isTime(k)) v[k] = x + by; else shift(x, by); }
  return v;
}

/** The real run as run `id`: its agents get ids "a_<tag>_<name>", its times move by `by`. */
function derive(id, tag, by) {
  const d = shift(clone(REAL), by);
  const ids = Object.fromEntries(Object.values(d.agents).map((a) => [a.id, `a_${tag}_${a.name}`]));
  d.run = id;
  if (d.git) d.git.integrationBranch = `aiwb/${id}/integration`;
  d.agents = Object.fromEntries(Object.values(d.agents).map((a) => [ids[a.id], { ...a, id: ids[a.id] }]));
  for (const t of d.turns) t.agent = ids[t.agent];
  for (const t of d.tasks) for (const a of t.attempts) for (const k of ["work", "merge"]) if (a.agents[k]) a.agents[k] = ids[a.agents[k]];
  return d;
}

/** The detail as it was at time t, the run running. */
function cutAt(d, t) {
  d.status = "running"; delete d.endedAt; delete d.result; delete d.git.resultHead;
  d.turns = d.turns.filter((x) => x.startedAt <= t);
  for (const x of d.turns) {
    if (x.endedAt > t) { delete x.endedAt; delete x.summary; x.status = "running"; x.cost = null; x.ops = x.ops.filter((o) => o.t <= t); x.learned = x.learned.filter((e) => e.t <= t); }
  }
  const lastTurn = d.turns.at(-1)?.n ?? 0;
  d.tasks = d.tasks.filter((x) => x.createdAt <= t);
  const have = new Set(d.tasks.map((x) => x.id));
  for (const x of d.tasks) {
    x.dependsOn = x.dependsOn.filter((y) => have.has(y));
    x.briefs = x.briefs.filter((b) => b.at <= t); x.briefRev = x.briefs.at(-1).rev;
    x.changedTurns = x.changedTurns.filter((n) => n <= lastTurn);
    x.attempts = x.attempts.filter((a) => a.queuedAt <= t);
    for (const a of x.attempts) {
      if (a.endedAt <= t) continue;
      a.phases = a.phases.filter((p) => p.t <= t);
      for (const p of a.phases) if (p.on) p.on = p.on.filter((y) => have.has(y));
      for (const k of ["endedAt", "outcome", "mergedAt", "merged", "head", "result", "conflicts"]) delete a[k];
      a.cost = null;
      if (a.startedAt > t) { delete a.startedAt; delete a.base; delete a.branch; }
      for (const k of ["work", "merge"]) if (a.agents[k] && d.agents[a.agents[k]].startedAt > t) delete a.agents[k];
    }
  }
  d.agents = Object.fromEntries(Object.entries(d.agents).filter(([, a]) => a.startedAt <= t));
  for (const a of Object.values(d.agents)) {
    if (a.endedAt <= t) continue;
    delete a.endedAt; a.status = "running"; a.cost = null;
    a.launches = a.launches.filter((l) => l.startedAt <= t);
    delete a.launches.at(-1).endedAt;
  }
  d.notes = d.notes.filter((n) => n.at <= t);
  d.version = d.turns.reduce((n, x) => n + 2 + x.ops.length, 0) + d.tasks.reduce((n, x) => n + x.attempts.reduce((m, a) => m + a.phases.length + (a.endedAt ? 1 : 0), 0), 0);
  return d;
}

/** Halts a running detail at `at`: an open stop, its running agents interrupted. A running turn keeps its status. */
function halt(d, at, reason, status) {
  d.status = status; d.stops.push({ at, reason });
  for (const a of Object.values(d.agents)) if (a.status === "running") { a.status = "interrupted"; delete a.endedAt; a.launches.at(-1).endedAt = at; }
  return d;
}

const flags = {}; // switches set through /mock/eval (see the header)
const runs = {}; // id → { meta, detail?, goal?, eng, tag, sent }
const SHA_ = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const tagOf = (id) => id.slice(2);

function addRun(meta, detail, goal) {
  const R = { meta: { group: "g_shop", agent: "claude", tiers: tierDefaults(meta.agent ?? "claude"), cwd: SHOP, settings: { ...DEFAULT_SETTINGS, setup: "cd web && npm ci" }, idleStreak: 0, ...meta }, detail, goal, eng: { step: 0, inbox: [], made: 0, seq: 1000 }, tag: tagOf(meta.id) };
  fillTiers(R);
  if (detail) { R.meta.started = iso(detail.startedAt); if (R.meta.activeMs === undefined) Object.assign(R.meta, active(detail)); }
  runs[meta.id] = R;
  return R;
}

/** Working time (stops left out) up to the last moment the run started, halted, resumed or ended. */
function active(d) {
  const end = d.endedAt ?? d.stops.findLast((s) => !s.resumedAt)?.at;
  const asOf = end ?? d.stops.at(-1)?.resumedAt ?? d.startedAt;
  let ms = asOf - d.startedAt;
  for (const s of d.stops) if (s.resumedAt && s.resumedAt <= asOf) ms -= s.resumedAt - s.at;
  return { activeMs: ms, asOf };
}

/** The RunView: the light record plus what the detail says. */
function view(R) {
  const m = R.meta, d = R.detail;
  const counts = Object.fromEntries(TASK_STATES.map((k) => [k, 0]));
  if (m.unreadable) { // what can be said of a run whose record cannot be read: where it is, and that it is broken
    return JSON.parse(JSON.stringify({ id: m.id, name: m.name, group: m.group, created: m.created, agent: m.agent, tiers: { deep: { model: "" }, standard: { model: "" }, light: { model: "" } }, cwd: "", settings: DEFAULT_SETTINGS,
      status: "error", reason: UNREADABLE, activeMs: 0, asOf: 0, turns: 0, idleStreak: 0, counts, cost: 0, attention: 0, archived: m.archived, archiveOp: m.archiveOp }));
  }
  let turns = 0, turnRunning, cost = m.agent === "cursor" ? null : 0, attention = 0;
  if (d) {
    for (const t of d.tasks) counts[taskState(t)]++;
    turns = d.turns.at(-1)?.n ?? 0;
    turnRunning = d.turns.find((t) => t.status === "running")?.n;
    if (cost !== null) cost = Math.round(Object.values(d.agents).reduce((n, a) => n + (a.cost ?? 0), 0) * 1e6) / 1e6;
    attention = counts.failed + counts.blocked + (d.turns.at(-1)?.ops.filter((o) => o.error).length ?? 0);
  }
  const v = {
    id: m.id, name: m.name, userNamed: m.userNamed, group: m.group, created: m.created,
    agent: m.agent, tiers: m.tiers, tierDefaults: d ? undefined : tierDefaults(m.agent), cwd: m.cwd,
    folderMissing: !exists(m.cwd) || undefined,
    git: (d ? !!d.git : isGit(m.cwd)) || undefined, // omitted for a folder that is not a repository, as the server does
    dirty: (!d && m.dirty) || undefined, wait: waitOf(d), delivery: d?.delivery?.state,
    blocked: m.blocked || (!d && exists(m.cwd) && blockedOf(m.cwd)) || undefined,
    settings: m.settings, draft: d ? undefined : m.draft, started: m.started,
    status: d ? d.status : "draft", reason: m.reason, stalledBy: m.stalledBy, outcome: d?.result?.outcome,
    activeMs: m.activeMs ?? 0, asOf: m.asOf ?? 0, turns, turnRunning, idleStreak: m.idleStreak, counts, cost, attention,
    archived: m.archived, archiveOp: m.archiveOp,
  };
  return JSON.parse(JSON.stringify(v)); // drops the undefined fields, as omitempty does
}

// ---- the fixture runs

const GOAL_QA = "# QA of the last few features\n\nVerify, review, debug and fix what the last few commits added.\n\n## What to cover\n\n1. Chat forking and branching, with running subagents.\n2. Push delivery of subagent results.\n3. The model pickers and quote references.\n\n## Rules\n\n- Review first, then fix: **every fix gets a test**.\n- Keep `go build ./...`, `go test ./...` and `npm test` green.\n\n```sh\ngit log --oneline 2fc24d2^..8722065\n```";
const mid = REAL.startedAt + 106 * MIN;
const AG = { turn: "a_live_turn-014", sub: "a_live_T11-work", merge: "a_live_T27-merge", always: "a_live_T23-work", listed: "a_live_T28-work" };
{
  const d = cutAt(derive("r_live", "live", T0 - mid), T0);
  // one task is being merged by a merge agent (the real run had no conflict)
  const t27 = d.tasks.find((t) => t.id === "T27"), a = t27.attempts[0], at = T0 - 40000;
  a.phases.push({ k: "merge", t: at });
  a.result = { outcome: "completed", summary: "Scrubbed the app's handles from the environment of every child process the adapters start, with a test per adapter.", reportSize: 6412 };
  a.conflicts = ["internal/agents/claude/adapter.go", "internal/agents/pi/bridge.go"];
  a.head = "5d0c1e7a9b3f4c2d8e6a1b0c9d8e7f6a5b4c3d2e";
  Object.assign(d.agents[a.agents.work], { status: "done", endedAt: at, cost: 3.412 }); d.agents[a.agents.work].launches.at(-1).endedAt = at;
  a.agents.merge = AG.merge;
  d.agents[AG.merge] = { id: AG.merge, name: "T27-merge", role: "merge", task: "T27", attempt: 1, status: "running", startedAt: at + 800, launches: [{ n: 1, startedAt: at + 800, resume: false }], cost: null };
  addRun({ id: "r_live", name: "QA of the last few features", created: iso(d.startedAt - 4 * MIN) }, d, GOAL_QA);
}
{
  const at = REAL.startedAt + 62 * MIN, by = T0 - 3 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_stopped", "stopped", by), at + by), at + by, "user", "stopped");
  addRun({ id: "r_stopped", name: "Checkout rewrite", userNamed: true, created: iso(d.startedAt - MIN), reason: BY_USER }, d, "Rewrite the checkout flow on the new cart API and keep every existing test green.");
}
{
  const t12 = REAL.turns.find((t) => t.n === 12), at = t12.endedAt + 1, by = T0 - 26 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_stalled", "stalled", by), at + by), at + by, "stalled", "stalled");
  addRun({ id: "r_stalled", name: "Upgrade to React 19", created: iso(d.startedAt - MIN), settings: { ...DEFAULT_SETTINGS, maxTurns: 12 },
    stalledBy: "turns", reason: turnsReason(12) }, d, "Upgrade the web client to React 19 and fix what breaks.");
}
{
  const t9 = REAL.turns.find((t) => t.n === 9), at = t9.startedAt + 45000, by = T0 - 50 * 60 * MIN - at;
  const d = cutAt(derive("r_error", "error", by), at + by);
  const turn = d.turns.at(-1);
  Object.assign(turn, { status: "failed", endedAt: at + by, error: "the agent's process exited three times in a row (code 1)" });
  Object.assign(d.agents[turn.agent], { status: "failed", endedAt: at + by, error: turn.error }); d.agents[turn.agent].launches.at(-1).endedAt = at + by;
  halt(d, at + by, "error", "error");
  addRun({ id: "r_error", name: "Flaky test hunt", created: iso(d.startedAt - MIN), reason: `orchestrator turn ${turn.n}: ${turn.error}` }, d, "Find and fix the flaky tests of the Go packages.");
}
{
  const d = derive("r_done", "done", T0 - 20 * 60 * MIN - REAL.endedAt);
  addRun({ id: "r_done", name: "last-few-features-qa", userNamed: true, created: iso(d.startedAt) }, d, GOAL_QA);
}
{
  const t6 = REAL.turns.find((t) => t.n === 6), at = t6.startedAt + 30000, by = T0 - 70 * 60 * MIN - at;
  const d = cutAt(derive("r_gaveup", "gaveup", by), at + by), end = at + by, turn = d.turns.at(-1);
  for (const t of d.tasks) { const a = t.attempts.at(-1); if (!a.outcome) Object.assign(a, { outcome: "cancelled", endedAt: end - 5000, cancel: { t: end - 5000, reason: "The goal cannot be reached: the upstream API was removed.", turn: turn.n } }); }
  for (const a of Object.values(d.agents)) if (a.status === "running" && a.id !== turn.agent) { a.status = "cancelled"; a.endedAt = end - 5000; a.launches.at(-1).endedAt = end - 5000; }
  const summary = "The run gave up: the payment provider removed the API the goal depends on, so the remaining tasks cannot be done.";
  turn.ops.push({ i: turn.ops.length, t: end - 2000, op: "finish_run", outcome: "not_achieved", text: summary });
  Object.assign(turn, { status: "done", endedAt: end, summary, cost: 0.61 });
  Object.assign(d.agents[turn.agent], { status: "done", endedAt: end, cost: 0.61 }); d.agents[turn.agent].launches.at(-1).endedAt = end;
  Object.assign(d, { status: "gave_up", endedAt: end, result: { outcome: "not_achieved", summary, turn: turn.n, at: end } });
  addRun({ id: "r_gaveup", name: "Move payments to the v3 API", created: iso(d.startedAt - MIN) }, d, "Move payments to the provider's v3 API.");
}
{
  const d = derive("r_cursor", "cursor", T0 - 5 * 24 * 60 * MIN - REAL.endedAt);
  for (const a of Object.values(d.agents)) a.cost = null;
  for (const t of d.turns) t.cost = null;
  for (const t of d.tasks) for (const a of t.attempts) a.cost = null;
  addRun({ id: "r_cursor", name: "Translate the docs", created: iso(d.startedAt), agent: "cursor" }, d, "Translate the docs folder to German.");
}
{
  const at = REAL.startedAt + 30 * MIN, by = T0 - 9 * 24 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_arch", "arch", by), at + by), at + by, "user", "stopped");
  addRun({ id: "r_arch", name: "Old experiment", created: iso(d.startedAt - MIN), reason: BY_USER, archived: true, archiveOp: "op_arch1" }, d, "An experiment that was put away.");
}
{ // stalled by its cost limit: the limit is what it had spent, rounded down
  const t12 = REAL.turns.find((t) => t.n === 12), at = t12.endedAt + 1, by = T0 - 30 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_stallcost", "stallcost", by), at + by), at + by, "stalled", "stalled");
  const cost = Object.values(d.agents).reduce((n, a) => n + (a.cost ?? 0), 0), spent = Math.floor(cost);
  addRun({ id: "r_stallcost", name: "Rewrite the importer", userNamed: true, created: iso(d.startedAt - MIN), settings: { ...DEFAULT_SETTINGS, maxCost: spent },
    stalledBy: "cost", reason: `spent $${cost.toFixed(2)}, over the limit of $${spent.toFixed(2)}` }, d, "Rewrite the importer on the streaming parser.");
}
{ // stalled by idle turns
  const t9 = REAL.turns.find((t) => t.n === 9), at = t9.endedAt + 1, by = T0 - 34 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_stallidle", "stallidle", by), at + by), at + by, "stalled", "stalled");
  addRun({ id: "r_stallidle", name: "Tidy the docs", userNamed: true, created: iso(d.startedAt - MIN), idleStreak: 3,
    stalledBy: "idle", reason: "the orchestrator was started 3 times in a row with nothing running and neither added work nor finished the run" }, d, "Tidy the docs folder.");
}
{ // stopped when the app quit, and not resumable as it is
  const at = REAL.startedAt + 44 * MIN, by = T0 - 8 * 60 * MIN - at;
  const d = halt(cutAt(derive("r_stopblk", "stopblk", by), at + by), at + by, "app_quit", "stopped");
  addRun({ id: "r_stopblk", name: "Split the monolith", userNamed: true, created: iso(d.startedAt - MIN), reason: QUIT,
    blocked: `${SHOP} is no longer the git repository this run started in` }, d, "Split the monolith into three services.");
}
{ // r_trouble: a small live run written by hand (see the header). Times are minutes before now.
  const tag = "trouble", at = (min) => Math.round(T0 + min * MIN), ag = (name) => `a_${tag}_${name}`, agents = {};
  // an agent: launches as [from, to?, error?] in minutes; the last one open means it is running
  const agent = (name, role, launches, o = {}) => {
    const ls = launches.map(([a, b, error], i) => ({ n: i + 1, startedAt: at(a), ...(b == null ? {} : { endedAt: at(b) }), resume: i > 0, ...(error ? { error } : {}) }));
    const running = ls.at(-1).endedAt === undefined;
    agents[ag(name)] = { id: ag(name), name, role, status: running ? "running" : "done", startedAt: ls[0].startedAt, ...(running ? {} : { endedAt: ls.at(-1).endedAt }), launches: ls, cost: running ? null : 0.9, tools: 24, ...o };
    return ag(name);
  };
  const turn = (n, a, b, reason, wokenBy, ops, launches) => {
    const name = `turn-${String(n).padStart(3, "0")}`, cost = b == null ? null : Math.round((0.38 + n * 0.07) * 100) / 100;
    agent(name, "orchestrator", launches ?? [[a, b]], { turn: n, cost, tools: ops.length });
    return { n, agent: ag(name), reason, status: b == null ? "running" : "done", startedAt: at(a), ...(b == null ? {} : { endedAt: at(b), summary: `Turn ${n} is done.` }),
      wokenBy: wokenBy.map(([min, type, x, text], i) => ({ seq: n * 10 + i, t: at(min), type, ...(type === "chat_op" ? { chat: x } : { task: x }), text })), learned: [],
      ops: ops.map(([min, op, x], i) => ({ i, t: at(min), op, ...x })), cost };
  };
  const attempt = (n, queuedTurn, queued, phases, o = {}) => ({ n, queuedTurn, queuedAt: at(queued), phases: phases.map(([k, min, x]) => ({ k, t: at(min), ...x })), agents: {}, cost: null, ...o });
  const task = (id, title, kind, writes, dependsOn, addedTurn, created, attempts, o = {}) => ({ id, title, kind, writes, dependsOn, addedTurn, createdAt: at(created), changedTurns: [], briefRev: 1,
    briefs: [{ rev: 1, at: at(created), turn: addedTurn, size: 2400 }], attempts, ...o });
  const done = (end, summary, o = {}) => ({ endedAt: at(end), outcome: "done", result: { outcome: "completed", summary, reportSize: 4800 }, cost: 1.4, ...o });
  const merged = (end) => ({ mergedAt: at(end), merged: SHA_(), head: SHA_(), base: SHA_() });
  const add = (min, task, title, kind, writes, dependsOn = []) => [min, "add_task", { task, title, kind, writes, dependsOn, briefRev: 1 }];
  const CHAT = "c_trouble_ask", QUIT = "the agent's process exited (code 143)";
  const TITLES_ = { T01: "Map how refunds flow through the cart API", T02: "Add the refund endpoint to the cart service", T03: "Show refund state in the order page", T04: "Verify the checkout end to end",
    T05: "Support partial refunds", T06: "Document partial refunds", T07: "Send a refund e-mail", T08: "Document the refund flow", T09: "Review the refund copy", T10: "Translate the refund e-mail",
    T11: "Add refund totals to the admin report", T12: "Remove the old refund flag" };
  const turns = declare([
    turn(1, -60, -57, "start", [], [[-59.8, "get_run"], add(-59, "T01", TITLES_.T01, "research", false), add(-58.8, "T02", TITLES_.T02, "implement", true, ["T01"]), add(-58.6, "T03", TITLES_.T03, "implement", true),
      add(-58.4, "T04", TITLES_.T04, "verify", false), add(-58.2, "T05", TITLES_.T05, "implement", true, ["T02"]), [-57.3, "set_notes", { notesVersion: 1, size: 3100 }]]),
    turn(2, -48, -46.5, "events", [[-48, "task_done", "T01", "Refunds go through three services; the cart API is the only writer."]],
      [[-47.9, "get_run"], add(-47.5, "T06", TITLES_.T06, "docs", true, ["T05"]), add(-47.2, "T09", TITLES_.T09, "review", false), [-46.8, "set_notes", { notesVersion: 2, size: 3600 }]]),
    turn(3, -44, -42.5, "events", [[-44, "task_failed", "T03", "agent T03-work failed: no result after 3 launches (timeout)"]],
      [[-43.8, "get_task", { task: "T03" }], [-43, "retry_task", { task: "T03", reason: "Three launches ended without a result: one more attempt, on the deep tier.", attempt: 2, tier: "deep", tierReason: "The standard tier ran out of time on it three times." }],
        [-42.7, "edit_notes", { notesVersion: 3, size: 3900, heading: "Risks" }]]),
    turn(4, -21.5, -19.5, "resume", [], [[-21.3, "get_run"], add(-20.5, "T07", TITLES_.T07, "implement", true), add(-20.2, "T10", TITLES_.T10, "implement", true, ["T07"]), add(-20, "T11", TITLES_.T11, "implement", true),
      add(-19.8, "T12", TITLES_.T12, "fix", true), [-19.6, "set_notes", { notesVersion: 4, size: 4400 }]]),
    turn(5, -11.5, -10, "events", [[-12, "task_failed", "T05", "its agent reported that it could not do the task: the cart API has no endpoint for partial refunds"]],
      [[-11.3, "get_task", { task: "T05" }], [-10.2, "set_notes", { notesVersion: 5, size: 4700 }]]),
    turn(6, -2.5, null, "events", [[-2.6, "chat_op", CHAT, "A chat on the run cancelled T09: The copy is reviewed elsewhere."]],
      [[-2.3, "get_run"], [-1.5, "add_task", { title: "Cover partial refunds with tests", kind: "test", writes: true, dependsOn: ["T99"], error: "depends_on names T99, which is not a task of this run" }]]),
  // turn 3 and 5 were started early by a failed task, turn 4 by the resume, turn 6 by a chat's change
  ], { 1: [["T01"]], 2: [["T02"]], 3: [["T02", "T03"]], 4: [["T05", "T07"]], 5: [["T04", "T07", "T11"]] }, [3, 4, 5, 6]);
  const tasks = [
    task("T01", TITLES_.T01, "research", false, [], 1, -59, [attempt(1, 1, -59, [["held", -59, { turn: 1 }], ["setup", -57], ["work", -56.9]],
      { startedAt: at(-57), agents: { work: agent("T01-work", "task", [[-56.9, -48]], { task: "T01", attempt: 1 }) }, ...done(-48, "Refunds go through three services; the cart API is the only writer.") })]),
    task("T02", TITLES_.T02, "implement", true, ["T01"], 1, -58.8, [attempt(1, 1, -58.8, [["held", -58.8, { turn: 1 }], ["deps", -57, { on: ["T01"] }], ["setup", -48], ["work", -47.8], ["merge", -35]],
      { startedAt: at(-48), branch: `aiwb/r_${tag}/T02`, conflicts: ["cart/api/refund.go", "cart/api/routes.go"],
        agents: { work: agent("T02-work", "task", [[-47.8, -35]], { task: "T02", attempt: 1 }), merge: agent("T02-merge", "merge", [[-34.9, -33]], { task: "T02", attempt: 1, cost: 0.31, tools: 9 }) },
        ...done(-33, "The refund endpoint is in, with tests; two files conflicted with the routing change and were merged by hand."), ...merged(-33) })], { needsReport: ["T01"] }),
    task("T03", TITLES_.T03, "implement", true, [], 1, -58.6, [
      attempt(1, 1, -58.6, [["held", -58.6, { turn: 1 }], ["setup", -57], ["work", -56.8]], { tier: "standard", startedAt: at(-57), branch: `aiwb/r_${tag}/T03`, endedAt: at(-44), outcome: "failed", cost: 2.1,
        error: "agent T03-work failed: no result after 3 launches (timeout)",
        agents: { work: agent("T03-work", "task", [[-56.8, -52, QUIT], [-52, -48, QUIT], [-48, -44, "no result before the time limit"]], { task: "T03", attempt: 1, status: "failed", error: "no result after 3 launches (timeout)", cost: 2.1 }) } }),
      attempt(2, 3, -43, [["held", -43, { turn: 3 }], ["setup", -42.5], ["work", -42.3], ["merge", -14.2]], { startedAt: at(-42.5), branch: `aiwb/r_${tag}/T03-a2`,
        agents: { work: agent("T03-a2-work", "task", [[-42.3, -28], [-22, -14.2]], { task: "T03", attempt: 2 }) }, ...done(-14, "The order page shows the refund state, with a test per state."), ...merged(-14) }),
    ], { changedTurns: [3], tier: "deep", tierReason: "The standard tier ran out of time on it three times." }), // retried on a higher tier
    task("T04", TITLES_.T04, "verify", false, [], 1, -58.4, [attempt(1, 1, -58.4, [["held", -58.4, { turn: 1 }], ["setup", -57], ["work", -56.9]],
      { startedAt: at(-57), agents: { work: agent("T04-work", "task", [[-56.9, -28], [-22, null]], { task: "T04", attempt: 1, tools: 141, activity: "Bash: npm run e2e -- checkout" }) } })]),
    task("T05", TITLES_.T05, "implement", true, ["T02"], 1, -58.2, [attempt(1, 1, -58.2, [["held", -58.2, { turn: 1 }], ["deps", -57, { on: ["T02"] }], ["setup", -33], ["work", -32.8]],
      { startedAt: at(-33), branch: `aiwb/r_${tag}/T05`, endedAt: at(-12), outcome: "failed", cost: 1.9, error: "its agent reported that it could not do the task: the cart API has no endpoint for partial refunds",
        result: { outcome: "failed", summary: "The cart API has no endpoint for partial refunds, and adding one is outside this task.", reportSize: 2100 },
        agents: { work: agent("T05-work", "task", [[-32.8, -28], [-22, -12]], { task: "T05", attempt: 1, cost: 1.9 }) } })]),
    task("T06", TITLES_.T06, "docs", true, ["T05"], 2, -47.5, [attempt(1, 2, -47.5, [["held", -47.5, { turn: 2 }], ["deps", -46.5, { on: ["T05"] }], ["blocked", -12, { on: ["T05"] }]])], { needsReport: ["T05"] }),
    task("T09", TITLES_.T09, "review", false, [], 2, -47.2, [attempt(1, 2, -47.2, [["held", -47.2, { turn: 2 }], ["slot", -46.5]],
      { endedAt: at(-2.6), outcome: "cancelled", cancel: { t: at(-2.6), reason: "The copy is reviewed elsewhere.", chat: CHAT } })]),
    task("T07", TITLES_.T07, "implement", true, [], 4, -20.5, [attempt(1, 4, -20.5, [["held", -20.5, { turn: 4 }], ["slot", -19.5], ["setup", -14], ["work", -13.9]],
      { startedAt: at(-14), branch: `aiwb/r_${tag}/T07`, agents: { work: agent("T07-work", "task", [[-13.9, -7, QUIT], [-7, null]], { task: "T07", attempt: 1, tools: 37, activity: "Edit mail/refund.tmpl" }) } })]),
    task("T10", TITLES_.T10, "implement", true, ["T07"], 4, -20.2, [attempt(1, 4, -20.2, [["held", -20.2, { turn: 4 }], ["deps", -19.5, { on: ["T07"] }], ["held", -0.5, { chat: CHAT }]])],
      { briefRev: 2, briefs: [{ rev: 1, at: at(-20.2), turn: 4, size: 2400 }, { rev: 2, at: at(-0.5), chat: CHAT, size: 1900 }] }),
    task("T11", TITLES_.T11, "implement", true, [], 4, -20, [attempt(1, 4, -20, [["held", -20, { turn: 4 }], ["slot", -19.5], ["setup", -12], ["work", -11.9], ["merge", -0.8]],
      { startedAt: at(-12), branch: `aiwb/r_${tag}/T11`, head: SHA_(), base: SHA_(), conflicts: ["admin/report/totals.go"], result: { outcome: "completed", summary: "Refund totals are in the admin report.", reportSize: 3900 },
        agents: { work: agent("T11-work", "task", [[-11.9, -0.8]], { task: "T11", attempt: 1 }), merge: agent("T11-merge", "merge", [[-0.75, null]], { task: "T11", attempt: 1, tools: 3, activity: "Edit admin/report/totals.go" }) } })]),
    task("T12", TITLES_.T12, "fix", true, [], 4, -19.8, [attempt(1, 4, -19.8, [["held", -19.8, { turn: 4 }], ["slot", -19.5]])]),
    task("T08", TITLES_.T08, "docs", true, [], 6, -0.7, [attempt(1, 6, -0.7, [["held", -0.7, { chat: CHAT }]], { queuedBy: CHAT })], { addedBy: CHAT, briefs: [{ rev: 1, at: at(-0.7), chat: CHAT, size: 1700 }] }),
  ];
  const d = { run: "r_trouble", version: 180, status: "running", startedAt: at(-60), goalSize: 412, git: { baseRef: SHA_(), integrationBranch: "aiwb/r_trouble/integration", branch: "main" },
    stops: [{ at: at(-28), resumedAt: at(-22), reason: "user" }], turns, tasks,
    chatOps: [
      { i: 0, t: at(-2.6), op: "cancel_task", chat: CHAT, turn: 5, task: "T09", reason: "The copy is reviewed elsewhere." },
      { i: 1, t: at(-0.7), op: "add_task", chat: CHAT, turn: 6, task: "T08", title: TITLES_.T08, kind: "docs", writes: true, dependsOn: [], briefRev: 1 },
      { i: 2, t: at(-0.5), op: "update_task", chat: CHAT, turn: 6, task: "T10", changed: ["brief"], briefRev: 2 },
    ],
    agents, notes: [1, 2, 3, 4, 5].map((v) => { const o = turns[v - 1].ops.find((x) => x.notesVersion === v); return { v, at: o.t, turn: v, size: o.size }; }) };
  const R = addRun({ id: "r_trouble", name: "Refunds in the cart", userNamed: true, created: iso(d.startedAt - 3 * MIN), settings: { ...DEFAULT_SETTINGS, maxParallel: 3, maxTurns: 40, maxCost: 25 } }, d,
    "Add refunds to the cart: an endpoint, the order page, e-mails, the admin report, and the docs.");
  R.eng.off = true; // it stays as it is
}
/** What a run written by hand is built with. Times are minutes before now. */
function hand(tag) {
  const at = (min) => Math.round(T0 + min * MIN), ag = (name) => `a_${tag}_${name}`, agents = {};
  // an agent: launches as [from, to?, error?] in minutes; the last one open means it is running
  const agent = (name, role, launches, o = {}) => {
    const ls = launches.map(([a, b, error], i) => ({ n: i + 1, startedAt: at(a), ...(b == null ? {} : { endedAt: at(b) }), resume: i > 0, ...(error ? { error } : {}) }));
    const running = ls.at(-1).endedAt === undefined;
    agents[ag(name)] = { id: ag(name), name, role, status: running ? "running" : "done", startedAt: ls[0].startedAt, ...(running ? {} : { endedAt: ls.at(-1).endedAt }), launches: ls, cost: running ? null : 0.9, tools: 24, ...o };
    return ag(name);
  };
  const event = (seq, min, type, x, text) => ({ seq, t: at(min), type, ...(type === "chat_op" ? { chat: x } : { task: x }), text });
  // a turn: `o` over its record, `ao` over its agent's, `launches` of its agent when it had more than one
  const turn = (n, a, b, reason, wokenBy, ops, o = {}, ao = {}, launches = [[a, b]]) => {
    const name = `turn-${String(n).padStart(3, "0")}`, cost = b == null ? null : Math.round((0.38 + n * 0.07) * 100) / 100;
    agent(name, "orchestrator", launches, { turn: n, cost, tools: ops.length, ...ao });
    return { n, agent: ag(name), reason, status: b == null ? "running" : "done", startedAt: at(a), ...(b == null ? {} : { endedAt: at(b), summary: `Turn ${n} is done.` }),
      wokenBy, learned: [], ops: ops.map(([min, op, x], i) => ({ i, t: at(min), op, ...x })), cost, ...o };
  };
  const attempt = (n, queuedTurn, queued, phases, o = {}) => ({ n, queuedTurn, queuedAt: at(queued), phases: phases.map(([k, min, x]) => ({ k, t: at(min), ...x })), agents: {}, cost: null, ...o });
  const task = (id, title, kind, writes, dependsOn, addedTurn, created, attempts, o = {}) => ({ id, title, kind, writes, dependsOn, addedTurn, createdAt: at(created), changedTurns: [], briefRev: 1,
    briefs: [{ rev: 1, at: at(created), turn: addedTurn, size: 2400 }], attempts, ...o });
  const done = (end, summary, o = {}) => ({ endedAt: at(end), outcome: "done", result: { outcome: "completed", summary, reportSize: 4800 }, cost: 1.4, ...o });
  const add = (min, id, title, kind, writes, dependsOn = []) => [min, "add_task", { task: id, title, kind, writes, dependsOn, briefRev: 1 }];
  return { at, ag, agents, agent, event, turn, attempt, task, done, add };
}
const NO_TEXT = new Set(); // "<run>/<task>/<attempt>/report": the record has a result, the route answers 404
const LONG = { report: new Set(), path: new Set() }; // "<run>/<task>": a report with a wide table and a long line; changes with a 150-character path

{ // r_cases: a halted run with what the dock's views have to show (see the header)
  const tag = "cases", { at, ag, agents, agent, event, turn, attempt, task, done, add } = hand(tag);
  const GONE = "c_gone", EXIT = "the agent's process exited (code 137)", branch = (id) => `aiwb/r_${tag}/${id}`;
  const LONG_TITLE = "Index every page of the docs site for search, including the pages that are generated from the API reference at build time, and keep the index small enough to ship with the static bundle (under 300 kB)"; // 200 characters
  const TT = { T01: "Compare the client-side search libraries", T02: "Build the search index at build time", T03: LONG_TITLE, T04: "Verify the search box with a screen reader", T05: "Remove the old sitemap search",
    T06: "Review the search copy", T07: "Add a keyboard shortcut for search", T08: "Measure the size of the index" };
  const FAILED = "the agent's process exited three times in a row (code 1)";
  const e1 = event(11, -80, "task_done", "T01", "MiniSearch is the smallest library that does prefix and fuzzy search; Lunr is twice its size.");
  const turns = [
    turn(1, -90, -87, "start", [], [[-89.8, "get_run"], add(-89, "T01", TT.T01, "research", false), add(-88.8, "T02", TT.T02, "implement", true, ["T01"]), add(-88.6, "T03", TT.T03, "implement", true),
      add(-88.4, "T04", TT.T04, "verify", false), [-87.2, "set_notes", { notesVersion: 1, size: 2900 }]], { idle: true,
      summary: "Turn 1: I split the goal into four tasks.\n\n- **T01** compares the libraries first, because T02 depends on the choice.\n- T03 and T04 can start at once.\n\nNothing is running yet; the tasks start when this turn ends." }),
    // turn 2 failed; turn 3 carries its event again
    turn(2, -80, -79.5, "events", [e1], [[-79.9, "get_task", { task: "T01" }]], { status: "failed", error: FAILED, cost: null }, { status: "failed", error: FAILED, cost: null }),
    turn(3, -79, -77, "events", [e1], [[-78.8, "get_task", { task: "T01" }], add(-78, "T05", TT.T05, "fix", true, ["T02", "T03"]), add(-77.8, "T06", TT.T06, "review", false, ["T03"]), [-77.2, "set_notes", { notesVersion: 2, size: 3300 }]]),
    // turn 4 ran across the first stop (the app quit and started again)
    turn(4, -62, -47, "events", [event(12, -62, "task_done", "T02", "The index is built at build time with MiniSearch; three files conflicted with the routing change, twice.")],
      [[-61.8, "get_run"], [-48.5, "update_task", { task: "T05", changed: ["brief", "depends_on"], dependsOn: ["T02"], briefRev: 2 }],
        [-48, "cancel_task", { task: "T06", reason: "The copy is final; a review is not needed." }], [-47.2, "set_notes", { notesVersion: 3, size: 3700 }]], {}, {}, [[-62, -60], [-50, -47]]),
    turn(5, -35, -32, "resume", [],
      [[-34.8, "get_task", { task: "T03" }], [-34.6, "get_agent", { agent: "T03-work" }], [-33.4, "get_notes"], [-33, "finish_run", { outcome: "achieved", error: "3 tasks are not finished: T03, T05, T07" }],
        [-32.4, "set_notes", { notesVersion: 4, size: 4100 }]], { learned: [event(13, -34.5, "chat_op", GONE, "A chat on the run added T07: Add a keyboard shortcut for search.")] }),
    // turn 6 was running when the app quit: its record still says so
    turn(6, -8, null, "events", [event(14, -8.2, "task_done", "T05", "The old sitemap search was already gone: nothing to remove.")],
      [[-7.8, "get_run"], add(-7, "T08", TT.T08, "verify", false, ["T03"])], {}, { status: "interrupted", endedAt: at(-5) }, [[-8, -5]]),
  ];
  delete turns[1].summary;
  // turn 2 failed before it declared a wait: turn 3 starts under the one turn 2 started under. Turn 5 is the resume.
  declare(turns, { 1: [["T01"]], 3: [["T02", "T03"], "any"], 4: [["T03", "T05"]], 5: [["T03", "T05"], "any"] }, [5]);
  Object.assign(turns[2], { reason: "wait", wait: turns[1].wait, waitMet: true });
  const shas = { base: SHA_(), t02: SHA_(), t02m: SHA_(), t07: SHA_() };
  const merge1 = agent("T02-merge", "merge", [[-69.9, -66]], { task: "T02", attempt: 1, cost: 0.34, tools: 11 });
  const merge2 = agent("T02-merge-r2", "merge", [[-65.9, -62]], { task: "T02", attempt: 1, cost: 0.27, tools: 8 });
  void merge1; // the first round's agent is in the run's agents only: the attempt names the latest round's
  const tasks = [
    task("T01", TT.T01, "research", false, [], 1, -89, [attempt(1, 1, -89, [["held", -89, { turn: 1 }], ["setup", -87], ["work", -86.9]],
      { startedAt: at(-87), agents: { work: agent("T01-work", "task", [[-86.9, -80]], { task: "T01", attempt: 1 }) }, ...done(-80, e1.text, { result: { outcome: "completed", summary: e1.text, reportSize: 9100 } }) })]),
    task("T02", TT.T02, "implement", true, ["T01"], 1, -88.8, [attempt(1, 1, -88.8, [["held", -88.8, { turn: 1 }], ["deps", -87, { on: ["T01"] }], ["slot", -80], ["setup", -79.9], ["work", -79.7], ["merge", -70]],
      { startedAt: at(-79.9), branch: branch("T02"), base: shas.base, head: shas.t02, merged: shas.t02m, mergedAt: at(-62),
        conflicts: ["docs/build/routes.mjs", "docs/build/search-index.mjs", "docs/package.json"],
        agents: { work: agent("T02-work", "task", [[-79.7, -70]], { task: "T02", attempt: 1 }), merge: merge2 },
        ...done(-62, "The index is built at build time with MiniSearch; three files conflicted with the routing change, twice.", { cost: 2.01 }) })]),
    task("T03", TT.T03, "implement", true, [], 1, -88.6, [attempt(1, 1, -88.6, [["held", -88.6, { turn: 1 }], ["setup", -87], ["work", -86]],
      { startedAt: at(-87), branch: branch("T03"), base: shas.base,
        // its launches: one failed, one stopped with the app, one that could not resume its session, one stopped by the user, one interrupted by the last stop
        agents: { work: agent("T03-work", "task", [[-86, -75, EXIT], [-75, -60], [-50, -49.5, "no session"], [-49.5, -40], [-35, -5]],
          { task: "T03", attempt: 1, status: "interrupted", cost: null, tools: 212, activity: "Bash: node docs/build/search-index.mjs --all" }) } })]),
    task("T04", TT.T04, "verify", false, [], 1, -88.4, [attempt(1, 1, -88.4, [["held", -88.4, { turn: 1 }], ["setup", -87], ["work", -86.9]],
      { startedAt: at(-87), agents: { work: agent("T04-work", "task", [[-86.9, -72]], { task: "T04", attempt: 1 }) }, ...done(-72, "The search box is announced and its results are read as a list; one label is missing.") })]),
    task("T05", TT.T05, "fix", true, ["T02"], 3, -78, [attempt(1, 3, -78, [["held", -78, { turn: 3 }], ["deps", -77, { on: ["T02", "T03"] }], ["deps", -62, { on: ["T03"] }], ["held", -48.5, { turn: 4 }], ["slot", -47], ["setup", -46.9], ["work", -46.7], ["merge", -8.3]],
      { startedAt: at(-46.9), branch: branch("T05"), base: shas.t02m, head: shas.t02m, // a writing task that changed nothing
        agents: { work: agent("T05-work", "task", [[-46.7, -40], [-35, -8.3]], { task: "T05", attempt: 1 }) }, ...done(-8.2, "The old sitemap search was already gone: nothing to remove.") })],
      { changedTurns: [4], needsReport: ["T02"], briefRev: 2, briefs: [{ rev: 1, at: at(-78), turn: 3, size: 2400 }, { rev: 2, at: at(-48.5), turn: 4, size: 3100 }] }),
    task("T06", TT.T06, "review", false, ["T03"], 3, -77.8, [attempt(1, 3, -77.8, [["held", -77.8, { turn: 3 }], ["deps", -77, { on: ["T03"] }]],
      { endedAt: at(-48), outcome: "cancelled", cancel: { t: at(-48), reason: "The copy is final; a review is not needed.", turn: 4 } })]),
    task("T07", TT.T07, "implement", true, [], 5, -34.5, [attempt(1, 5, -34.5, [["held", -34.5, { chat: GONE }], ["setup", -34], ["work", -33.9], ["merge", -5.2]],
      { queuedBy: GONE, startedAt: at(-34), branch: branch("T07"), base: shas.t02m, head: shas.t07, result: { outcome: "completed", summary: "Pressing / focuses the search box on every page.", reportSize: 3600 },
        agents: { work: agent("T07-work", "task", [[-33.9, -5.2]], { task: "T07", attempt: 1 }) } })],
      { addedBy: GONE, briefs: [{ rev: 1, at: at(-34.5), chat: GONE, size: 1500 }] }),
    task("T08", TT.T08, "verify", false, ["T03"], 6, -7, [attempt(1, 6, -7, [["held", -7, { turn: 6 }]])]),
  ];
  const d = { run: "r_cases", version: 240, status: "stopped", startedAt: at(-90), goalSize: 388, git: { baseRef: shas.base, integrationBranch: "aiwb/r_cases/integration", branch: "docs-search" },
    stops: [{ at: at(-60), resumedAt: at(-50), reason: "app_quit" }, { at: at(-40), resumedAt: at(-35), reason: "user" }, { at: at(-5), reason: "app_quit" }], turns, tasks,
    chatOps: [
      { i: 0, t: at(-34.5), op: "add_task", chat: GONE, turn: 5, task: "T07", title: TT.T07, kind: "implement", writes: true, dependsOn: [], briefRev: 1 },
      { i: 1, t: at(-34.3), op: "retry_task", chat: GONE, turn: 5, task: "T01", error: "T01 is done: only a failed or cancelled task can be retried" },
      { i: 2, t: at(-31.5), op: "set_notes", chat: GONE, turn: 5, notesVersion: 5, size: 4300 },
    ],
    agents, notes: [{ v: 1, at: at(-87.2), turn: 1, size: 2900 }, { v: 2, at: at(-77.2), turn: 3, size: 3300 }, { v: 3, at: at(-47.2), turn: 4, size: 3700 }, { v: 4, at: at(-32.4), turn: 5, size: 4100 }, { v: 5, at: at(-31.5), chat: GONE, size: 4300 }] };
  NO_TEXT.add("r_cases/T04/1/report"); LONG.report.add("r_cases/T01"); LONG.path.add("r_cases/T02");
  addRun({ id: "r_cases", name: "Search in the docs site", userNamed: true, created: iso(d.startedAt - 2 * MIN), reason: CRASH, settings: { ...DEFAULT_SETTINGS, maxParallel: 3, maxTurns: 40 } }, d,
    "# Search in the docs site\n\nAdd a search box to the docs site.\n\n- The index is built at **build time** and shipped with the static bundle.\n- It covers every page, the generated API reference included.\n- It works from the keyboard and with a screen reader.\n\nDone when `npm run build` makes the index and the search box finds a page by a word of its title.");
}
{ // r_plain: a finished run in a folder that is not a git repository
  const b = hand("plain");
  const TT = { T01: "List what is in the scratch folder", T02: "Sort the loose notes into folders by year", T03: "Write an index of the folder" };
  const ev1 = b.event(21, -31, "task_done", "T01", "The folder has 214 loose notes from 2019 to 2025 and three scripts."), ev2 = b.event(22, -18, "task_done", "T02", "The notes are in a folder per year; nothing was deleted.");
  const summary = "# The scratch folder is tidy\n\nEvery loose note is in a folder for its year and `INDEX.md` lists them.\n\n| Year | Notes |\n|---|---|\n| 2019–2021 | 81 |\n| 2022–2025 | 133 |\n\nNothing was deleted; the three scripts are where they were.";
  const turns = declare([
    b.turn(1, -40, -38, "start", [], [[-39.8, "get_run"], b.add(-39, "T01", TT.T01, "research", false), b.add(-38.8, "T02", TT.T02, "implement", true, ["T01"]), [-38.2, "set_notes", { notesVersion: 1, size: 1800 }]], { idle: true }),
    b.turn(2, -31, -30, "events", [ev1], [[-30.9, "get_task", { task: "T01" }], b.add(-30.5, "T03", TT.T03, "docs", true, ["T02"]), [-30.2, "set_notes", { notesVersion: 2, size: 2100 }]]),
    b.turn(3, -18, -17.5, "events", [ev2], [[-17.9, "get_task", { task: "T02" }], [-17.6, "set_notes", { notesVersion: 3, size: 2300 }]]),
    b.turn(4, -10, -9, "events", [b.event(23, -10, "task_done", "T03", "INDEX.md lists every note by year.")], [[-9.8, "get_run"], [-9.3, "finish_run", { outcome: "achieved", text: "The scratch folder is tidy." }]], { summary }),
  ], { 1: [["T01"]], 2: [["T02"]], 3: [["T03"]] });
  // no branch, no merge phase, an empty base: the agents work in the folder itself
  const tasks = [
    b.task("T01", TT.T01, "research", false, [], 1, -39, [b.attempt(1, 1, -39, [["held", -39, { turn: 1 }], ["setup", -38], ["work", -37.9]], { startedAt: b.at(-38), base: "", agents: { work: b.agent("T01-work", "task", [[-37.9, -31]], { task: "T01", attempt: 1 }) }, ...b.done(-31, ev1.text) })]),
    b.task("T02", TT.T02, "implement", true, ["T01"], 1, -38.8, [b.attempt(1, 1, -38.8, [["held", -38.8, { turn: 1 }], ["deps", -38, { on: ["T01"] }], ["setup", -31], ["work", -30.9]], { startedAt: b.at(-31), base: "", agents: { work: b.agent("T02-work", "task", [[-30.9, -18]], { task: "T02", attempt: 1 }) }, ...b.done(-18, ev2.text) })], { needsReport: ["T01"] }),
    b.task("T03", TT.T03, "docs", true, ["T02"], 2, -30.5, [b.attempt(1, 2, -30.5, [["held", -30.5, { turn: 2 }], ["deps", -30, { on: ["T02"] }], ["setup", -18], ["work", -17.9]], { startedAt: b.at(-18), base: "", agents: { work: b.agent("T03-work", "task", [[-17.9, -10]], { task: "T03", attempt: 1 }) }, ...b.done(-10, "INDEX.md lists every note by year.") })]),
  ];
  const d = { run: "r_plain", version: 90, status: "completed", startedAt: b.at(-40), endedAt: b.at(-9), goalSize: 96, stops: [], turns, tasks, chatOps: [], agents: b.agents,
    notes: [{ v: 1, at: b.at(-38.2), turn: 1, size: 1800 }, { v: 2, at: b.at(-30.2), turn: 2, size: 2100 }, { v: 3, at: b.at(-17.6), turn: 3, size: 2300 }],
    result: { outcome: "achieved", summary, turn: 4, at: b.at(-9) }, delivery: { state: "none", reason: "no_git" } };
  addRun({ id: "r_plain", name: "Tidy the scratch notes", userNamed: true, created: iso(d.startedAt - MIN), cwd: HOME + "/projects/scratch", settings: { ...DEFAULT_SETTINGS } }, d,
    "Sort the loose notes in this folder into a folder per year and write an index. Delete nothing.");
}
{ // r_err2: as r_error, in the server's order: the halt first (the stop opens), the turn ends "failed" 40 ms later
  const t9 = REAL.turns.find((t) => t.n === 9), at = t9.startedAt + 45000, by = T0 - 52 * 60 * MIN - at;
  const d = cutAt(derive("r_err2", "err2", by), at + by);
  const turn = d.turns.at(-1);
  halt(d, at + by, "error", "error");
  Object.assign(turn, { status: "failed", endedAt: at + by + 40, error: "the agent's process exited three times in a row (code 1)" });
  Object.assign(d.agents[turn.agent], { status: "failed", endedAt: at + by + 40, error: turn.error });
  addRun({ id: "r_err2", name: "Flaky test hunt, again", userNamed: true, created: iso(d.startedAt - MIN), reason: `orchestrator turn ${turn.n}: ${turn.error}` }, d, "Find and fix the flaky tests of the Go packages.");
}
{ // r_old: finished two days ago and ran over (local) midnight; its folder had uncommitted changes when it started
  const midnight = new Date(T0); midnight.setHours(0, 0, 0, 0);
  const d = derive("r_old", "old", midnight.getTime() - 48 * 60 * MIN - (REAL.startedAt + REAL.endedAt) / 2);
  d.git.dirtyAtStart = true;
  // its result waits for the user: the run was set to "manual"
  addRun({ id: "r_old", name: "Night shift QA", userNamed: true, created: iso(d.startedAt), settings: { ...DEFAULT_SETTINGS, setup: "cd web && npm ci", applyResult: "manual" } }, d, GOAL_QA);
}
{ // r_waiting: a live run between two turns: it waits for T02 and T03, both at work
  const b = hand("waiting");
  const TT = { T01: "Find where the storefront sets its colours", T02: "Add the dark palette to the theme tokens", T03: "Make the product pages pass the contrast check", T04: "Verify every page in dark mode" };
  const ev1 = b.event(31, -21, "task_done", "T01", "Every colour comes from 14 tokens in theme/tokens.css; the product pages override six of them inline.");
  const turns = declare([
    b.turn(1, -32, -30, "start", [], [[-31.8, "get_run"], b.add(-31, "T01", TT.T01, "research", false), [-30.4, "set_notes", { notesVersion: 1, size: 1600 }]], { idle: true }),
    b.turn(2, -21, -19, "events", [ev1], [[-20.9, "get_task", { task: "T01" }], b.add(-20.4, "T02", TT.T02, "implement", true, ["T01"]), b.add(-20.2, "T03", TT.T03, "implement", true, ["T01"]),
      b.add(-20, "T04", TT.T04, "verify", false, ["T02", "T03"]), [-19.5, "edit_notes", { notesVersion: 2, size: 2200, heading: "Plan" }]]),
  ], { 1: [["T01"]], 2: [["T02", "T03"]] });
  const branch = (id) => `aiwb/r_waiting/${id}`, base = SHA_();
  const tasks = [
    b.task("T01", TT.T01, "research", false, [], 1, -31, [b.attempt(1, 1, -31, [["held", -31, { turn: 1 }], ["setup", -30], ["work", -29.9]], { startedAt: b.at(-30), agents: { work: b.agent("T01-work", "task", [[-29.9, -21]], { task: "T01", attempt: 1 }) }, ...b.done(-21, ev1.text) })]),
    b.task("T02", TT.T02, "implement", true, ["T01"], 2, -20.4, [b.attempt(1, 2, -20.4, [["held", -20.4, { turn: 2 }], ["setup", -19], ["work", -18.8]], { startedAt: b.at(-19), branch: branch("T02"), base,
      agents: { work: b.agent("T02-work", "task", [[-18.8, null]], { task: "T02", attempt: 1, tools: 63, activity: "Edit theme/tokens.css" }) } })], { needsReport: ["T01"] }),
    b.task("T03", TT.T03, "implement", true, ["T01"], 2, -20.2, [b.attempt(1, 2, -20.2, [["held", -20.2, { turn: 2 }], ["setup", -19], ["work", -18.7]], { startedAt: b.at(-19), branch: branch("T03"), base,
      agents: { work: b.agent("T03-work", "task", [[-18.7, null]], { task: "T03", attempt: 1, tools: 48, activity: "Bash: npm run contrast -- product" }) } })], { needsReport: ["T01"] }),
    b.task("T04", TT.T04, "verify", false, ["T02", "T03"], 2, -20, [b.attempt(1, 2, -20, [["held", -20, { turn: 2 }], ["deps", -19, { on: ["T02", "T03"] }]])]),
  ];
  const d = { run: "r_waiting", version: 60, status: "running", startedAt: b.at(-32), goalSize: 77, git: { baseRef: base, integrationBranch: "aiwb/r_waiting/integration", branch: "main" }, stops: [], turns, tasks, chatOps: [], agents: b.agents,
    notes: [{ v: 1, at: b.at(-30.4), turn: 1, size: 1600 }, { v: 2, at: b.at(-19.5), turn: 2, size: 2200 }] };
  const R = addRun({ id: "r_waiting", name: "Dark mode for the storefront", userNamed: true, created: iso(d.startedAt - MIN) }, d, "Add a dark mode to the storefront and make every page pass the contrast check.");
  R.eng.off = true; // it stays as it is
}
{ // r_stallidle: its last three turns started with nothing running and their wait not met
  const d = runs.r_stallidle.detail;
  for (const t of d.turns.slice(-3)) Object.assign(t, { reason: "idle", idle: true, waitMet: false, wokenBy: [] });
}
{ // what became of each finished or halted run's result (see the header)
  const FILES = ["docs/de/index.md", "docs/de/install.md", "docs/glossary.md"];
  const set = (id, v) => { const d = runs[id].detail, at = d.endedAt ?? d.stops.at(-1)?.at; d.delivery = { ...v, ...(v.state === "none" ? {} : { at: at + 1500, result: d.git.resultHead ?? SHA_(), branch: d.git.branch ?? "main" }) }; };
  set("r_done", { state: "applied", auto: true, how: "ff", commit: runs.r_done.detail.git.resultHead });
  set("r_cursor", { state: "blocked", reason: "local_changes", auto: true, files: FILES });
  set("r_gaveup", { state: "pending", reason: "not_achieved" });
  set("r_old", { state: "pending", reason: "manual" });
  for (const R of Object.values(runs)) {
    const d = R.detail;
    if (d && !d.delivery && d.git && ["stopped", "stalled", "error"].includes(d.status)) set(R.meta.id, { state: "pending", reason: "halted", partial: true });
  }
}
// r_unreadable: the server lists a run whose record it cannot read, and answers nothing else about it
addRun({ id: "r_unreadable", name: "r_unreadable", created: iso(T0 - 300 * MIN), unreadable: true });
addRun({ id: "r_draft", name: "New run", group: UNGROUPED, created: iso(T0 - 2 * MIN), draft: { text: "Add a dark mode to the storefront and make every page pass the contrast check." } });
addRun({ id: "r_nogit", name: "Tidy the scratch folder", userNamed: true, created: iso(T0 - 30 * MIN), cwd: HOME + "/projects/scratch", settings: { ...DEFAULT_SETTINGS } });
addRun({ id: "r_blocked", name: "Bootstrap the new service", userNamed: true, created: iso(T0 - 40 * MIN), cwd: HOME + "/projects/empty-repo", settings: { ...DEFAULT_SETTINGS } });
addRun({ id: "r_dirty", name: "Polish the checkout copy", userNamed: true, created: iso(T0 - 20 * MIN), dirty: true, draft: { text: "Go through the checkout pages and fix the copy." } });
addRun({ id: "r_missing", name: "Port the importer", userNamed: true, created: iso(T0 - 50 * MIN), cwd: HOME + "/projects/importer", settings: { ...DEFAULT_SETTINGS, maxCost: 20 } });

// ---- groups, boards, chats

const groups = [{ id: "g_shop", name: "Shop" }];
const boards = { b_arch: { id: "b_arch", name: "arch", group: "g_shop", created: iso(T0 - 5000 * MIN) } };
const usage = { ctxIn: 42000, ctxOut: 900, ctxWindow: 200000, turns: 3 };
const fresh = { locked: false, usage: { ...usage, ctxIn: 0, ctxOut: 0, turns: 0 } };
const chat = (id, o) => ({ id, agent: "claude", cwd: SHOP, model: "opus", effort: "high", locked: true, created: iso(T0 - 30 * MIN), usage, status: "ready", ...o });
const chats = {
  c_plain: chat("c_plain", { name: "Why is the build slow", group: "g_shop" }),
  c_board: chat("c_board", { name: "Draw the pipeline", board: "b_arch" }),
  c_live_ask: chat("c_live_ask", { name: "What is it doing", run: "r_live", created: iso(T0 - 20 * MIN) }),
  c_live_new: chat("c_live_new", { run: "r_live", created: iso(T0 - 5 * MIN), ...fresh, draft: { text: "why did T07 take so long" } }),
  c_draft_ask: chat("c_draft_ask", { run: "r_draft", created: iso(T0 - MIN), ...fresh }),
  c_trouble_ask: chat("c_trouble_ask", { name: "Trim the refund work", run: "r_trouble", created: iso(T0 - 3 * MIN), status: "tool", statusTool: "mcp__board__update_task" }), // still replying: what it changed is held
};
const tool = (id, name, input, result, more) => ({ kind: "tool", toolId: id, name, input, ...(result === undefined ? {} : { result }), ...more });
const say = (text, done = true) => ({ kind: "text", done, text });
const items = { // by chat id; an agent's are written when first asked for
  c_plain: [{ kind: "user", text: "Why is the build slow?" }, say("Because of the font copy step."), { kind: "end" }],
  c_board: [], c_live_new: [], c_draft_ask: [],
  c_trouble_ask: [
    { kind: "user", text: "Cancel T09, add a task that documents the refund flow, and make T10's brief shorter." },
    tool("u1", "mcp__board__cancel_task", { id: "T09", reason: "The copy is reviewed elsewhere." }, "T09 is cancelled."),
    tool("u2", "mcp__board__add_task", { title: "Document the refund flow", brief: "Write docs/refunds.md: …", kind: "docs", writes: true }, "Added T08. It starts after your turn ends."),
    tool("u3", "mcp__board__update_task", { id: "T10", brief: "Translate the refund e-mail to German only." }),
  ],
  c_live_ask: [
    { kind: "user", text: "What is the run doing right now?" },
    tool("t1", "mcp__board__get_run", {}, "Run QA of the last few features: running. Turn 14. Tasks: 23 done, 5 running, 5 waiting."),
    tool("t2", "mcp__board__get_task", { id: "T11" }, "T11 [verify, reports only] work: Exercise forking and branching with running subagents…"),
    tool("t3", "mcp__board__get_agent", { agent: "T11-work", last: 15 }, "T11-work, running for 4 min, 31 tool calls.\n…"),
    tool("t4", "mcp__board__get_notes", {}, "Version 14, 21,480 characters, written in turn 13.\n…"),
    say("Turn 14 is running. Four tasks are at work: **T11** exercises forking with running subagents, T23 and T28 are fixing code, and T27 is being merged (two files conflicted). T22 is held until the turn ends."),
    { kind: "end" },
    { kind: "user", text: "Retry T07, cancel T99, add a task to document the fork tree, and tell the orchestrator to keep the e2e script green." },
    tool("t5", "mcp__board__retry_task", { id: "T07", reason: "The user asked for another pass." }, "T07 is queued again as attempt 2. It starts after your turn ends."),
    tool("t6", "mcp__board__cancel_task", { id: "T99", reason: "Not needed." }, "no task T99", { isError: true }),
    tool("t7", "mcp__board__add_task", { title: "Document the fork tree", brief: "Write docs/fork-tree.md: …", kind: "docs", writes: true }, "Added T34. It starts after your turn ends."),
    tool("t8", "mcp__board__tell_orchestrator", { text: "Keep the e2e script green: run it before every merge." }, "Passed on. The orchestrator reads it when its next turn starts, after the turn that is running."),
    tool("t9", "mcp__board__some_future_tool", { id: "T07" }, "ok"),
    say("Done: T07 is queued again as attempt 2 and T34 is added. There is no task T99, so nothing was cancelled. The orchestrator gets your note with its next turn."),
    { kind: "end" },
  ],
};
const versions = {};  // by thread key (chat id, or "<chat>/<sid>"): the version of its items
const subs = {};      // by agent chat id: its subagents
const subItems = {};  // by "<chat>/<sid>"

/** The run and the record of a run agent, by its chat id. */
function agentOf(id) {
  for (const R of Object.values(runs)) if (R.detail?.agents[id]) return { R, a: R.detail.agents[id] };
  return null;
}

/** A run agent as a chat-shaped record. */
function agentChat(id) {
  const f = agentOf(id);
  if (!f) return null;
  const { R, a } = f, m = R.meta, running = a.status === "running";
  return chat(id, {
    agent: m.agent, model: a.model, effort: a.effort, name: a.name, run: m.id, role: a.role,
    cwd: a.role === "orchestrator" ? m.cwd : `${m.cwd}-worktrees/${R.tag}/${a.task}`,
    created: iso(a.startedAt), usage: { ...usage, turns: a.launches.length },
    status: running ? (a.role === "merge" ? "thinking" : "tool") : a.status === "failed" ? "error" : a.status === "done" ? "ready" : "stopped",
    ...(running && a.role !== "merge" ? { statusTool: "Bash" } : {}), ...(a.error ? { error: a.error } : {}),
    ...(subs[id]?.some((s) => s.status === "running") ? { subsRunning: 1 } : {}),
  });
}

/** An agent's transcript, written from its record when first asked for. */
function agentItems(id) {
  if (items[id]) return items[id];
  const f = agentOf(id);
  if (!f) return null;
  const { R, a } = f, d = R.detail, running = a.status === "running", out = [];
  if (a.role === "orchestrator") {
    const turn = d.turns.find((t) => t.agent === id);
    const woke = turn?.wokenBy.map((e) => `- ${e.type}${e.task ? " " + e.task : ""}: ${e.text}`).join("\n") || "- nothing: the run is starting";
    out.push({ kind: "user", text: `You are the orchestrator of this run. This is turn ${a.turn}.\n\n## New since your last turn\n\n${woke}\n\nRead the run with get_run, decide, and end your turn.` });
    for (const o of turn?.ops ?? []) {
      const input = o.op === "add_task" ? { title: o.title, brief: "…", kind: o.kind, writes: o.writes, depends_on: o.dependsOn }
        : o.op === "set_notes" ? { notes: "…" } : o.op === "edit_notes" ? { heading: o.heading, text: "…" } : o.op === "wait_for" ? { tasks: o.tasks, mode: o.mode }
        : o.op === "retry_task" ? { id: o.task, reason: o.reason, ...(o.tier ? { tier: o.tier } : {}) } : o.op === "finish_run" ? { outcome: o.outcome, summary: o.text }
        : o.op === "get_agent" ? { agent: o.agent } : o.task ? { id: o.task, ...(o.reason ? { reason: o.reason } : {}) } : {};
      out.push(tool(`o${o.i}`, `mcp__board__${o.op}`, input, o.error ?? "ok", o.error ? { isError: true } : undefined));
    }
    if (turn?.summary) out.push(say(turn.summary), { kind: "end" });
    else if (running) out.push(say("Reading what the finished tasks found before I decide what comes next", false));
  } else {
    const task = d.tasks.find((t) => t.id === a.task), att = task?.attempts.find((x) => x.n === a.attempt);
    if (a.role === "merge") {
      const files = att?.conflicts ?? [];
      out.push({ kind: "user", text: `Merge the branch of task ${a.task} into the run's integration branch and resolve the conflicts.\n\n**Task:** ${task?.title}\n\nConflicting files:\n${files.map((x) => "- " + x).join("\n")}` });
      out.push(tool("m1", "Bash", { command: `git merge --no-ff ${att?.branch ?? "aiwb/" + a.task}`, description: "Merge the task branch" }, "CONFLICT (content): Merge conflict in " + (files[0] ?? "a file"), { isError: true }));
      for (const [i, x] of files.entries()) out.push(tool(`m${i + 2}`, "Edit", { file_path: x }, running && i === files.length - 1 ? undefined : "ok"));
      if (!running) out.push(say("Both sides are kept: the merge is committed."), { kind: "end" });
    } else {
      out.push({ kind: "user", text: `# Task ${a.task}: ${task?.title}\n\nKind: ${task?.kind}. ${task?.writes ? "Your changes are merged when you are done." : "Report only: change nothing."}\n\n(The brief's full text is a placeholder in the mock.)\n\nEnd with a <result> block.` });
      out.push(say("I'll read the code this touches first, then make the change and run the tests."));
      out.push(tool("w1", "Read", { file_path: "internal/chats/manager.go" }, "package chats\n…"), tool("w2", "Grep", { pattern: "func \\(m \\*Manager\\)" }, "41 matches"));
      if (id === AG.sub) {
        out.push({ ...tool("w3", "mcp__board__spawn_subagent", { description: "Review the fork cut for off-by-one errors", prompt: "Check every index computation in internal/chats/fork.go against the branch model in docs and report mismatches." }), subagent: "s1" });
        out.push(say("The reviewer checks the cut points while I run the scenarios."));
      } else if (task?.writes) out.push(tool("w3", "Edit", { file_path: "internal/chats/manager.go" }, "ok"));
      if (running) out.push(tool("w4", "Bash", { command: "go test ./internal/chats/", description: "Run the chats tests" }));
      else out.push(tool("w4", "Bash", { command: "go test ./...", description: "Run the tests" }, "ok  \tai-whiteboard/internal/chats\t2.41s"), say(att?.result?.summary ?? a.error ?? "Stopped before a result."), { kind: "end" });
    }
  }
  if (id === AG.sub && running) {
    subs[id] = [{ id: "s1", tool: "w3", description: "Review the fork cut for off-by-one errors", prompt: "Check every index computation in internal/chats/fork.go against the branch model in docs and report mismatches.",
      kind: "claude", model: "sonnet", effort: "medium", status: "running", started: T0 - 95000, tokens: 31000, window: 200000, toolUses: 6 }];
    subItems[`${id}/s1`] = [say("Reading the fork code and the branch model."), tool("s1a", "Read", { file_path: "internal/chats/fork.go" }, "…"), tool("s1b", "Grep", { pattern: "at \\+ 1" }, "3 matches"),
      say("Two of the three cut computations count the user message twice, which", false)];
  }
  versions[id] = 1;
  return (items[id] = out);
}

// ---- the stream

let clients = []; // the open streams: { id (the tab's client id), res, watched: the agents whose /items it fetched on this connection }
const write = (c, m) => c.res.write(`data: ${JSON.stringify(m)}\n\n`);
const send = (m) => { for (const c of clients) write(c, m); };
/** An agent's transcript event: to the clients that watch it, or to all for the one that streams always. */
const sendAgent = (id, m) => { for (const c of clients) if (id === AG.always || c.watched.has(id)) write(c, m); };
const snapshot = () => ({
  groups, boards: Object.values(boards),
  chats: [...Object.values(chats), agentChat(AG.listed) /* a server that lists an agent: the client must drop it */].filter(Boolean), // null once r_live is deleted
  runs: Object.values(runs).map(view),
  defaults: { last: {}, groups: {} }, catalogs, home: HOME, defaultCwd: SHOP, dataDir: DATA,
});

/** Sends `run` when the light view differs from the last one sent. */
function sendRun(R) {
  const v = view(R), s = JSON.stringify(v);
  if (R.sent !== s) { R.sent = s; send({ type: "run", run: v }); }
  return v;
}
for (const R of Object.values(runs)) R.sent = JSON.stringify(view(R));

/** One committed change of a started run: version +1, `run_detail` with the records it touched, then `run`. */
function commit(R, patch) {
  const d = R.detail;
  d.version++;
  send({ type: "run_detail", run: d.run, version: d.version, patch: clone(patch) });
  sendRun(R);
}

// BIG=1: r_big, a running run of 297 tasks and 98 turns made of copies of r_live (also `touch(run, task)` for /mock/eval)
if (process.env.BIG) eval(fs.readFileSync(path.resolve(HERE, "runmock-big.js"), "utf8"));

// ---- the engine: one step of a running run's life per call

const SHA = SHA_;
const TITLES = ["Cover the draft saver with tests", "Fix the picker's keyboard focus", "Remove the dead retry loop", "Document the branch model", "Speed up the sidebar tree build",
  "Check the takeover screen in dark mode", "Make the context meter round the same way everywhere", "Review the fork banner's wording"];
const ACTIVITY = ["Bash: go test ./internal/chats/ -run TestFork", "Read web/src/Composer.tsx", "Edit internal/agents/pi/adapter.go", "Bash: node --test test/forktree.test.ts", "Grep \"pendingMove\" web/src", "Subagent: Review the fork cut"];
const pad = (n, w) => String(n).padStart(w, "0");

function step(R) {
  const d = R.detail, e = R.eng, now = Date.now(), cursorRun = R.meta.agent === "cursor";
  if (!d || d.status !== "running" || R.meta.archived || e.off) return;
  const p = { turns: [], tasks: [], agents: {}, notes: [] };
  const done = () => { for (const k of ["turns", "tasks", "notes"]) if (!p[k].length) delete p[k]; if (!Object.keys(p.agents).length) delete p.agents; commit(R, p); };
  const agent = (rec) => { d.agents[rec.id] = rec; p.agents[rec.id] = rec; return rec; };
  const close = (a, status, cost) => { Object.assign(a, { status, endedAt: now, cost: cursorRun ? null : cost }, cursorRun ? {} : usageOf(cost, a.model)); a.launches.at(-1).endedAt = now; delete a.activity; p.agents[a.id] = a; };
  // an agent that starts: its tier's model, and nothing used yet
  const start = (tier) => ({ ...onTier(R, tier, 0), ...(cursorRun ? {} : { peakContext: 0 }) });
  let turn = d.turns.find((t) => t.status === "running");
  const subject = () => d.tasks.find((t) => t.id === e.subject);
  const op = (o) => { const rec = { i: turn.ops.length, t: now, ...o }; turn.ops.push(rec); p.turns.push(turn); return rec; };
  if (!turn && e.step > 0 && e.step < 5) e.step = 0;
  if (turn && e.step === 0) e.step = 1;
  switch (e.step) {
    case 0: { // a turn starts
      const n = (d.turns.at(-1)?.n ?? 0) + 1;
      if (n > R.meta.settings.maxTurns) { // the turn limit: the run stalls
        Object.assign(R.meta, { stalledBy: "turns", reason: turnsReason(R.meta.settings.maxTurns), activeMs: R.meta.activeMs + (now - R.meta.asOf), asOf: now });
        halt(d, now, "stalled", "stalled");
        return commit(R, { status: d.status, stops: d.stops, agents: Object.fromEntries(Object.values(d.agents).filter((a) => a.endedAt === now).map((a) => [a.id, a])) });
      }
      const id = `a_${R.tag}_turn-${pad(n, 3)}`, wokenBy = e.inbox.splice(0);
      // its wait (the one task the turn before queued) is met when that task is done; a failed task starts it early
      const met = !!e.wait && !e.resumed && wokenBy.some((x) => x.type === "task_done");
      turn = { n, agent: id, reason: n === 1 ? "start" : e.resumed ? "resume" : met ? "wait" : wokenBy.length ? "events" : "idle", status: "running", startedAt: now,
        ...(e.wait ? { wait: e.wait, waitMet: met } : {}), wokenBy, learned: [], ops: [], cost: null };
      e.resumed = false; e.wait = null;
      d.turns.push(turn); p.turns.push(turn);
      agent({ id, name: `turn-${pad(n, 3)}`, role: "orchestrator", turn: n, status: "running", startedAt: now, launches: [{ n: 1, startedAt: now, resume: false }], cost: null, ...start("deep") });
      e.step = 1; break;
    }
    case 1: op({ op: "get_run" }); e.step = 2; break;
    case 2: { // the turn adds a task, or retries the one that failed
      const failed = d.tasks.find((t) => t.id === e.retry);
      if (failed) {
        const n = failed.attempts.length + 1;
        const tierReason = "It failed on a lower tier.";
        op({ op: "retry_task", task: failed.id, reason: "One more attempt, on the deep tier.", attempt: n, tier: "deep", tierReason });
        Object.assign(failed, { tier: "deep", tierReason });
        failed.attempts.push({ n, tier: "deep", queuedTurn: turn.n, queuedAt: now, phases: [{ k: "held", t: now, turn: turn.n }], agents: {}, cost: null });
        failed.changedTurns.push(turn.n);
        e.subject = failed.id; e.retry = null; p.tasks.push(failed);
      } else {
        const id = "T" + pad(d.tasks.length + 1, 2), title = TITLES[e.made % TITLES.length], writes = e.made % 5 !== 4, kind = writes ? "fix" : "review";
        const tier = tierOf(kind), tierReason = TIER_WHY[tier];
        e.made++;
        op({ op: "add_task", task: id, title, kind, writes, dependsOn: [], tier, tierReason, briefRev: 1 });
        const task = { id, title, kind, writes, dependsOn: [], needsReport: [], tier, tierReason, addedTurn: turn.n, createdAt: now, changedTurns: [], briefRev: 1, briefs: [{ rev: 1, at: now, turn: turn.n, size: 2400 }],
          attempts: [{ n: 1, tier, queuedTurn: turn.n, queuedAt: now, phases: [{ k: "held", t: now, turn: turn.n }], agents: {}, cost: null }] };
        d.tasks.push(task); p.tasks.push(task); e.subject = id;
      }
      e.step = 3; break;
    }
    case 3: { // the turn writes its notes
      const v = (d.notes.at(-1)?.v ?? 0) + 1, size = 4000 + v * 310;
      op({ op: "set_notes", notesVersion: v, size });
      const nv = { v, at: now, turn: turn.n, size }; d.notes.push(nv); p.notes.push(nv);
      e.step = 4; break;
    }
    case 4: { // the turn says what it waits for and ends: what it held starts to wait for a slot
      if (e.subject) { op({ op: "wait_for", tasks: [e.subject], mode: "all" }); e.wait = { tasks: [e.subject], mode: "all", turn: turn.n }; }
      Object.assign(turn, { status: "done", endedAt: now, summary: `Turn ${turn.n}: queued ${e.subject}.`, cost: cursorRun ? null : 0.42 });
      p.turns.push(turn);
      close(d.agents[turn.agent], "done", 0.42);
      for (const t of d.tasks) { const a = t.attempts.at(-1); if (!a.outcome && a.phases.at(-1).k === "held" && a.phases.at(-1).turn === turn.n) { a.phases.push({ k: "slot", t: now }); p.tasks.push(t); } }
      e.step = 5; break;
    }
    case 5: { // a slot is taken: setup
      const t = subject(), a = t.attempts.at(-1);
      a.phases.push({ k: "setup", t: now }); a.startedAt = now;
      if (d.git && t.writes) { a.branch = `aiwb/${R.meta.id}/${t.id}${a.n > 1 ? "-a" + a.n : ""}`; a.base = SHA(); }
      p.tasks.push(t); e.step = 6; break;
    }
    case 6: { // the work agent is launched
      const t = subject(), a = t.attempts.at(-1), name = `${t.id}${a.n > 1 ? "-a" + a.n : ""}-work`, id = `a_${R.tag}_${name}`;
      a.phases.push({ k: "work", t: now }); a.agents.work = id;
      agent({ id, name, role: "task", task: t.id, attempt: a.n, status: "running", startedAt: now, launches: [{ n: 1, startedAt: now, resume: false }], cost: null, tools: 0, ...start(a.tier) });
      p.tasks.push(t); e.step = 7; break;
    }
    case 7: { // its process dies and is launched again
      const a = d.agents[subject().attempts.at(-1).agents.work];
      Object.assign(a.launches.at(-1), { endedAt: now, error: "the agent's process exited (code 143)" });
      a.launches.push({ n: a.launches.length + 1, startedAt: now, resume: true });
      p.agents[a.id] = a; e.step = 8; break;
    }
    case 8: { // the work is in; a writing task is merged
      const t = subject(), a = t.attempts.at(-1);
      a.result = { outcome: "completed", summary: `${t.title}: done as briefed, with tests.`, reportSize: 5200 };
      close(d.agents[a.agents.work], "done", 1.37);
      if (d.git && t.writes) {
        a.phases.push({ k: "merge", t: now }); a.head = SHA();
        if (e.made % 3 === 0) {
          const name = `${t.id}${a.n > 1 ? "-a" + a.n : ""}-merge`, id = `a_${R.tag}_${name}`;
          a.conflicts = ["web/src/conn.ts", "web/src/store.ts"]; a.agents.merge = id;
          agent({ id, name, role: "merge", task: t.id, attempt: a.n, status: "running", startedAt: now, launches: [{ n: 1, startedAt: now, resume: false }], cost: null, tools: 0, ...start("standard") });
        }
      }
      p.tasks.push(t); e.step = 9; break;
    }
    case 9: { // the attempt ends, and wakes the next turn
      const t = subject(), a = t.attempts.at(-1), fails = e.made % 4 === 0 && a.n === 1;
      if (a.agents.merge) close(d.agents[a.agents.merge], fails ? "failed" : "done", 0.21);
      a.endedAt = now; a.cost = cursorRun ? null : 1.58;
      if (fails) Object.assign(a, { outcome: "failed", error: "its changes could not be merged: the tests fail on the integration branch" });
      else { a.outcome = "done"; if (a.head) { a.mergedAt = now; a.merged = SHA(); } }
      e.inbox.push({ seq: ++e.seq, t: now, type: fails ? "task_failed" : "task_done", task: t.id, text: fails ? a.error : a.result.summary });
      if (fails) e.retry = t.id;
      p.tasks.push(t); e.subject = null; e.step = 0; break;
    }
  }
  done();
}

/** `run_activity` for the running agents of a run: a line, a tool count and (but for Cursor) the fullest context each, and what changed only. */
function activity(R) {
  const d = R.detail;
  if (!d || d.status !== "running") return;
  const agents = {};
  R.beat = (R.beat ?? 0) + 1;
  for (const [i, a] of Object.values(d.agents).filter((x) => x.status === "running").entries()) {
    if ((R.beat + i) % 2) continue; // not every agent moves every round
    a.tools = (a.tools ?? 10 + i * 7) + 1; a.activity = ACTIVITY[(R.beat + i) % ACTIVITY.length];
    agents[a.id] = { activity: a.activity, tools: a.tools };
    if (R.meta.agent !== "cursor") { a.peakContext = Math.min(186000, (a.peakContext || 18000) + 1300); agents[a.id].peakContext = a.peakContext; }
  }
  if (Object.keys(agents).length) send({ type: "run_activity", run: d.run, agents });
}

/** The transcript events of running agents: of those watched on this connection, and of one that streams always. */
let beat = 0;
function stream() {
  beat++;
  for (const id of new Set([...clients.flatMap((c) => [...c.watched]), AG.always])) {
    const c = agentChat(id);
    if (!c || !agentOf(id) || agentOf(id).a.status !== "running") continue;
    const list = agentItems(id), at = list.length - (list.at(-1).kind === "text" && !list.at(-1).done ? 1 : 0);
    list[at] = say(`Still working… ${beat} checks done`, false);
    versions[id]++;
    sendAgent(id, { type: "chat_items", chat: id, branch: "main", version: versions[id], updates: [{ index: at, item: list[at] }] });
    sendAgent(id, { type: "chat", chat: { ...c, status: beat % 2 ? "writing" : "tool", ...(beat % 2 ? { statusTool: undefined } : { statusTool: "Bash" }) } });
    const sa = subs[id]?.[0];
    if (sa) { sa.toolUses++; sa.tokens += 400; sendAgent(id, { type: "sub", chat: id, branch: "main", subagent: sa }); }
    else if (id === AG.always) sendAgent(id, { type: "sub", chat: id, branch: "main", subagent: { id: "s9", tool: "w9", description: "A subagent nobody looks at", kind: "claude", status: "running", started: T0, toolUses: beat } });
  }
}

let timers = [];
const startTimers = () => { if (!timers.length) timers = [setInterval(() => { for (const R of Object.values(runs)) step(R); }, TICK_MS), setInterval(() => { for (const R of Object.values(runs)) activity(R); }, 2000), setInterval(stream, 1000)]; };
const stopTimers = () => { for (const t of timers) clearInterval(t); timers = []; };
if (!process.env.PAUSED) startTimers();

// ---- stop, resume, archive, delete

const ERR = {
  notFound: [404, "no such run"], noTask: [404, "no such task"], noAttempt: [404, "no such attempt"], noVersion: [404, "no such version"], noText: [404, "nothing recorded yet"],
  archived: [409, "the run is archived"], started: [409, "the run has started: its agent, folder and settings are fixed"], notStarted: [409, "the run has not started"],
  finished: [409, "the run is finished"], going: [409, "the run is still going: its result can be applied when it has finished or is stopped"], notHalted: [409, "the run is not stopped"], notRunning: [409, "the run is not running"], stopping: [409, "the run is stopping; try again in a moment"],
  group: [404, "no such group"], chat: [404, "no such chat"], runAgent: [409, "this chat is one of a run's agents: it cannot be changed"],
};
const fail = (code, error) => ({ fail: [code, error] });

/** running → stopping now; a second later stopped, with an open stop. */
function stopRun(R, then) {
  const d = R.detail;
  if (d.status === "stopping") return;
  d.status = "stopping";
  commit(R, { status: "stopping" });
  setTimeout(() => {
    if (!runs[R.meta.id] || d.status !== "stopping") return;
    const now = Date.now();
    Object.assign(R.meta, { reason: BY_USER, activeMs: R.meta.activeMs + (now - R.meta.asOf), asOf: now });
    const hit = Object.values(d.agents).filter((a) => a.status === "running");
    halt(d, now, "user", "stopped");
    commit(R, { status: d.status, stops: d.stops, agents: Object.fromEntries(hit.map((a) => [a.id, a])) });
    then?.();
  }, 1000);
}

function resumeRun(R, b) {
  const d = R.detail, m = R.meta;
  if (!d) return fail(...ERR.notStarted);
  if (d.status === "completed" || d.status === "gave_up") return fail(...ERR.finished);
  if (d.status === "running") return fail(...ERR.notHalted);
  if (d.status === "stopping") return fail(...ERR.stopping);
  if (m.archived) return fail(...ERR.archived);
  if (m.blocked) return fail(409, m.blocked);
  const v = view(R);
  if (b.maxTurns !== undefined && !(Number.isInteger(b.maxTurns) && b.maxTurns > v.turns && b.maxTurns <= 500)) return fail(400, b.maxTurns > 500 ? "maxTurns must be between 1 and 500" : `the run has used ${v.turns} turns: the limit must be higher`);
  if (b.maxCost !== undefined && !(typeof b.maxCost === "number" && (b.maxCost === 0 || b.maxCost > (v.cost ?? 0)))) return fail(400, `the run has spent $${(v.cost ?? 0).toFixed(2)}: the limit must be higher`);
  if (d.status === "stalled" && m.stalledBy === "turns" && b.maxTurns === undefined) return fail(409, `the run reached its limit of ${m.settings.maxTurns} orchestrator turns: raise it to resume`);
  if (d.status === "stalled" && m.stalledBy === "cost" && b.maxCost === undefined) return fail(409, `the run reached its cost limit of $${m.settings.maxCost.toFixed(2)}: raise it to resume`);
  if (b.maxTurns !== undefined) m.settings = { ...m.settings, maxTurns: b.maxTurns };
  if (b.maxCost !== undefined) m.settings = { ...m.settings, maxCost: b.maxCost };
  const now = Date.now(), agents = {};
  d.stops.at(-1).resumedAt = now; d.status = "running";
  delete m.reason; delete m.stalledBy; m.asOf = now;
  for (const a of Object.values(d.agents)) { // the agents of what is still open are launched again
    const open = a.status === "interrupted" && (a.role === "orchestrator" ? d.turns.some((t) => t.agent === a.id && t.status === "running") : d.tasks.some((t) => !t.attempts.at(-1).outcome && Object.values(t.attempts.at(-1).agents).includes(a.id)));
    if (!open) continue;
    a.status = "running"; delete a.endedAt; a.launches.push({ n: a.launches.length + 1, startedAt: now, resume: true }); agents[a.id] = a;
  }
  R.eng.resumed = true;
  commit(R, { status: "running", stops: d.stops, agents });
  return view(R);
}

/** Resolves when the run is archived: a live run is stopped first, and the answer waits for that. */
function archiveRun(R, op) {
  return new Promise((ok) => {
    const finish = () => {
      Object.assign(R.meta, { archived: true, archiveOp: op });
      for (const c of Object.values(chats)) if (c.run === R.meta.id && !c.archived) { Object.assign(c, { archived: true, archiveOp: op }); send({ type: "chat", chat: c }); }
      sendRun(R);
      ok();
    };
    if (R.detail?.status === "running") stopRun(R, finish);
    else if (R.detail?.status === "stopping") { const t = setInterval(() => { if (R.detail.status !== "stopping") { clearInterval(t); finish(); } }, 50); }
    else finish();
  });
}
/** A chat on an archived run was unarchived: the run's record comes back, and the groups it is in;
 *  its other chats stay archived. */
function unarchiveRunOnly(R) {
  delete R.meta.archived; delete R.meta.archiveOp;
  let changed = false;
  for (let g = groups.find((x) => x.id === R.meta.group); g; g = groups.find((x) => x.id === g.parent)) if (g.archived) { delete g.archived; delete g.archiveOp; changed = true; }
  if (changed) send({ type: "groups", groups });
  sendRun(R);
}
function unarchiveRun(R, op) {
  delete R.meta.archived; delete R.meta.archiveOp;
  for (const c of Object.values(chats)) if (c.run === R.meta.id && c.archiveOp === op) { delete c.archived; delete c.archiveOp; send({ type: "chat", chat: c }); }
  sendRun(R);
}
function deleteRun(R) {
  for (const c of Object.values(chats)) if (c.run === R.meta.id) { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); }
  delete runs[R.meta.id];
  send({ type: "run_removed", id: R.meta.id });
}
const subtree = (id) => { const out = new Set([id]); for (let grew = true; grew;) { grew = false; for (const g of groups) if (!out.has(g.id) && g.parent && out.has(g.parent)) { out.add(g.id); grew = true; } } return out; };

// ---- names, as the server makes them

function cleanName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n) return fail(400, "the name is empty");
  if (n.length > 80) return fail(400, "the name is longer than 80 characters");
  if (/[\u0000-\u001f\u007f]/.test(String(name).replace(/\s/g, " "))) return fail(400, "the name has a control character");
  return n;
}
function nameFromGoal(goal) {
  const line = goal.split("\n").map((l) => l.replace(/^\s*(#+|[-*+]|\d+[.)]|>|\[[ x]\])\s*/i, "").replace(/[*_`]/g, "").trim()).find((l) => (l.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3);
  if (!line) return "";
  let s = line; const end = s.slice(12).search(/[.?!](\s|$)/);
  if (end >= 0) s = s.slice(0, 12 + end + 1).replace(/\.$/, "");
  if (s.length > 60) s = s.slice(0, 60).replace(/\s+\S*$/, "") + "…";
  return s[0].toUpperCase() + s.slice(1);
}

// ---- the texts that are loaded on demand, written from the records

const num = (id) => Number(String(id).replace(/\D/g, "")) || 1;
const textHits = {}; // by path: how often a text was asked for

function briefText(t, rev) {
  const first = rev.rev === 1, last = rev.rev === t.briefRev;
  return [`# ${t.id}: ${t.title}`, "",
    `Brief, revision ${rev.rev} of ${t.briefs.length}${last ? "" : " (replaced by a later one)"}. Kind: **${t.kind}**. ${t.writes ? "Your changes are merged when you are done." : "Report only: change nothing."}`, "",
    "## Context", "", `This task is one of the run's tasks. ${t.dependsOn.length ? `It builds on ${t.dependsOn.join(", ")}: read their reports first.` : "It depends on no other task."}`, "",
    "## What to do", "", `1. ${t.title}.`, "2. Keep the change as small as the task allows.", ...(first ? [] : [`3. Added in revision ${rev.rev}: say in your report what you left out, and why.`]), "",
    ...(first ? [] : ["## What changed in this revision", "", `- The scope is narrower than in revision ${rev.rev - 1}.`, `- ${rev.chat ? "A chat on the run" : `Turn ${rev.turn}`} rewrote the section "What to do".`, ""]),
    "## Done when", "", "- the change is made", "- `go build ./...` and the tests pass", "", "```sh", "go build ./... && go test ./...", "```"].join("\n");
}

function reportText(R, t, a) {
  const failed = a.result.outcome === "failed", n = num(t.id);
  const out = [`## Report of ${t.id}${a.n > 1 ? `, attempt ${a.n}` : ""}`, "", `**Task:** ${t.title}`, "",
    "### What I did", "", "- Read the code the task touches before changing anything.", t.writes ? `- Made the change in ${1 + (n % 3)} commit${n % 3 ? "s" : ""}${a.branch ? ` on \`${a.branch}\`` : ""}.` : "- Changed nothing: this task only reports.",
    failed ? "- Stopped when it was clear the task cannot be done as briefed." : "- Ran the checks below.", "",
    "### Checks", "", "```sh", "$ go build ./...", `$ go test ./internal/chats/ -count=1`, failed ? "--- FAIL: TestForkAtEnd (0.02s)" : `ok  \tai-whiteboard/internal/chats\t${(1 + (n % 4) * 0.37).toFixed(2)}s`, "```", "",
    "| Check | Result | Notes |", "|---|---|---|", "| `go build ./...` | pass | |", `| \`go test ./...\` | ${failed ? "**fail**" : "pass"} | ${failed ? "1 test" : `${40 + n} packages`} |`, `| \`npm run check\` | pass | strict \`tsc\` |`, "",
    "### Findings", "", `1. **${t.id}-F1** The behaviour the brief describes is ${failed ? "not reachable from the current API" : "now covered by a test"}.`, `2. **${t.id}-F2** One comment was out of date; ${t.writes ? "fixed" : "not fixed (report only)"}.`, "",
    `(${a.result.reportSize.toLocaleString("en-US")} characters in the real run; this text is written by the mock.)`];
  if (LONG.report.has(`${R.meta.id}/${t.id}`)) {
    out.push("", "### Comparison", "",
      "| Library | Size (min+gzip) | Prefix search | Fuzzy search | Index format | Build-time indexing | Last release | Licence | Verdict |", "|---|---|---|---|---|---|---|---|---|",
      "| MiniSearch | 7.4 kB | yes | yes (edit distance) | JSON, serialisable | yes, with `MiniSearch.loadJSON` | 2026-03 | MIT | **use this one** |",
      "| Lunr | 8.9 kB + 6.1 kB language packs | yes (wildcards) | yes (`~1`) | JSON, serialisable | yes, with `lunr.Index.load` | 2020-08 | MIT | too big with the language packs |",
      "| FlexSearch | 5.9 kB (light build) | yes | partial (phonetic presets only) | several, export is asynchronous | awkward: the export is split over many keys | 2025-11 | Apache-2.0 | no fuzzy search |",
      "", "The command that measures the three bundles, on one line:", "", "```sh",
      "for lib in minisearch lunr flexsearch; do npx esbuild --bundle --minify --format=esm node_modules/$lib/dist/es/index.js --outfile=/tmp/size-$lib.js >/dev/null 2>&1 && printf '%s %s\\n' $lib $(gzip -c /tmp/size-$lib.js | wc -c); done | sort -k2 -n | column -t   # prints the three sizes in bytes, smallest first, so the table above can be checked by anyone",
      "```", "", "A_word_with_no_break_in_it_that_is_longer_than_the_dock_is_wide_at_six_hundred_pixels_and_must_wrap_instead_of_pushing_the_column_out.");
  }
  return out.join("\n");
}

function notesText(d, nv) {
  const at = nv.at, state = (t) => { const a = t.attempts.at(-1); return a.endedAt && a.endedAt <= at ? a.outcome : a.startedAt && a.startedAt <= at ? "running" : "waiting"; };
  const known = d.tasks.filter((t) => t.createdAt <= at), by = (k) => known.filter((t) => state(t) === k);
  const list = (ts, none) => (ts.length ? ts.map((t) => `- **${t.id}** ${t.title}`) : [`- ${none}`]);
  return [`# Notes, version ${nv.v}`, "", `Written ${nv.chat ? "from a chat on the run" : `in turn ${nv.turn}`}. ${known.length} task${known.length === 1 ? "" : "s"} so far: ${by("done").length} done, ${by("running").length} running, ${by("waiting").length} waiting.`, "",
    "## Done", "", ...list(by("done"), "nothing yet"), "", "## Running", "", ...list(by("running"), "nothing"), "", "## Waiting", "", ...list(by("waiting"), "nothing"), "",
    ...(by("failed").length ? ["## Failed", "", ...list(by("failed"), ""), ""] : []),
    "## Decisions", "", ...Array.from({ length: Math.min(nv.v, 6) }, (_, i) => `${i + 1}. Decision ${i + 1} of version ${nv.v}: keep the tasks small and verify each fix before the next one starts.`), "",
    `(${nv.size.toLocaleString("en-US")} characters in the real run; this text is written by the mock.)`].join("\n");
}

function changesOf(R, t, a) {
  const n = num(t.id), base = a.base || SHA_();
  const head = { task: t.id, attempt: a.n, branch: a.branch ?? `aiwb/${R.meta.id}/${t.id}`, base, head: a.head, merged: a.merged, mergedAt: a.mergedAt, conflicts: a.conflicts };
  if (a.head === a.base) return { ...head, files: [], add: 0, del: 0, commits: [] }; // it committed nothing
  const files = [{ path: "internal/chats/manager.go", add: 30 + n, del: 6 }, { path: "internal/chats/manager_test.go", add: 60 + 2 * n, del: 0 },
    { path: "web/src/{conn.ts => connection.ts}", add: 12, del: 9 }, { path: "docs/old-notes.md => docs/archive/notes.md", add: 0, del: 0 }, { path: "web/public/icon.png", add: 0, del: 0, binary: true },
    ...(a.conflicts ?? []).map((path, i) => ({ path, add: 4 + i, del: 2 + i }))];
  if (LONG.path.has(`${R.meta.id}/${t.id}`)) files.push({ path: "docs/content/reference/generated/api/v2/" + "a-very-long-folder-name-made-by-the-generator/".repeat(2) + "search-index-fragments-for-the-reference.json", add: 310, del: 0 });
  const end = a.endedAt ?? Date.now();
  return { ...head, files, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0),
    commits: [{ sha: SHA_(), subject: `${t.id}: ${t.title}`.slice(0, 72), at: end - 4 * MIN }, { sha: a.head, subject: `${t.id}: tests`, at: end - MIN }] };
}

// ---- HTTP

const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const json = (res, v, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
const answer = (res, v) => {
  if (v && v.bare) { res.writeHead(v.bare); return res.end(); } // a status with no body at all (a proxy's, a body limit's)
  return v && v.fail ? json(res, { error: v.fail[1] }, v.fail[0]) : json(res, v ?? { ok: true });
};
const mockState = () => ({ paused: !timers.length, tick: TICK_MS, detailDelay, texts: textHits, clients: clients.map((c) => ({ id: c.id, watched: [...c.watched] })),
  runs: Object.fromEntries(Object.values(runs).map((R) => [R.meta.id, { status: R.detail?.status ?? "draft", version: R.detail?.version, tasks: R.detail?.tasks.length, turns: R.detail?.turns.length, step: R.eng.step }])) });

/** PATCH /api/runs/{id}: name, group, agent, tiers, cwd, settings, in that order. */
function patchRun(R, b) {
  const m = R.meta, setup = ["agent", "tiers", "cwd", "settings"].some((k) => b[k] !== undefined);
  if (setup && R.detail) return fail(...ERR.started);
  if (setup && m.archived) return fail(...ERR.archived);
  const next = { ...m };
  if (b.name !== undefined) { const n = cleanName(b.name); if (n.fail) return n; next.name = n; next.userNamed = true; }
  if (b.group !== undefined) {
    if (b.group !== UNGROUPED && !groups.some((g) => g.id === b.group)) return fail(...ERR.group);
    next.group = b.group;
  }
  if (b.agent !== undefined) {
    if (!Object.hasOwn(catalogs, b.agent)) return fail(400, `unknown agent ${b.agent}`);
    Object.assign(next, { agent: b.agent, tiers: tierDefaults(b.agent) }); // another agent: all three tiers are its defaults
  }
  if (b.tiers !== undefined) { // only the tiers and the fields given change
    const tiers = clone(next.tiers), models = catalogOf(next.agent)?.models ?? [];
    for (const [k, c] of Object.entries(b.tiers ?? {})) {
      if (!TIERS.includes(k)) return fail(400, `unknown tier ${k}`);
      if (c?.model !== undefined) {
        const mm = models.find((x) => x.id === c.model);
        if (!mm) return fail(400, `unknown model ${c.model}`);
        tiers[k] = { model: c.model, effort: mm.efforts?.includes(tiers[k].effort) ? tiers[k].effort : mm.defaultEffort };
      }
      if (c?.effort !== undefined) {
        const mm = models.find((x) => x.id === tiers[k].model);
        if (!mm?.efforts?.includes(c.effort)) return fail(400, `${tiers[k].model || "this model"} has no effort ${c.effort}`);
        tiers[k].effort = c.effort;
      }
    }
    next.tiers = tiers;
  }
  if (b.cwd !== undefined) {
    const dir = expand(b.cwd);
    if (!exists(dir)) return fail(400, `${dir} is not a directory`);
    if (inside(dir, DATA)) return fail(400, "that folder is inside the app's own data folder");
    next.cwd = dir;
  }
  if (b.settings !== undefined) {
    const s = { ...next.settings, ...b.settings }, int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!int(s.maxParallel, 1, 16)) return fail(400, "maxParallel must be between 1 and 16");
    if (!int(s.maxTurns, 1, 500)) return fail(400, "maxTurns must be between 1 and 500");
    if (!(typeof s.maxCost === "number" && s.maxCost >= 0)) return fail(400, "maxCost must be 0 (no limit) or more");
    if (s.setup !== undefined && (typeof s.setup !== "string" || s.setup.length > 2000 || /[\r\n]/.test(s.setup))) return fail(400, /[\r\n]/.test(String(s.setup)) ? "the setup command must be one line" : "the setup command is longer than 2,000 characters");
    if (!["declared", "each", "idle"].includes(s.wake)) return fail(400, 'wake must be "declared", "each" or "idle"');
    if (s.applyResult !== undefined && !["auto", "manual"].includes(s.applyResult)) return fail(400, 'applyResult must be "auto" or "manual"');
    if (!s.setup) delete s.setup;
    next.settings = s;
  }
  R.meta = next;
  return sendRun(R);
}

/** POST /api/runs/{id}/start: answers when the start is recorded; the engine makes the first turn. */
async function startRun(R, b) {
  const m = R.meta, goal = String(b.goal ?? "");
  if (R.detail) return fail(...ERR.started);
  if (m.archived) return fail(...ERR.archived);
  if (!goal.trim()) return fail(400, "the goal is empty");
  if (TIERS.some((k) => !m.tiers[k].model)) return fail(400, "pick a model first");
  if (flags.start413) return { bare: 413 };
  if (goal.length > 200000) return fail(400, "the goal is longer than 200,000 characters");
  if (!exists(m.cwd)) return fail(409, `Folder not found: ${m.cwd}. Pick another folder to continue.`);
  if (m.blocked || blockedOf(m.cwd)) return fail(409, m.blocked || blockedOf(m.cwd));
  if (/fail/i.test(goal)) return fail(400, "claude is not installed");
  await new Promise((ok) => setTimeout(ok, 400));
  if (!runs[m.id]) return fail(...ERR.notFound);
  if (R.detail) return fail(...ERR.started);
  const now = Date.now();
  if (!m.userNamed) m.name = nameFromGoal(goal) || m.name;
  delete m.draft;
  Object.assign(m, { started: iso(now), activeMs: 0, asOf: now });
  R.goal = goal;
  R.detail = { run: m.id, version: 1, status: "running", startedAt: now, goalSize: goal.length, stops: [], turns: [], tasks: [], chatOps: [], agents: {}, notes: [],
    ...(isGit(m.cwd) ? { git: { baseRef: SHA(), integrationBranch: `aiwb/${m.id}/integration`, branch: "main", ...(m.dirty ? { dirtyAtStart: true } : {}) } } : {}) };
  setTimeout(() => step(R), 1000); // the first turn appears a second later
  return sendRun(R);
}

/** POST /api/runs/{id}/apply: what came of it, after a moment. Nothing is merged: a pending or
 *  blocked delivery becomes an applied one, but r_cursor's first time, which answers a conflict. */
async function applyRun(R, b) {
  const d = R.detail;
  if (!d) return fail(...ERR.notStarted);
  if (d.status === "running" || d.status === "stopping") return fail(...ERR.going);
  const cur = d.delivery ?? { state: "none", reason: d.git ? "no_changes" : "no_git" };
  if (cur.state === "none" || cur.state === "applied") return cur;
  await new Promise((ok) => setTimeout(ok, 600));
  if (!runs[R.meta.id]) return fail(...ERR.notFound);
  const now = Date.now(), branch = b.branch || cur.branch || "main", keep = { result: cur.result, branch, ...(cur.partial ? { partial: true } : {}) };
  if (R.meta.id === "r_cursor" && cur.reason !== "conflict") {
    d.delivery = { state: "blocked", reason: "conflict", auto: false, at: now, ...keep, files: ["docs/de/index.md", "docs/glossary.md"], detail: `the result does not merge into ${branch} without conflicts` };
  } else {
    const ff = cur.state === "pending" && !b.branch;
    d.delivery = { state: "applied", auto: false, at: now, ...keep, commit: ff ? cur.result : SHA(), how: ff ? "ff" : "merge" };
  }
  commit(R, { delivery: d.delivery });
  return d.delivery;
}

async function runRoute(req, res, id, rest) {
  const R = runs[id], M = req.method;
  if (!R) { await body(req); return answer(res, fail(...ERR.notFound)); }
  const d = R.detail;
  let m;
  if (R.meta.unreadable && !(rest === "" && (M === "GET" || M === "DELETE")) && rest !== "/archive" && rest !== "/unarchive") { await body(req); return answer(res, fail(M === "GET" ? 500 : 409, UNREADABLE)); }
  if (rest === "" && M === "GET") return answer(res, view(R));
  if (rest === "" && M === "PATCH") return answer(res, patchRun(R, await body(req)));
  if (rest === "" && M === "DELETE") { if (flags.delete500) return answer(res, fail(500, "the run's folder could not be removed: permission denied")); deleteRun(R); return answer(res); }
  if (rest === "/draft" && M === "PUT") {
    const b = await body(req);
    if (!d) { if (b.text || b.references?.length) R.meta.draft = b; else delete R.meta.draft; sendRun(R); } // a started run ignores it
    return answer(res);
  }
  if (rest === "/start" && M === "POST") return answer(res, await startRun(R, await body(req)));
  if (rest === "/stop" && M === "POST") {
    if (!d) return answer(res, fail(...ERR.notStarted));
    if (d.status !== "running" && d.status !== "stopping") return answer(res, fail(...ERR.notRunning));
    stopRun(R);
    const v = view(R); // "stopping": with flags.stopDelay the answer arrives after the `run` event that says "stopped"
    if (flags.stopDelay) await new Promise((ok) => setTimeout(ok, flags.stopDelay));
    return answer(res, v);
  }
  if (rest === "/resume" && M === "POST") return answer(res, resumeRun(R, await body(req)));
  if (rest === "/apply" && M === "POST") return answer(res, await applyRun(R, await body(req)));
  if (rest === "/archive" && M === "POST") {
    if (flags.archive409) return answer(res, fail(409, "the run did not stop within 30 seconds: try again"));
    await archiveRun(R, newId("op_")); // a working run: the answer comes after the stop
    return answer(res);
  }
  if (rest === "/unarchive" && M === "POST") { unarchiveRun(R, R.meta.archiveOp); return answer(res); }
  if (M !== "GET") { await body(req); return answer(res, fail(404, "not found")); }
  if (rest === "/delivery") { // a dry run: what an apply would meet now
    if (!d) return answer(res, fail(...ERR.notStarted));
    if (d.status === "running" || d.status === "stopping") return answer(res, fail(...ERR.going));
    return answer(res, d.delivery ?? { state: "none", reason: d.git ? "no_changes" : "no_git" });
  }
  if (rest === "/detail") {
    const got = d && clone(d); // what the detail is now; events sent while the answer waits are newer
    if (detailDelay) await new Promise((ok) => setTimeout(ok, detailDelay));
    return answer(res, got ?? fail(...ERR.notStarted));
  }
  if (/^\/(goal|notes\/|tasks\/)/.test(rest)) textHits[`${id}${rest}${new URL(req.url, "http://x").search}`] = (textHits[`${id}${rest}${new URL(req.url, "http://x").search}`] ?? 0) + 1;
  if (rest === "/goal") return answer(res, d ? { text: R.goal ?? "" } : fail(...ERR.notStarted));
  if ((m = /^\/notes\/(\d+)$/.exec(rest))) {
    const nv = d?.notes.find((x) => x.v === Number(m[1]));
    return answer(res, nv ? { ...nv, text: notesText(d, nv) } : fail(...ERR.noVersion));
  }
  if ((m = /^\/tasks\/([^/]+)\/brief$/.exec(rest))) {
    const t = d?.tasks.find((x) => x.id === m[1]);
    if (!t) return answer(res, fail(...ERR.noTask));
    const want = new URL(req.url, "http://x").searchParams.get("rev"), rev = t.briefs.find((x) => x.rev === (want === null ? t.briefRev : Number(want)));
    return answer(res, rev ? { ...rev, task: t.id, text: briefText(t, rev) } : fail(...ERR.noVersion));
  }
  if ((m = /^\/tasks\/([^/]+)\/attempts\/(\d+)\/(report|changes)$/.exec(rest))) {
    const t = d?.tasks.find((x) => x.id === m[1]);
    if (!t) return answer(res, fail(...ERR.noTask));
    const a = t.attempts.find((x) => x.n === Number(m[2]));
    if (!a) return answer(res, fail(...ERR.noAttempt));
    if (m[3] === "report") {
      if (!a.result || NO_TEXT.has(`${id}/${t.id}/${a.n}/report`)) return answer(res, fail(...ERR.noText)); // no result yet
      return answer(res, { task: t.id, attempt: a.n, outcome: a.result.outcome, summary: a.result.summary, report: reportText(R, t, a) });
    }
    if (!d.git || !t.writes || !a.head) return answer(res, fail(...ERR.noText)); // no git, a report-only task, or nothing committed yet
    return answer(res, changesOf(R, t, a));
  }
  return answer(res, fail(404, "not found"));
}

async function chatRoute(req, res, id, rest) {
  const M = req.method, own = chats[id], ag = own ? null : agentChat(id);
  if (!own && !ag) { await body(req); return answer(res, fail(...ERR.chat)); }
  let m;
  if (rest === "" && M === "GET") return answer(res, own ?? ag);
  if (rest === "/items" && M === "GET") {
    const list = own ? (items[id] ??= []) : agentItems(id);
    if (ag) for (const c of clients) if (c.id === req.headers["x-aiwb-client"]) c.watched.add(id); // from here on that connection gets the agent's events
    return answer(res, { version: (versions[id] ??= 1), branch: "main", items: list, subagents: subs[id] ?? [] });
  }
  if ((m = /^\/subagents\/([^/]+)\/items$/.exec(rest)) && M === "GET") return answer(res, { version: 1, items: subItems[`${id}/${m[1]}`] ?? [] });
  if (rest === "/tree" && M === "GET") return answer(res, { current: "main", branches: [{ id: "main", at: 0, len: ((own ? items[id] : agentItems(id)) ?? []).length, items: [] }], labels: [] });
  if (rest === "/context" && M === "GET") return answer(res, { atMessage: 0, atTurn: 0, total: 42900, window: 200000, categories: [{ id: "messages", label: "Messages", tokens: 42900, kind: "used" }, { id: "free", label: "Free space", tokens: 157100, kind: "free" }] });
  if (rest === "/open" && M === "POST") return answer(res);
  if (rest === "/permission" && M === "POST") { await body(req); return answer(res); }
  const b = await body(req);
  if (ag) return answer(res, fail(...ERR.runAgent)); // a run agent takes no message and no change
  if (rest === "" && M === "PATCH") {
    if (b.group !== undefined && own.run) return answer(res, fail(400, "a run's chat moves with its run"));
    for (const k of ["name", "group", "model", "effort", "cwd"]) if (b[k] !== undefined) own[k] = b[k];
    if (b.name !== undefined) own.userNamed = true;
    send({ type: "chat", chat: own }); return answer(res); // {"ok":true}, as the server
  }
  if (rest === "" && M === "DELETE") { delete chats[id]; send({ type: "chat_removed", id }); return answer(res); }
  if (rest === "/draft" && M === "PUT") { if (b.text || b.references?.length) own.draft = b; else delete own.draft; send({ type: "chat", chat: own }); return answer(res); }
  if (rest === "/archive" || rest === "/unarchive") {
    if (rest === "/archive") Object.assign(own, { archived: true, archiveOp: newId("op_") }); else { delete own.archived; delete own.archiveOp; }
    send({ type: "chat", chat: own });
    const R = own.run && runs[own.run];
    if (rest === "/unarchive" && R?.meta.archived) unarchiveRunOnly(R); // unarchiving a run's chat brings its run back, not the run's other chats
    return answer(res);
  }
  if (rest === "/messages" && M === "POST") { // a canned reply, so that a chat can be tried
    const list = (items[id] ??= []), v = () => (versions[id] = (versions[id] ?? 1) + 1), at = list.length;
    const put = (i, item) => { list[i] = item; send({ type: "chat_items", chat: id, branch: "main", version: v(), updates: [{ index: i, item }] }); };
    const state = (status) => { own.status = status; own.locked = true; delete own.draft; send({ type: "chat", chat: own }); };
    put(at, { kind: "user", text: b.text, ...(b.references?.length ? { references: b.references } : {}) }); state("thinking");
    setTimeout(() => { if (!chats[id]) return; put(at + 1, tool("r" + at, own.run ? "mcp__board__get_run" : "Read", own.run ? {} : { file_path: "README.md" })); state("tool"); }, 500);
    setTimeout(() => {
      if (!chats[id]) return;
      put(at + 1, tool("r" + at, own.run ? "mcp__board__get_run" : "Read", own.run ? {} : { file_path: "README.md" }, "ok"));
      put(at + 2, say(own.run ? `The run is ${view(runs[own.run]).status}. (A canned reply of the mock.)` : "A canned reply of the mock."));
      put(at + 3, { kind: "end" }); own.usage = { ...own.usage, turns: own.usage.turns + 1 }; state("ready");
    }, 1400);
    return answer(res);
  }
  return answer(res);
}

/** Group routes: the effects a group's archive and delete have on its runs, boards and chats. */
function groupRoute(req, res, id, rest, b, u) {
  const M = req.method, g = groups.find((x) => x.id === id);
  if (!g) return answer(res, fail(...ERR.group));
  const ids = subtree(id), within = (x) => ids.has(x.group);
  if (rest === "" && M === "PATCH") { for (const k of ["name", "collapsed"]) if (b[k] !== undefined) g[k] = b[k]; send({ type: "groups", groups }); return answer(res); }
  if (rest === "/move") { if (b.parent) g.parent = b.parent; else delete g.parent; send({ type: "groups", groups }); return answer(res); }
  if (rest === "/archive" || rest === "/unarchive") {
    const arch = rest === "/archive", op = arch ? newId("op_") : g.archiveOp;
    for (const x of groups) if (ids.has(x.id) && (arch ? !x.archived : x.archiveOp === op)) { if (arch) Object.assign(x, { archived: true, archiveOp: op }); else { delete x.archived; delete x.archiveOp; } }
    send({ type: "groups", groups });
    for (const x of Object.values(boards)) if (within(x) && (arch ? !x.archived : x.archiveOp === op)) { if (arch) Object.assign(x, { archived: true, archiveOp: op }); else { delete x.archived; delete x.archiveOp; } send({ type: "board", board: x }); }
    for (const c of Object.values(chats)) if ((within(c) || (c.board && within(boards[c.board] ?? {}))) && (arch ? !c.archived : c.archiveOp === op)) { if (arch) Object.assign(c, { archived: true, archiveOp: op }); else { delete c.archived; delete c.archiveOp; } send({ type: "chat", chat: c }); }
    for (const R of Object.values(runs)) if (within(R.meta) && (arch ? !R.meta.archived : R.meta.archiveOp === op)) { if (arch) archiveRun(R, op); else unarchiveRun(R, op); } // live runs are stopped first
    return answer(res);
  }
  if (rest === "" && M === "DELETE") {
    const keep = u.searchParams.get("contents") === "keep", parent = g.parent ?? UNGROUPED;
    for (const R of Object.values(runs)) if (keep ? R.meta.group === id : within(R.meta)) { if (keep) { R.meta.group = parent; sendRun(R); } else deleteRun(R); }
    for (const x of Object.values(boards)) if (keep ? x.group === id : within(x)) {
      if (keep) { x.group = parent; send({ type: "board", board: x }); continue; }
      for (const c of Object.values(chats)) if (c.board === x.id) { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); }
      delete boards[x.id]; send({ type: "board_removed", id: x.id });
    }
    for (const c of Object.values(chats)) if (keep ? c.group === id : within(c)) { if (keep) { c.group = parent; send({ type: "chat", chat: c }); } else { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); } }
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].id === id || (!keep && ids.has(groups[i].id))) groups.splice(i, 1);
      else if (keep && groups[i].parent === id) { if (g.parent) groups[i].parent = g.parent; else delete groups[i].parent; }
    }
    send({ type: "groups", groups });
    return answer(res);
  }
  return answer(res);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, M = req.method;
  let m;
  try {
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const c = { id: u.searchParams.get("client") ?? "", res, watched: new Set() }; // every tab is "active": the mock has no takeover
      clients.push(c);
      write(c, { type: "hello", active: true }); write(c, { type: "snapshot", ...snapshot() });
      req.on("close", () => { clients = clients.filter((x) => x !== c); });
      return;
    }
    if (p.startsWith("/mock/")) {
      if (M === "POST") {
        const mb = await body(req);
        if (p === "/mock/eval") { try { const r = await eval(`(async () => { ${mb.code} })()`); return json(res, { ok: true, r: r ?? null }); } catch (e) { return json(res, { error: String(e.stack ?? e) }, 500); } }
        else if (p === "/mock/gap") runs.r_live && runs.r_live.detail.version++;
        else if (p === "/mock/snapshot") { for (const R of Object.values(runs)) R.sent = JSON.stringify(view(R)); send({ type: "snapshot", ...snapshot() }); }
        else if (p === "/mock/pause") stopTimers();
        else if (p === "/mock/resume") startTimers();
        else if (p === "/mock/tick") for (const R of Object.values(runs)) step(R);
        else if (p === "/mock/activity") for (const R of Object.values(runs)) activity(R);
        else if (p === "/mock/stream") stream();
        else if (p === "/mock/delay") detailDelay = Math.max(0, Number(u.searchParams.get("ms")) || 0);
        else return json(res, { error: "no such control" }, 404);
      }
      return json(res, mockState());
    }
    if (p === "/api/hello") return json(res, { app: "ai-whiteboard", version: "dev", pid: process.pid, webVersion: "dev" });
    if (p === "/api/state") return json(res, snapshot());
    if (p === "/api/dirs") {
      const dir = expand(u.searchParams.get("path") || HOME);
      if (!exists(dir)) return json(res, { error: `${dir} is not a directory` }, 400);
      return json(res, { path: dir, parent: path.dirname(dir), dirs: TREE[dir], git: isGit(dir) });
    }
    if ((m = /^\/api\/usage\/([^/]+)$/.exec(p))) return json(res, { plan: false, note: "The mock has no plan limits.", limits: [], fetchedAt: iso(Date.now()) });
    if (p === "/api/runs" && M === "POST") {
      const b = await body(req);
      if (!b.group) return json(res, { error: `group is empty (use "${UNGROUPED}" for ungrouped)` }, 400);
      const g = groups.find((x) => x.id === b.group);
      if (b.group !== UNGROUPED && !g) return json(res, { error: ERR.group[1] }, 404);
      if (g?.archived) return json(res, { error: "the group is archived" }, 409);
      const name = b.name === undefined ? "New run" : cleanName(b.name);
      if (name.fail) return answer(res, name);
      const R = addRun({ id: newId("r_"), name, group: b.group, created: iso(Date.now()), settings: { ...DEFAULT_SETTINGS } });
      return json(res, sendRun(R));
    }
    if ((m = /^\/api\/runs\/([^/]+)(\/.*)?$/.exec(p))) return await runRoute(req, res, m[1], m[2] ?? "");
    if (p === "/api/chats" && M === "POST") {
      const b = await body(req), R = b.run ? runs[b.run] : null;
      if (b.run && !R) return json(res, { error: ERR.notFound[1] }, 404);
      if (R?.meta.archived) return json(res, { error: ERR.archived[1] }, 409);
      const cat = catalogOf(b.agent), id = newId("c_");
      chats[id] = chat(id, { agent: b.agent, ...(b.run ? { run: b.run } : b.board ? { board: b.board } : { group: b.group }), cwd: R ? R.meta.cwd : SHOP,
        model: cat?.default.model ?? "", effort: cat?.default.effort, created: iso(Date.now()), ...fresh });
      items[id] = [];
      send({ type: "chat", chat: chats[id] });
      return json(res, chats[id]);
    }
    if ((m = /^\/api\/chats\/([^/]+)(\/.*)?$/.exec(p))) return await chatRoute(req, res, m[1], m[2] ?? "");
    if (p === "/api/groups" && M === "POST") { const b = await body(req), g = { id: newId("g_"), name: b.name || "New group", ...(b.parent ? { parent: b.parent } : {}) }; groups.push(g); send({ type: "groups", groups }); return json(res, g); }
    if ((m = /^\/api\/groups\/([^/]+)(\/.*)?$/.exec(p))) return groupRoute(req, res, m[1], m[2] ?? "", await body(req), u);
    if (p === "/api/boards" && M === "POST") { const b = await body(req), x = { id: newId("b_"), name: b.name || "untitled", group: b.group, created: iso(Date.now()) }; boards[x.id] = x; send({ type: "board", board: x }); return json(res, x); }
    if ((m = /^\/api\/boards\/([^/]+)(\/.*)?$/.exec(p))) {
      const x = boards[m[1]], rest = m[2] ?? "", b = M === "GET" ? {} : await body(req);
      if (!x) return json(res, { error: "no such board" }, 404);
      if (rest === "/scene" && M === "GET") return json(res, { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
      if (rest === "/rename") { x.name = b.name; send({ type: "board", board: x }); return json(res, x); }
      if (rest === "" && M === "PATCH") { x.group = b.group; send({ type: "board", board: x }); return json(res, x); }
      if (rest === "/archive" || rest === "/unarchive") { if (rest === "/archive") Object.assign(x, { archived: true, archiveOp: newId("op_") }); else { delete x.archived; delete x.archiveOp; } send({ type: "board", board: x }); return json(res, { ok: true }); }
      if (rest === "" && M === "DELETE") { for (const c of Object.values(chats)) if (c.board === x.id) { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); } delete boards[x.id]; send({ type: "board_removed", id: x.id }); }
      return json(res, { ok: true });
    }
    if (p.startsWith("/api/")) { await body(req); return json(res, { ok: true }); }
    const f = path.join(DIST, p === "/" ? "index.html" : p);
    if (!inside(f, DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  } catch (err) {
    console.error(`${M} ${p}:`, err);
    if (!res.headersSent) json(res, { error: String(err?.message ?? err) }, 500); else res.end();
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`run mock on http://127.0.0.1:${PORT} (pid ${process.pid}); serving ${DIST}`));
