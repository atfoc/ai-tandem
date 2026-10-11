// The waits of the fork flows (src/logic/waits.ts): how a wait begins, goes on and ends, which
// controls it holds and in which words, and what the thread draws for it. What fork/actions.ts and
// conn.ts make of the calls is in waitflows.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORKING_LINE, FORK_HELD, LOADING_LINE, OPENING_LINE, SENDING, SEND_HELD, STARTING_LINE,
  afterThread, begun, ended, heldReason, loading, pickOn, sendHeld, sendWait, startingOn, stepped, taken, threadWait, unnamed, withLoad, withoutChat, withoutLoads,
  type ChatWaits, type Control, type SendWait, type Waits,
} from "../src/logic/waits.ts";
import type { Item } from "../src/types.ts";

const user = (text: string): Item => ({ kind: "user", text });
const reply = (text: string): Item => ({ kind: "text", text, done: true });
const ITEMS: Item[] = [user("q1"), reply("a1"), { kind: "end", point: "p1" }, user("q2"), reply("a2"), { kind: "end", point: "p2" }];
const QUOTE = { quote: "a1", item: 1, start: 0, end: 2 };

/** A message that starts a new branch after the first turn of main. */
const branchSend = (o: Partial<SendWait> = {}): SendWait => ({ id: 1, kind: "branch", phase: "sending", text: "another way", references: [QUOTE], branch: "main", at: 3, ...o });
/** The first message of a fork that copied the first turn. */
const firstSend = (o: Partial<SendWait> = {}): SendWait => ({ id: 2, kind: "first", phase: "sending", text: "go on", references: [], branch: "main", at: 3, ...o });
const of = (w: ChatWaits): Waits => ({ c_1: w });
/** A thread that shows main, loaded with both turns, and nothing else going on. */
const shown = (o: Partial<Parameters<typeof threadWait>[1]> = {}) => ({ shown: "main", loaded: true, count: 6, move: false, busy: false, ...o });

// ---- begin, go on, end

test("a wait begins beside the chat's other waits and ends by its id alone", () => {
  let all: Waits = {};
  all = begun(all, "c_1", "send", branchSend());
  all = begun(all, "c_1", "fork", { id: 7 });
  assert.deepEqual(all, { c_1: { send: branchSend(), fork: { id: 7 } } });
  assert.equal(ended(all, "c_1", "fork", 8), all, "another call's id ends nothing");
  assert.equal(ended(all, "c_1", "open", 7), all, "nor does the end of a call of another kind");
  assert.equal(ended(all, "c_2", "fork", 7), all, "or of another chat");
  all = ended(all, "c_1", "fork", 7);
  assert.deepEqual(all, { c_1: { send: branchSend() } }, "the fork ended, the send goes on");
  all = ended(all, "c_1", "send", 1);
  assert.deepEqual(all, {}, "a chat with no wait has no record");
});

test("a wait that begins takes the place of the one of its kind: the earlier call then ends nothing", () => {
  let all = begun({}, "c_1", "open", { id: 1, branch: "b1" });
  all = begun(all, "c_1", "open", { id: 2, branch: "b2" });
  assert.equal(ended(all, "c_1", "open", 1), all, "the first call ends after the second began");
  assert.deepEqual(all.c_1.open, { id: 2, branch: "b2" });
  assert.deepEqual(ended(all, "c_1", "open", 2), {});
});

test("a branch send goes on from its answer: its branch is known, and the history before the point is kept", () => {
  let all = begun({}, "c_1", "send", branchSend());
  assert.equal(stepped(all, "c_1", 9, loading("b9", ITEMS)), all, "not for another send's id");
  all = stepped(all, "c_1", 1, loading("b9", ITEMS));
  assert.deepEqual(all.c_1.send, { ...branchSend(), phase: "loading", to: "b9", kept: ITEMS.slice(0, 3) });
  assert.deepEqual(stepped(begun({}, "c_1", "send", branchSend()), "c_1", 1, loading("b9", undefined)).c_1.send?.kept, [], "the source's list is not kept: no history, the message alone");
});

test("a branch send answered without the branch's name goes on until the view names it", () => {
  let all = begun({}, "c_1", "send", branchSend());
  all = stepped(all, "c_1", 1, unnamed("main"));
  assert.deepEqual(all.c_1.send, { ...branchSend(), phase: "unnamed", before: "main" });
  assert.equal(sendHeld(all.c_1), true, "it is still being sent");
  all = stepped(all, "c_1", 1, loading("b9", ITEMS));
  assert.equal(all.c_1.send?.phase, "loading");
  assert.equal("before" in all.c_1.send!, false);
  assert.equal(sendHeld(all.c_1), false);
});

test("a fork's first message that was taken stays until the thread of its branch has it", () => {
  const begin = () => begun({}, "c_1", "send", firstSend());
  assert.deepEqual(stepped(begin(), "c_1", 2, taken(4)), {}, "the thread has it at the answer: the wait ends there");
  let all = stepped(begin(), "c_1", 2, taken(3));
  assert.equal(all.c_1.send?.phase, "taken");
  assert.equal(stepped(begin(), "c_1", 2, taken(undefined)).c_1.send?.phase, "taken", "a thread that is not kept is read again, with the message");
  assert.equal(afterThread(all, "c_1", "main", 3), all, "the thread changed and has no message yet");
  assert.equal(afterThread(all, "c_1", "other", 9), all, "another branch's thread");
  assert.equal(afterThread(all, "c_2", "main", 9), all, "another chat's");
  assert.deepEqual(afterThread(all, "c_1", "main", 4), {});
  // nothing else ends by a thread: a message whose POST still runs, a branch send
  all = begin();
  assert.equal(afterThread(all, "c_1", "main", 9), all);
  all = begun({}, "c_1", "send", branchSend());
  assert.equal(afterThread(all, "c_1", "main", 9), all);
});

test("the lists being fetched are kept by branch, and go with the fetch", () => {
  let all = withLoad({}, "c_1", "main", true);
  assert.deepEqual(all, { c_1: { loads: ["main"] } });
  assert.equal(withLoad(all, "c_1", "main", true), all, "told twice");
  all = withLoad(all, "c_1", "b2", true);
  assert.deepEqual(all.c_1.loads, ["main", "b2"]);
  assert.equal(withLoad(all, "c_1", "b3", false), all, "the end of a fetch that was not told of");
  all = withLoad(all, "c_1", "main", false);
  assert.deepEqual(all, { c_1: { loads: ["b2"] } });
  assert.deepEqual(withLoad(all, "c_1", "b2", false), {});
  // the fetches of a chat are given up together; its other waits stay
  all = begun(withLoad(withLoad({}, "c_1", "main", true), "c_1", "b2", true), "c_1", "fork", { id: 1 });
  assert.deepEqual(withoutLoads(all, "c_1"), { c_1: { fork: { id: 1 } } });
  assert.equal(withoutLoads(all, "c_2"), all);
  assert.deepEqual(withoutLoads({ c_1: { loads: ["main"] } }, "c_1"), {});
});

test("a chat that is gone takes its waits along", () => {
  const all: Waits = { c_1: { send: branchSend(), fork: { id: 3 }, loads: ["main"] }, c_2: { fork: { id: 4 } } };
  assert.deepEqual(withoutChat(all, "c_1"), { c_2: { fork: { id: 4 } } });
  assert.equal(withoutChat(all, "c_3"), all);
});

// ---- what is held

const CONTROLS: Control[] = ["back", "alert", "open", "branch", "branchEdit", "choice", "send", "fork", "forkEdit", "label", "stop", "tree"];
const held = (w: ChatWaits | undefined) => CONTROLS.filter((c) => heldReason(w, c));

test("while a branch send waits for its answer the controls that change where the message goes are held, and say why", () => {
  const w = { send: branchSend() };
  assert.deepEqual(held(w), ["back", "alert", "open", "branch", "branchEdit", "choice", "send"]);
  for (const c of held(w)) assert.equal(heldReason(w, c), SEND_HELD);
  assert.match(SEND_HELD, /^Your message is being sent/);
  assert.deepEqual(held({ send: branchSend({ phase: "unnamed", before: "main" }) }), held(w), "also after an answer that named no branch");
  // Fork, Fork and edit, Label, Stop and what opens the tree stay live
  for (const c of ["fork", "forkEdit", "label", "stop", "tree"] as Control[]) assert.equal(heldReason(w, c), "", c);
});

test("nothing is held once the new branch is known, by a fork's first message, by a list being fetched or by a branch being opened", () => {
  assert.deepEqual(held({ send: branchSend({ phase: "loading", to: "b9", kept: [] }) }), []);
  assert.deepEqual(held({ send: firstSend() }), []);
  assert.deepEqual(held({ send: firstSend({ phase: "taken" }) }), []);
  assert.deepEqual(held({ loads: ["main"], open: { id: 1, branch: "b2" }, pick: { id: 2, branch: "main", model: "m", label: "M" } }), []);
  assert.deepEqual(held(undefined), []);
  assert.deepEqual(held({}), []);
});

test("while a fork is being made Fork and Fork and edit of that chat are held, and nothing else", () => {
  const w = { fork: { id: 1 } };
  assert.deepEqual(held(w), ["fork", "forkEdit"]);
  assert.equal(heldReason(w, "fork"), FORK_HELD);
  assert.equal(heldReason(w, "forkEdit"), FORK_HELD);
});

test("a fork asked for during a branch send: each wait holds its own controls", () => {
  const both = { send: branchSend(), fork: { id: 1 } };
  assert.deepEqual(held(both), ["back", "alert", "open", "branch", "branchEdit", "choice", "send", "fork", "forkEdit"]);
  assert.equal(heldReason(both, "branch"), SEND_HELD);
  assert.equal(heldReason(both, "fork"), FORK_HELD);
  // the fork answers first: the send still holds what it held
  assert.deepEqual(held(ended(of(both), "c_1", "fork", 1).c_1), ["back", "alert", "open", "branch", "branchEdit", "choice", "send"]);
  // the send answers first: the fork still holds what it held
  assert.deepEqual(held(ended(of(both), "c_1", "send", 1).c_1), ["fork", "forkEdit"]);
});

test("Send takes no press and shows a spinner while a message is on its way, and names the model a fork's agent starts on", () => {
  assert.equal(sendWait(undefined, "main"), null);
  assert.equal(sendWait({ loads: ["main"], fork: { id: 1 }, open: { id: 2, branch: "b" } }, "main"), null);
  assert.deepEqual(sendWait({ send: branchSend() }, "main"), { spin: true, title: SENDING });
  assert.deepEqual(sendWait({ send: branchSend({ phase: "unnamed" }) }, "main"), { spin: true, title: SENDING });
  assert.equal(sendWait({ send: branchSend({ phase: "loading", to: "b9" }) }, "b9"), null, "the composer of the new branch is held by nothing");
  // a fork's first message: the composer of the branch it was sent on, while its POST runs
  assert.deepEqual(sendWait({ send: firstSend() }, "main"), { spin: true, title: SENDING });
  assert.equal(sendWait({ send: firstSend() }, "other"), null);
  assert.equal(sendWait({ send: firstSend({ phase: "taken" }) }, "main"), null);
  // a pick on a fork: Send says what the agent is starting on
  const pick = { pick: { id: 1, branch: "main", model: "sonnet", effort: "high", label: "Sonnet 5.5 · High" } };
  assert.deepEqual(sendWait(pick, "main"), { spin: false, title: "The agent is starting on Sonnet 5.5 · High" });
  assert.equal(sendWait(pick, "other"), null);
  assert.equal(startingOn("Haiku"), "The agent is starting on Haiku");
  assert.deepEqual(pickOn(pick, "main"), pick.pick);
  assert.equal(pickOn(pick, "other"), null);
  assert.equal(pickOn(undefined, "main"), null);
});

// ---- what the thread draws

test("a thread with no wait draws nothing more, and gets the same object each time", () => {
  assert.equal(threadWait(undefined, shown()), threadWait({}, shown()));
  assert.deepEqual(threadWait(undefined, shown()), { kept: null, sent: null, lines: [], quiet: false });
  assert.equal(threadWait({ loads: ["b2"] }, shown()), threadWait(undefined, shown()), "another branch's list is being fetched");
});

test("a branch send, until its answer: the message after the cut thread, the line that the agent is starting, and no status line of the source", () => {
  const w = { send: branchSend() };
  const t = threadWait(w, shown({ move: true, busy: true }));
  assert.deepEqual(t, { kept: null, sent: { text: "another way", references: [QUOTE] }, lines: [{ id: "send", text: STARTING_LINE }], quiet: true });
  assert.equal(STARTING_LINE, "Starting the agent…");
  // on another server: the line a first message there has
  assert.deepEqual(threadWait(w, shown({ move: true, server: "Studio" })).lines, [{ id: "send", text: "Sending to Studio…" }]);
  // answered without the branch's name: the same picture
  assert.deepEqual(threadWait({ send: branchSend({ phase: "unnamed", before: "main" }) }, shown({ move: true })), threadWait(w, shown({ move: true })));
  // the list was dropped under it (a snapshot): the message and its line stay, and the list's own line waits
  assert.deepEqual(threadWait({ ...w, loads: ["main"] }, shown({ move: true, loaded: false, count: 0 })),
    { kept: null, sent: { text: "another way", references: [QUOTE] }, lines: [{ id: "send", text: STARTING_LINE }], quiet: true });
});

test("a branch send, from its answer until the new branch's list is here: the same history and the message, in that list's place", () => {
  const w = { send: stepped(of({ send: branchSend() }), "c_1", 1, loading("b9", ITEMS)).c_1.send! };
  const there = shown({ shown: "b9", loaded: false, count: 0 });
  assert.deepEqual(threadWait({ ...w, loads: ["b9"] }, there),
    { kept: ITEMS.slice(0, 3), sent: { text: "another way", references: [QUOTE] }, lines: [{ id: "load", text: LOADING_LINE }], quiet: false });
  // the new branch's record says that it works: the thread's own status line stands in for the loading line
  assert.deepEqual(threadWait({ ...w, loads: ["b9"] }, { ...there, busy: true }).lines, []);
  assert.equal(threadWait(w, { ...there, busy: true }).quiet, false);
  // the list is here: the thread draws its own items, which have the message
  assert.deepEqual(threadWait(w, shown({ shown: "b9", count: 4 })), threadWait(undefined, shown()));
  // the chat shows another branch meanwhile: nothing of the send is drawn there
  assert.deepEqual(threadWait(w, shown()), threadWait(undefined, shown()));
  // with no history kept the thread is still not empty: it has the message
  const bare = { send: stepped(of({ send: branchSend() }), "c_1", 1, loading("b9", undefined)).c_1.send! };
  assert.deepEqual(threadWait(bare, there).kept, []);
  assert.ok(threadWait(bare, there).sent);
});

test("a branch send shows only on the thread of its move's source, and only while the move is there", () => {
  const w = { send: branchSend() };
  assert.deepEqual(threadWait(w, shown({ move: true, shown: "other" })), threadWait(undefined, shown()));
  assert.deepEqual(threadWait(w, shown({ move: false })), threadWait(undefined, shown()));
});

test("the first message of a fork: after the copied history, until the thread has it, with no line of its own", () => {
  const w = { send: firstSend() };
  assert.deepEqual(threadWait(w, shown({ count: 3, busy: true })), { kept: null, sent: { text: "go on", references: [] }, lines: [], quiet: false });
  assert.deepEqual(threadWait({ send: firstSend({ phase: "taken" }) }, shown({ count: 3 })).sent, { text: "go on", references: [] }, "taken, and the thread has no message yet");
  assert.equal(threadWait(w, shown({ count: 4 })).sent, null, "the thread has the message: it is drawn once");
  assert.equal(threadWait(w, shown({ count: 3, shown: "other" })).sent, null);
  assert.equal(threadWait(w, shown({ count: 0, loaded: false })).sent, null, "no list to put it after");
});

test("a list being fetched is a line where the thread would be blank, and a branch being opened a line at the thread's foot", () => {
  assert.deepEqual(threadWait({ loads: ["b2"] }, shown({ shown: "b2", loaded: false, count: 0 })), { kept: null, sent: null, lines: [{ id: "load", text: LOADING_LINE }], quiet: false });
  assert.deepEqual(threadWait({ loads: ["b2"] }, shown({ shown: "b2" })).lines, [], "the list is kept and read again: no line");
  assert.deepEqual(threadWait({}, shown({ shown: "b2", loaded: false, count: 0 })).lines, [], "no list and no fetch (it failed): what a failed load shows today");
  // a branch opened for a move from the tree: at the foot of the thread shown
  assert.deepEqual(threadWait({ open: { id: 1, branch: "b2" }, loads: ["b2"] }, shown()).lines, [{ id: "open", text: OPENING_LINE }]);
  // the move is set and its branch's list not here: that line, and not the loading one beside it
  assert.deepEqual(threadWait({ open: { id: 1, branch: "b2" }, loads: ["b2"] }, shown({ shown: "b2", loaded: false, count: 0, move: true })).lines, [{ id: "open", text: OPENING_LINE }]);
});

test("a fork being made is a line at the foot of the source's thread, beside whatever else goes on", () => {
  assert.deepEqual(threadWait({ fork: { id: 1 } }, shown()).lines, [{ id: "fork", text: FORKING_LINE }]);
  assert.deepEqual(threadWait({ fork: { id: 1 }, send: branchSend() }, shown({ move: true })).lines, [{ id: "send", text: STARTING_LINE }, { id: "fork", text: FORKING_LINE }]);
  assert.deepEqual(threadWait({ fork: { id: 1 }, loads: ["main"] }, shown({ loaded: false, count: 0 })).lines, [{ id: "load", text: LOADING_LINE }, { id: "fork", text: FORKING_LINE }]);
});

test("a fork's agent being started on a pick: the thread says so once, by the fork's own status line or by the wait's", () => {
  const w = { pick: { id: 1, branch: "main", model: "m", label: "M" } };
  // an agent kind that tells nothing of the start: the line is the wait's
  assert.deepEqual(threadWait(w, shown()), { kept: null, sent: null, lines: [{ id: "pick", text: STARTING_LINE }], quiet: false });
  // one that does: the fork is busy and says "Starting the agent…" itself
  assert.deepEqual(threadWait(w, shown({ busy: true })), threadWait(undefined, shown()));
  assert.deepEqual(threadWait(w, shown({ shown: "other" })), threadWait(undefined, shown()), "not on another branch's thread");
  assert.deepEqual(threadWait(w, shown({ archived: true })), threadWait(undefined, shown()));
  assert.deepEqual(threadWait({ ...w, loads: ["main"] }, shown({ loaded: false, count: 0 })).lines, [{ id: "load", text: LOADING_LINE }], "a list that is not here says that first");
});

test("an archived chat shows nothing of a message on its way, a branch being opened or a fork; a list being fetched still has its line", () => {
  const w: ChatWaits = { send: branchSend(), fork: { id: 1 }, open: { id: 2, branch: "b2" } };
  assert.deepEqual(threadWait(w, shown({ move: true, archived: true })), threadWait(undefined, shown()));
  assert.deepEqual(threadWait({ ...w, loads: ["main"] }, shown({ loaded: false, count: 0, archived: true })).lines, [{ id: "load", text: LOADING_LINE }]);
});
