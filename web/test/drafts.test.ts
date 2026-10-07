import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DraftSaver, answerNewer, boxText, staleTaken, chatHasDraft, draftKey, draftKeyOf, draftOf, draftSet, draftsAfterSent, hasDraft, heldOf, joinDrafts, legacyDraftKey,
  legacyDraftRenames, otherDrafts, revSet, sameDraft, staleOf, unsavedToShow, type Unsaved,
} from "../src/logic/drafts.ts";
import { stateFromView } from "../src/logic/branches.ts";
import { putsBack } from "../src/logic/sendend.ts";
import type { BranchState, ChatView, Draft, Held, Reference } from "../src/types.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function saver(initial?: Draft, fail = false) {
  const puts: [Draft, boolean][] = [];
  const local: { d: Draft | null } = { d: null };
  const unsaved: Unsaved = { read: () => local.d, write: (d) => { local.d = d; } };
  const put = async (d: Draft, k: boolean) => { puts.push([d, k]); if (fail) throw new Error("unknown_client"); };
  return { puts, local, s: new DraftSaver(put, initial, unsaved, 10) };
}

test("draftOf drops blank text and mentions without text", () => {
  assert.deepEqual(draftOf("  \n "), { text: "" });
  assert.deepEqual(draftOf("", [{ name: "a", id: "b_1" }]), { text: "" });
  assert.deepEqual(draftOf("hi"), { text: "hi" });
  assert.deepEqual(draftOf("hi @a", [{ name: "a", id: "b_1" }]), { text: "hi @a", mentions: [{ name: "a", id: "b_1" }] });
});

test("saves the last change after a pause", async () => {
  const { puts, s } = saver();
  s.change("h"); s.change("hi");
  assert.equal(puts.length, 0);
  await tick(30);
  assert.deepEqual(puts, [[{ text: "hi" }, false]]);
});

test("skips a draft that is saved already", async () => {
  const { puts, s } = saver({ text: "hi" });
  s.change("hi"); // the composer restoring it
  await tick(30);
  assert.equal(puts.length, 0);
  s.change("hi!"); s.change("hi"); // changed back before the pause
  await tick(30);
  assert.equal(puts.length, 0);
});

test("flush saves the pending draft at once, and only once", async () => {
  const { puts, s } = saver();
  s.change("half");
  s.flush(true);
  assert.deepEqual(puts, [[{ text: "half" }, true]]);
  s.flush(true);
  await tick(30);
  assert.equal(puts.length, 1);
});

test("clearing the text saves an empty draft", async () => {
  const { puts, s } = saver({ text: "sent soon" });
  s.change("");
  await tick(30);
  assert.deepEqual(puts, [[{ text: "" }, false]]);
});

test("the unsaved copy is kept from the change until the server has it", async () => {
  const { local, s } = saver();
  s.change("half");
  assert.deepEqual(local.d, { text: "half" });
  await tick(30);
  assert.equal(local.d, null);
});

test("a refused save keeps the unsaved copy, and the same draft is tried again", async () => {
  const { puts, local, s } = saver(undefined, true);
  s.change("half");
  await tick(30);
  assert.deepEqual(local.d, { text: "half" });
  s.change("half!"); s.change("half");
  await tick(30);
  assert.equal(puts.length, 2);
});

test("changing back to the saved draft drops the unsaved copy", () => {
  const { local, s } = saver({ text: "hi" });
  s.change("hi!");
  s.change("hi");
  assert.equal(local.d, null);
});

const quote = { quote: "undo", comment: "keep it", item: 1, start: 4, end: 8 };

test("draftOf keeps quotes, with or without text", () => {
  assert.deepEqual(draftOf("", [], [quote]), { text: "", references: [quote] });
  assert.deepEqual(draftOf("hi @a", [{ name: "a", id: "b_1" }], [quote]), { text: "hi @a", mentions: [{ name: "a", id: "b_1" }], references: [quote] });
  assert.equal(hasDraft(draftOf("", [], [quote])), true);
  assert.equal(hasDraft(draftOf(" ")), false);
  assert.equal(hasDraft(undefined), false);
});

test("saves quotes and their comments, and skips them when saved already", async () => {
  const { puts, s } = saver({ text: "", references: [quote] });
  s.change("", [], [quote]); // the composer restoring it
  await tick(30);
  assert.equal(puts.length, 0);
  s.change("", [], [{ ...quote, comment: "keep it here" }]);
  await tick(30);
  assert.deepEqual(puts, [[{ text: "", references: [{ ...quote, comment: "keep it here" }] }, false]]);
  s.change("", [], []); // the last quote removed
  await tick(30);
  assert.deepEqual(puts[1], [{ text: "" }, false]);
});

test("chatHasDraft: the server's word over all branches, else the current branch's own draft", () => {
  const c = (o: Partial<ChatView>) => o as ChatView;
  assert.equal(chatHasDraft(c({ hasDraft: true })), true);
  assert.equal(chatHasDraft(c({ hasDraft: false, draft: { text: "old" } })), false);
  assert.equal(chatHasDraft(c({ draft: { text: "hi" } })), true);
  assert.equal(chatHasDraft(c({ draft: { text: "", references: [{ quote: "q", item: 0, start: 0, end: 1 }] } })), true);
  assert.equal(chatHasDraft(c({ draft: { text: "" } })), false);
  assert.equal(chatHasDraft(c({})), false);
  assert.equal(chatHasDraft(undefined), false);
});

test("draftKey and legacyDraftKey: an unsaved draft per branch, and the key it had per chat", () => {
  assert.equal(draftKey("c_1", "main"), "aiwb.draft.c_1:main");
  assert.equal(draftKey("c_1", "ab12cd34"), "aiwb.draft.c_1:ab12cd34");
  assert.equal(legacyDraftKey("c_1"), "aiwb.draft.c_1");
  assert.notEqual(legacyDraftKey("c_1"), draftKey("c_1", "main"));
});

test("draftKeyOf: every unsaved draft of a chat, a branch's and the one it had per chat, and no other chat's", () => {
  assert.equal(draftKeyOf(draftKey("c_1", "main"), "c_1"), true);
  assert.equal(draftKeyOf(draftKey("c_1", "ab12cd34"), "c_1"), true);
  assert.equal(draftKeyOf(legacyDraftKey("c_1"), "c_1"), true);
  assert.equal(draftKeyOf(draftKey("c_12", "main"), "c_1"), false); // an id that begins with another
  assert.equal(draftKeyOf(legacyDraftKey("c_12"), "c_1"), false);
  assert.equal(draftKeyOf("aiwb.sel", "c_1"), false);
});

test("legacyDraftRenames: a draft kept per chat goes under the chat's current branch; a branch's key and an unknown chat's are left", () => {
  const current = (chat: string) => ({ c_1: "main", c_2: "ab12cd34" } as Record<string, string>)[chat];
  const keys = ["aiwb.sel", "aiwb.draft.c_1", "aiwb.draft.c_2", "aiwb.draft.c_1:ab12cd34", "aiwb.draft.c_gone", "aiwb.draft.", "aiwb.drafts"];
  assert.deepEqual(legacyDraftRenames(keys, current), [
    ["aiwb.draft.c_1", "aiwb.draft.c_1:main"],
    ["aiwb.draft.c_2", "aiwb.draft.c_2:ab12cd34"],
  ]);
  assert.deepEqual(legacyDraftRenames(["aiwb.draft.c_1:main"], current), []); // renamed already: nothing the second time
});

const q = (item: number, comment?: string): Reference => ({ quote: "q" + item, item, start: 0, end: 2, ...(comment ? { comment } : {}) });
const held = (text: string, references: Reference[] = [], mentions: Held["mentions"] = []): Held => ({ text, mentions, references });
const NOTHING = held("");

test("heldOf and sameDraft: a draft as a composer holds it; no draft is the empty one", () => {
  assert.deepEqual(heldOf({ text: "hi" }), held("hi"));
  assert.deepEqual(heldOf({ text: "", references: [q(1)] }), held("", [q(1)]));
  assert.equal(sameDraft({ text: "hi" }, { text: "hi", mentions: [], references: [] }), true);
  assert.equal(sameDraft(undefined, { text: " " }), true);
  assert.equal(sameDraft(null, { text: "" }), true);
  assert.equal(sameDraft({ text: "hi" }, { text: "hi", references: [q(1)] }), false);
  assert.equal(sameDraft({ text: "hi" }, null), false);
});

test("joinDrafts: both texts, mentions and quotes; the same draft twice, or one with nothing, is one draft", () => {
  const a: Draft = { text: "typed @a", mentions: [{ name: "a", id: "b_1" }], references: [q(1)] };
  const b: Draft = { text: "aside @a @b", mentions: [{ name: "a", id: "b_1" }, { name: "b", id: "b_2" }], references: [q(1, "edited"), q(2)] };
  assert.deepEqual(joinDrafts(a, b), {
    text: "typed @a\n\naside @a @b",
    mentions: [{ name: "a", id: "b_1" }, { name: "b", id: "b_2" }],
    references: [q(1, "edited"), q(2)],
  });
  assert.equal(joinDrafts(a, null), a);
  assert.equal(joinDrafts(a, { text: "" }), a);
  assert.equal(joinDrafts({ text: "" }, b), b);
  assert.equal(joinDrafts(a, { ...a }), a);
  assert.deepEqual(joinDrafts({ text: "", references: [q(3)] }, { text: "only text" }), { text: "only text", references: [q(3)] });
});

test("draftsAfterSent: Branch and edit leaves the draft put aside on the branch left, whole", () => {
  const aside = held("my draft", [q(1), q(7)], [{ name: "a", id: "b_1" }]);
  assert.deepEqual(draftsAfterSent(aside, NOTHING, true), {
    left: { text: "my draft", mentions: [{ name: "a", id: "b_1" }], references: [q(1), q(7)] },
    to: null, // a new branch opens with no draft: the draft does not come back into the composer
  });
});

test("draftsAfterSent: a move that put nothing sent the draft itself: the branch left has none", () => {
  assert.deepEqual(draftsAfterSent(null, NOTHING, true), { left: { text: "" }, to: null });
  assert.equal(hasDraft(draftsAfterSent(null, held("typed since"), true).left), false);
});

test("draftsAfterSent: what was typed after the Send goes to the branch sent to, never to the branch left", () => {
  const typed = held("next message", [q(2)]);
  assert.deepEqual(draftsAfterSent(null, typed, true), { left: { text: "" }, to: { text: "next message", references: [q(2)] } });
  assert.deepEqual(draftsAfterSent(held("my draft"), typed, true), { left: { text: "my draft" }, to: { text: "next message", references: [q(2)] } });
});

test("draftsAfterSent: while the chat still shows the branch left, what its composer holds stays its draft", () => {
  const aside = held("my draft", [q(1)]);
  assert.deepEqual(draftsAfterSent(aside, NOTHING, false), { left: { text: "my draft", references: [q(1)] }, to: null }); // an empty composer gets it back
  assert.deepEqual(draftsAfterSent(aside, held("typed since"), false).left, { text: "typed since\n\nmy draft", references: [q(1)] });
  assert.deepEqual(draftsAfterSent(null, held("typed since"), false), { left: { text: "typed since" }, to: null });
  assert.deepEqual(draftsAfterSent(null, NOTHING, false), { left: { text: "" }, to: null }); // the sent message is no draft of it any more
});

const view = (o: Partial<ChatView> = {}): ChatView => ({
  id: "c_1", agent: "claude", name: "", group: "", cwd: "/w", model: "m", locked: true, status: "ready",
  usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, createdAt: "", updatedAt: "", ...o,
} as ChatView);
const record = (branch: string, draft?: Draft): BranchState => ({
  chat: "c_1", branch, cwd: "/w", model: "m", locked: true, status: "ready", usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, ...(draft ? { draft } : {}),
});

test("draftSet: the current branch's draft goes on its record and on the chat's view", () => {
  const c = view(), main = record("main"), other = record("ab12cd34");
  const r = draftSet(c, [main, other], "main", { text: "hi" });
  assert.deepEqual(r.state, record("main", { text: "hi" }));
  assert.deepEqual(r.view, { ...c, draft: { text: "hi" }, hasDraft: true });
  assert.equal(main.draft, undefined); // the record kept is not changed: a new one replaces it
});

test("draftSet: another branch's draft goes on its record only; the view tells that a branch has one", () => {
  const c = view({ branch: "ab12cd34" }), main = record("main"), cur = record("ab12cd34", { text: "on the branch" });
  const r = draftSet(view({ branch: "ab12cd34", draft: cur.draft, hasDraft: true }), [cur, main], "main", { text: "on main" });
  assert.deepEqual(r.state, record("main", { text: "on main" }));
  assert.deepEqual(r.view.draft, { text: "on the branch" }); // the view's draft is the current branch's
  assert.equal(r.view.hasDraft, true);
  const first = draftSet(c, [record("ab12cd34"), main], "main", { text: "on main" });
  assert.equal(first.view.draft, undefined);
  assert.equal(first.view.hasDraft, true);
});

test("draftSet: an empty draft clears; the view has a draft as long as another branch has one", () => {
  const cur = record("main", { text: "hi" }), other = record("ab12cd34", { text: "there" });
  const c = view({ draft: { text: "hi" }, hasDraft: true });
  const r = draftSet(c, [cur, other], "main", { text: "" });
  assert.deepEqual(r.state, record("main"));
  assert.equal("draft" in r.view, false);
  assert.equal(r.view.hasDraft, true);
  const last = draftSet(c, [cur, record("ab12cd34")], "main", { text: "" });
  assert.equal("draft" in last.view, false);
  assert.equal("hasDraft" in last.view, false);
  assert.equal(chatHasDraft(last.view), false);
});

test("draftSet: a view that would not change is the same view; a server without records gets none made", () => {
  const c = view({ draft: { text: "hi" }, hasDraft: true });
  const same = draftSet(c, [record("main", { text: "hi" }), record("ab12cd34")], "main", { text: "hi" });
  assert.equal(same.view, c);
  assert.deepEqual(same.state, record("main", { text: "hi" }));
  const other = draftSet(c, [record("main", { text: "hi" }), record("ab12cd34", { text: "x" })], "ab12cd34", { text: "y" });
  assert.equal(other.view, c);
  // the current branch's record is the view's own: the draft is on the view, and no record is kept that would hide the view's later changes
  const bare = view();
  const r = draftSet(bare, [stateFromView(bare)], "main", { text: "hi" });
  assert.equal(r.state, undefined);
  assert.deepEqual(r.view.draft, { text: "hi" });
  // a missing branch id is main
  assert.deepEqual(draftSet(bare, [record("main")], "", { text: "hi" }).state, record("main", { text: "hi" }));
});

test("otherDrafts: a draft on a branch other than the one shown", () => {
  const st = (branch: string, draft?: Draft) => ({ branch, ...(draft ? { draft } : {}) });
  const quote: Reference = { quote: "q", item: 0, start: 0, end: 1 };
  // none
  assert.equal(otherDrafts([], "main"), false);
  assert.equal(otherDrafts([st("main"), st("ab12cd34", { text: "" })], "main"), false);
  // only the shown branch's
  assert.equal(otherDrafts([st("main", { text: "hi" }), st("ab12cd34")], "main"), false);
  // another branch's
  assert.equal(otherDrafts([st("main"), st("ab12cd34", { text: "hi" })], "main"), true);
  assert.equal(otherDrafts([st("main"), st("ab12cd34", { text: "", references: [quote] })], "main"), true);
  // both
  assert.equal(otherDrafts([st("main", { text: "a" }), st("ab12cd34", { text: "b" })], "main"), true);
  // the same records seen from the other branch
  assert.equal(otherDrafts([st("main"), st("ab12cd34", { text: "hi" })], "ab12cd34"), false);
  // a missing branch id is main
  assert.equal(otherDrafts([st("", { text: "hi" })], "main"), false);
});

// ---- the draft's counter: each save names the counter it was typed on, and a draft changed
// elsewhere (another window) is not overwritten by a late save.

type Put = { d: Draft; keepalive: boolean; base?: number; ok(rev: number): Promise<void>; stale(rev: number, draft: Draft | null): Promise<void>; fail(): Promise<void>;
  refused(code: string): Promise<void> };

/** A saver on the counter base, with a server the test answers for: puts are the saves it got. */
function counted(base: number, initial?: Draft) {
  const puts: Put[] = [];
  const local: { d: Draft | null; base?: number } = { d: null };
  const shown: Draft[] = [];
  const unsaved: Unsaved = { read: () => local.d, base: () => local.base, write: (d, b) => { local.d = d; local.base = d ? b : undefined; } };
  const put = (d: Draft, keepalive: boolean, b?: number) => new Promise<number>((resolve, reject) => {
    const end = async (f: () => void) => { f(); await tick(0); };
    puts.push({
      d, keepalive, base: b,
      ok: (rev) => end(() => resolve(rev)),
      stale: (rev, draft) => end(() => reject(Object.assign(new Error("the draft was changed elsewhere"), { status: 409, code: "stale", rev, draft }))),
      fail: () => end(() => reject(new Error("offline"))),
      refused: (code) => end(() => reject(Object.assign(new Error("The connection to the server was interrupted."), { status: 409, code }))),
    });
  });
  const s = new DraftSaver(put, initial, unsaved, 10, base, (d) => { shown.push(d); });
  return { puts, local, shown, s };
}

test("each save names the counter it was typed on, and the next one names the counter the server answered", async () => {
  const { puts, local, s } = counted(4, { text: "a" });
  s.change("ab");
  assert.deepEqual([local.d, local.base], [{ text: "ab" }, 4]); // the unsaved copy records its base
  await tick(30);
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "ab" }, 4]);
  await puts[0].ok(5);
  assert.equal(local.d, null);
  s.change("abc"); s.flush();
  assert.deepEqual([puts.length, puts[1].base, local.base], [2, 5, 5]);
});

test("a save waits for the one in flight, and names the counter that one's answer gave", async () => {
  const { puts, local, s } = counted(1);
  s.change("a"); s.flush();
  s.change("ab"); s.flush();
  await tick(30);
  assert.equal(puts.length, 1); // one at a time: the second has no counter to name yet
  await puts[0].ok(2);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "ab" }, 2]);
  assert.deepEqual([local.d, local.base], [{ text: "ab" }, 2]); // the copy is on the new counter
  await puts[1].ok(3);
  assert.equal(local.d, null);
});

test("a page that goes away does not wait for the save in flight: it names the counter that save leaves", () => {
  const { puts, s } = counted(1);
  s.change("a"); s.flush();
  s.change("ab"); s.flush(true);
  assert.deepEqual(puts.map((p) => [p.d.text, p.base, p.keepalive]), [["a", 1, false], ["ab", 2, true]]);
});

test("a stale refusal of a composer emptied here, with nothing typed since, shows the server's draft", async () => {
  const { puts, local, shown, s } = counted(1, { text: "a" });
  s.change(""); s.flush(); // no text of this composer's is in flight or pending
  await puts[0].stale(3, { text: "newer" });
  assert.deepEqual(shown, [{ text: "newer" }]);
  assert.equal(local.d, null);
  s.change("newer"); // what the composer holds now is the saved draft
  await tick(30);
  assert.equal(puts.length, 1);
  s.change("newer!"); s.flush();
  assert.deepEqual([puts[1].d, puts[1].base], [{ text: "newer!" }, 3]);
});

test("a stale refusal with another window's draft keeps the text typed here, and saves it again on the new counter", async () => {
  const { puts, local, shown, s } = counted(1);
  s.change("late"); s.flush();
  await puts[0].stale(3, { text: "newer" });
  assert.deepEqual(shown, []); // typed since its base: the stored draft does not replace it
  assert.deepEqual([local.d, local.base], [{ text: "late" }, 3]);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "late" }, 3]);
  await puts[1].ok(4);
  assert.deepEqual([shown, local.d], [[], null]);
  // the stored draft is the refused text itself (typed alike in the other window): nothing is saved again
  const b = counted(1);
  b.s.change("same"); b.s.flush();
  await b.puts[0].stale(3, { text: "same" });
  await tick(30);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[], null, 1]);
  // the other window's draft came as an event while the save was in flight, then the refusal
  const c = counted(1);
  c.s.change("late"); c.s.flush();
  c.s.arrived(3, { text: "newer" });
  await c.puts[0].stale(3, { text: "newer" });
  assert.deepEqual([c.shown, c.puts.length, c.puts[1].d, c.puts[1].base], [[], 2, { text: "late" }, 3]);
});

test("a stale refusal with no draft on the server keeps the text, and saves it again on the new counter", async () => {
  const { puts, local, shown, s } = counted(1, { text: "a" });
  s.change("ab"); s.flush();
  await puts[0].stale(2, null);
  assert.deepEqual(shown, []); // none on the server takes no typed text out of the composer
  assert.deepEqual([local.d, local.base], [{ text: "ab" }, 2]);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "ab" }, 2]);
  await puts[1].ok(3);
  assert.equal(local.d, null);
  s.change("abc"); s.flush();
  assert.equal(puts[2].base, 3);
});

test("a stale refusal with no draft on the server, the composer being empty: nothing is shown and nothing is saved again", async () => {
  const { puts, local, shown, s } = counted(1, { text: "a" });
  s.change(""); s.flush(); // emptied here
  await puts[0].stale(2, null);
  await tick(30);
  assert.deepEqual([shown, local.d, puts.length], [[], null, 1]);
  // and one emptied while the save of its text was in flight
  const b = counted(1);
  b.s.change("late"); b.s.flush();
  b.s.change("");
  await b.puts[0].stale(2, null);
  await tick(30);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[], null, 1]);
});

test("text typed after a Send is kept when its save is refused as stale by the drop of the sent draft", async () => {
  const { puts, local, shown, s } = counted(3, { text: "first" });
  s.change("");     // the Send empties the composer
  s.change("next"); // typed while the message is sent
  await tick(30);
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "next" }, 3]);
  s.arrived(4, null); // the server dropped the sent draft: its event, then the save's refusal
  await puts[0].stale(4, null);
  assert.deepEqual(shown, []);
  assert.deepEqual([local.d, local.base], [{ text: "next" }, 4]);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "next" }, 4]);
  await puts[1].ok(5);
  assert.deepEqual([shown, local.d], [[], null]);
});

test("text typed after a Send and saved is kept when the drop of the sent draft arrives after it", async () => {
  const { puts, local, shown, s } = counted(3, { text: "first" });
  s.sending(); // the Send is on its way
  s.change("");
  s.change("next", [{ name: "a", id: "b_1" }]);
  await tick(30);
  await puts[0].ok(4);
  s.arrived(4, { text: "next", mentions: [{ name: "a", id: "b_1" }] }); // the save's echo
  assert.equal(local.d, null);
  s.arrived(5, null); // a server that drops the sent draft late
  assert.deepEqual(shown, []);
  assert.deepEqual([local.d, local.base], [{ text: "next", mentions: [{ name: "a", id: "b_1" }] }, 5]);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "next", mentions: [{ name: "a", id: "b_1" }] }, 5]);
  await puts[1].ok(6);
  assert.deepEqual([shown, local.d], [[], null]);
  // the drop was taken once: a draft cleared elsewhere after it empties the composer as before
  s.arrived(7, null);
  assert.deepEqual([shown, puts.length], [[{ text: "" }], 2]);
});

test("the drop of the sent draft that arrives while the save of the text typed since is in flight keeps the text", async () => {
  const { puts, local, shown, s } = counted(3, { text: "first" });
  s.sending();
  s.change(""); s.change("next"); s.flush();
  await puts[0].ok(4); // answered before its events are read
  s.change("next!"); s.flush();
  s.arrived(6, null); // the drop came after this save too
  await puts[1].ok(5);
  assert.deepEqual(shown, []);
  assert.deepEqual([local.d, local.base], [{ text: "next!" }, 6]);
  assert.deepEqual([puts.length, puts[2].d, puts[2].base], [3, { text: "next!" }, 6]);
});

test("saved text that another window sent or cleared goes, when no Send of this composer's is on its way", async () => {
  // typed and saved here, then sent from another window that showed it
  const a = counted(2);
  a.s.change("mine"); a.s.flush();
  await a.puts[0].ok(3);
  a.s.arrived(4, null);
  await tick(30);
  assert.deepEqual([a.shown, a.local.d, a.puts.length], [[{ text: "" }], null, 1]);
  // sent here, and the server told of the removal since: a later one is another window's, also while the Send runs
  const b = counted(2, { text: "first" });
  b.s.sending();
  b.s.change("");
  b.s.arrived(3, null); // the drop of this composer's Send
  b.s.change("next"); b.s.flush();
  await b.puts[0].ok(4);
  b.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[{ text: "" }], null, 1]);
  // emptied here by the user, with no Send, and saved so: the same
  const c = counted(2, { text: "first" });
  c.s.change(""); c.s.flush();
  await c.puts[0].ok(3);
  c.s.change("next"); c.s.flush();
  await c.puts[1].ok(4);
  c.s.arrived(5, null);
  assert.deepEqual([c.shown, c.puts.length], [[{ text: "" }], 2]);
  // text the server never had was deleted here: no Send removed a draft, so nothing is owed
  const d = counted(2);
  d.s.change("hi"); d.s.change("");
  d.s.change("abc"); d.s.flush();
  await d.puts[0].ok(3);
  d.s.arrived(4, null);
  await tick(30);
  assert.deepEqual([d.shown, d.local.d, d.puts.length], [[{ text: "" }], null, 1]);
  // a saved draft deleted and typed again with no pause: no Send, so the removal is another window's
  const e = counted(3, { text: "old" });
  e.s.change(""); e.s.change("new"); e.s.flush();
  await e.puts[0].ok(4);
  e.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([e.shown, e.local.d, e.puts.length], [[{ text: "" }], null, 1]);
});

test("sending: the removal is this composer's own until the Send is answered and the grace has passed, and each Send has its own end", async () => {
  // answered, and the removal comes within the grace: the text typed since is kept
  const a = counted(3, { text: "first" });
  const answered = a.s.sending(20);
  a.s.change(""); a.s.change("next"); a.s.flush();
  await a.puts[0].ok(4);
  answered();
  a.s.arrived(5, null); // the closing event, just after the answer
  assert.deepEqual([a.shown, a.puts.length, a.puts[1].d, a.puts[1].base], [[], 2, { text: "next" }, 5]);
  // answered, and the grace has passed: a removal is another window's
  const b = counted(3, { text: "first" });
  const over = b.s.sending(5);
  b.s.change(""); b.s.change("next"); b.s.flush();
  await b.puts[0].ok(4);
  over();
  await tick(30);
  b.s.arrived(5, null);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[{ text: "" }], null, 1]);
  // the end of an earlier Send does not end a later one that still runs
  const c = counted(3, { text: "first" });
  const first = c.s.sending(5);
  c.s.change(""); c.s.arrived(4, null); // the first Send's removal
  first();
  c.s.sending(5); // the second Send, of text the server never had, not answered yet
  c.s.change("second"); c.s.change("");
  c.s.change("next"); c.s.flush();
  await c.puts[0].ok(5);
  await tick(30); // the first Send's grace is over
  c.s.arrived(6, null); // the second took the message late, and its removal took the text saved since
  assert.deepEqual([c.shown, c.puts.length, c.puts[1].d, c.puts[1].base], [[], 2, { text: "next" }, 6]);
});

// ---- windows on one draft, with a model of the server (plan AC42; the sequences of the review T63)

type Win = { s: DraftSaver; text: string; local: { d: Draft | null }; type(t: string): void };

/** n windows open on one branch whose draft the server has at the counter rev, each with a
 *  composer (text) and its saver, and a model of the server: a save on another counter than the
 *  stored one is refused as stale, an empty save over no draft counts nothing, and a Send reads
 *  the counter when it takes the message and drops the draft only on that counter. Every change
 *  is told to every window, before the answer of the request that made it or (eventsLate) after
 *  it. lock: an ordinary chat's Send holds the chat's lock from the take to its end, and a save
 *  waits for it; a fork's first message does not. grace: how long a Send's mark lasts after its
 *  answer. */
function windows(n: number, rev: number, draft: Draft | null, eventsLate = false, grace = 5) {
  const srv = { rev, draft };
  const saves: string[] = []; // the saves the server got, as `"text"@base`
  const wins: Win[] = [];
  let lock: Promise<void> | null = null;
  const tell = () => {
    const at = srv.rev, d = srv.draft;
    const all = () => { for (const w of wins) w.s.arrived(at, d); };
    if (eventsLate) setTimeout(all, 0); else all();
  };
  const put = async (d: Draft, _keepalive: boolean, base?: number) => {
    await tick(0);
    while (lock) await lock;
    saves.push(`${JSON.stringify(d.text)}@${base}`);
    if (base !== srv.rev) throw Object.assign(new Error("the draft was changed elsewhere"), { status: 409, code: "stale", rev: srv.rev, draft: srv.draft });
    if (!hasDraft(d) && !srv.draft) return srv.rev;
    srv.rev++; srv.draft = hasDraft(d) ? d : null;
    tell();
    return srv.rev;
  };
  for (let i = 0; i < n; i++) {
    const local: { d: Draft | null; base?: number } = { d: null };
    const unsaved: Unsaved = { read: () => local.d, base: () => local.base, write: (d, b) => { local.d = d; local.base = d ? b : undefined; } };
    const w: Win = {
      text: draft?.text ?? "", local,
      type(t) { w.text = t; w.s.change(t); },
      // (show: the composer's box is set, and its effect gives the saver the change)
      s: new DraftSaver(put, draft ?? undefined, unsaved, 10, rev, (d) => { w.type(d.text); }),
    };
    wins.push(w);
  }
  /** w sends what its composer holds, as Composer's submit does. The server takes the message at
   *  once; the returned end ends the Send there (the draft is dropped) and answers the POST. With
   *  refuse the Send is refused at once: nothing is taken, and the text is put back (back). With
   *  fail it fails so with no answer of the server's (the network): nothing tells that it removed
   *  nothing. */
  const send = (w: Win, o: { lock?: boolean; refuse?: boolean; fail?: boolean } = {}) => {
    const text = w.text, answered = w.s.sending(grace);
    w.type("");
    if (o.refuse || o.fail) { back(w, text, answered(!!o.refuse)); return () => {}; }
    const at = srv.rev;
    let free!: () => void;
    if (o.lock) lock = new Promise((r) => { free = r; });
    return () => {
      if (srv.draft && srv.rev === at) { srv.rev++; srv.draft = null; tell(); }
      answered();
      if (o.lock) { lock = null; free(); }
    };
  };
  /** What Composer's submit does with the message of a Send that failed. removed: what the saver
   *  answered as the Send ended. The message goes back into an empty box, but not when its draft
   *  was removed on the server meanwhile. */
  const back = (w: Win, text: string, removed: boolean) => { if (putsBack(removed) && !w.text.trim()) w.type(text); };
  /** Everything settled: the pauses, the saves and the grace of a Send. */
  const settle = () => tick(60);
  const state = () => ({ texts: wins.map((w) => w.text), unsaved: wins.map((w) => w.local.d), server: [srv.rev, srv.draft?.text ?? null] });
  return { wins, saves, send, back, settle, state };
}

const FIRST: Draft = { text: "first" };

test("windows: a draft deleted and typed again with no pause, then sent from the other window, does not come back", async () => {
  const { wins: [a, b], saves, send, settle, state } = windows(2, 3, { text: "old" });
  a.type(""); a.type("new");
  await settle();
  assert.deepEqual(state(), { texts: ["new", "new"], unsaved: [null, null], server: [4, "new"] });
  send(b)();
  await settle();
  assert.deepEqual(state(), { texts: ["", ""], unsaved: [null, null], server: [5, null] });
  assert.deepEqual(saves, ['"new"@3']);
});

test("windows: text typed during this window's own Send, then sent from the other window, does not come back", async () => {
  const { wins: [a, b], saves, send, settle, state } = windows(2, 3, FIRST);
  const end = send(a); // a fork's first message: the Send is slow, and holds no lock
  a.type("next");
  await tick(30);
  end();
  await settle();
  assert.deepEqual(state(), { texts: ["next", "next"], unsaved: [null, null], server: [4, "next"] });
  send(b)();
  await settle();
  assert.deepEqual(state(), { texts: ["", ""], unsaved: [null, null], server: [5, null] });
  assert.deepEqual(saves, ['"next"@3']);
});

test("windows: a Send refused here, the text put back, then sent from the other window, does not come back", async () => {
  const { wins: [a, b], saves, send, settle, state } = windows(2, 3, FIRST);
  send(a, { refuse: true });
  await settle();
  assert.deepEqual(state(), { texts: ["first", "first"], unsaved: [null, null], server: [3, "first"] });
  send(b)();
  await settle();
  assert.deepEqual(state(), { texts: ["", ""], unsaved: [null, null], server: [4, null] });
  assert.deepEqual(saves, []);
});

test("windows: a fork's first message, with text typed at once, keeps the text", async () => {
  // the save is accepted during the Send, which then ends: the counter it found is gone, nothing is dropped
  const x = windows(1, 3, FIRST);
  let end = x.send(x.wins[0]);
  x.wins[0].type("next");
  await tick(30);
  end();
  await x.settle();
  assert.deepEqual([x.state(), x.saves], [{ texts: ["next"], unsaved: [null], server: [4, "next"] }, ['"next"@3']]);
  // the empty save leaves first, then the text
  const y = windows(1, 3, FIRST);
  end = y.send(y.wins[0]);
  await tick(30);
  y.wins[0].type("next");
  await tick(30);
  end();
  await y.settle();
  assert.deepEqual([y.state(), y.saves], [{ texts: ["next"], unsaved: [null], server: [5, "next"] }, ['""@3', '"next"@4']]);
  // the Send ends before the save leaves
  const z = windows(1, 3, FIRST);
  end = z.send(z.wins[0]);
  z.wins[0].type("next");
  end();
  await z.settle();
  assert.deepEqual([z.state(), z.saves], [{ texts: ["next"], unsaved: [null], server: [5, "next"] }, ['"next"@4']]);
});

test("windows: an ordinary chat, whose save waits for the Send, keeps the text typed after it", async () => {
  for (const eventsLate of [false, true]) {
    // the save of the text waits, and is refused as stale with no draft
    const x = windows(1, 3, FIRST, eventsLate);
    let end = x.send(x.wins[0], { lock: true });
    x.wins[0].type("next");
    await tick(30);
    end();
    await x.settle();
    assert.deepEqual([x.state(), x.saves], [{ texts: ["next"], unsaved: [null], server: [5, "next"] }, ['"next"@3', '"next"@4']], `events late: ${eventsLate}`);
    // the empty save waits, and the text is typed meanwhile
    const y = windows(1, 3, FIRST, eventsLate);
    end = y.send(y.wins[0], { lock: true });
    await tick(30);
    y.wins[0].type("next");
    await tick(30);
    end();
    await y.settle();
    assert.deepEqual([y.state(), y.saves], [{ texts: ["next"], unsaved: [null], server: [5, "next"] }, ['""@3', '"next"@4']], `events late: ${eventsLate}`);
  }
});

test("windows: with nothing typed after the Send the composer stays empty and nothing is saved again", async () => {
  // a fast Send
  const x = windows(2, 3, FIRST);
  x.send(x.wins[0], { lock: true })();
  await x.settle();
  assert.deepEqual([x.state(), x.saves], [{ texts: ["", ""], unsaved: [null, null], server: [4, null] }, []]);
  // a slow one: the empty save waits for it, and is refused
  const y = windows(2, 3, FIRST);
  const end = y.send(y.wins[0], { lock: true });
  await tick(30);
  end();
  await y.settle();
  assert.deepEqual([y.state(), y.saves], [{ texts: ["", ""], unsaved: [null, null], server: [4, null] }, ['""@3']]);
  // typed and sent within the pause: the server never had the draft, and counts nothing
  const z = windows(2, 3, null);
  z.wins[0].type("hi");
  z.send(z.wins[0], { lock: true })();
  await z.settle();
  assert.deepEqual([z.state(), z.saves], [{ texts: ["", ""], unsaved: [null, null], server: [3, null] }, []]);
});

test("windows: the other window's save wins while this one's is in flight: the text typed here stays, is saved on the next counter, and the other window shows it", async () => {
  const { wins: [a, b], saves, settle, state } = windows(2, 3, FIRST);
  b.type("first plus B"); b.s.flush();
  a.type("first plus A"); a.s.flush(); // in flight when B's lands
  await settle();
  assert.deepEqual(state(), { texts: ["first plus A", "first plus A"], unsaved: [null, null], server: [5, "first plus A"] });
  assert.deepEqual(saves, ['"first plus B"@3', '"first plus A"@3', '"first plus A"@4']);
  // the control: the other window edits while this one is idle, and its draft is shown
  const c = windows(2, 3, FIRST);
  c.wins[1].type("first, edited");
  await c.settle();
  assert.deepEqual(c.state(), { texts: ["first, edited", "first, edited"], unsaved: [null, null], server: [4, "first, edited"] });
});

// ---- a Send that removed nothing: the next removal is another window's (the review T85, the browser run T89)

const GONE = { texts: ["", ""], unsaved: [null, null] };

test("windows: a Send that failed here, then the other window's Send within the grace: the message does not come back", async () => {
  for (const how of [{ refuse: true }, { fail: true }]) {
    const { wins: [a, b], saves, send, settle, state } = windows(2, 3, FIRST, false, 200);
    send(a, how);
    send(b)(); // A's mark is still set when the Send failed with no answer
    await settle();
    assert.deepEqual([state(), saves], [{ ...GONE, server: [4, null] }, []], JSON.stringify(how));
  }
});

test("windows: the other window's Send refused while this one's runs: this one's removal is not undone there", async () => {
  for (const how of [{ refuse: true }, { fail: true }]) {
    const { wins: [a, b], saves, send, settle, state } = windows(2, 3, FIRST, false, 200);
    const end = send(a);
    send(b, how);
    end();
    await settle();
    assert.deepEqual([state(), saves], [{ ...GONE, server: [4, null] }, []], JSON.stringify(how));
  }
});

test("windows: a note the other window typed and deleted during this window's Send of text the server never had does not come back", async () => {
  const { wins: [a, b], saves, send, settle, state } = windows(2, 3, null, false, 200);
  a.type("hi");
  const end = send(a);
  b.type("note");
  await tick(30);
  assert.deepEqual(state().texts, ["note", "note"]);
  b.type("");
  await tick(30);
  end();
  await settle();
  assert.deepEqual([state(), saves], [{ ...GONE, server: [5, null] }, ['"note"@3', '""@4']]);
});

test("windows: a message typed and sent at once, then text typed and saved here and sent from the other window within the grace, does not come back", async () => {
  // (the browser run: A1's Send of text the server never had removed nothing, and A2's removal was taken as A1's)
  for (const lock of [true, false]) {
    const { wins: [a, b], saves, send, settle, state } = windows(2, 0, null, false, 200);
    a.type("hello");
    send(a, { lock })(); // answered at once: the server had no draft, and this composer saved none meanwhile
    a.type("next");
    await tick(30);
    assert.deepEqual(state(), { texts: ["next", "next"], unsaved: [null, null], server: [1, "next"] });
    send(b)();
    await settle();
    assert.deepEqual([state(), saves], [{ ...GONE, server: [2, null] }, ['"next"@0']], `lock: ${lock}`);
  }
});

test("windows: a Send refused after its emptied draft was saved: the text put back is saved again, and both windows show it", async () => {
  const { wins: [a], saves, settle, state } = windows(2, 3, FIRST);
  const answered = a.s.sending(5);
  a.type("");
  await tick(30); // the Send is slow: the emptied draft is saved before its refusal
  assert.deepEqual(state(), { texts: ["", ""], unsaved: [null, null], server: [4, null] });
  a.type("first"); answered(true); // refused: the composer puts the text back
  await settle();
  assert.deepEqual([state(), saves], [{ texts: ["first", "first"], unsaved: [null, null], server: [5, "first"] }, ['""@3', '"first"@4']]);
});

// ---- a failed Send whose draft the other window sent meanwhile (the review T105, D1)

test("windows: a Send refused after the other window sent the same draft puts nothing back", async () => {
  // B presses Enter; A's Send of that draft is taken, and its removal reaches B before B's refusal does
  const x = windows(2, 3, FIRST, false, 200);
  let [a, b] = x.wins;
  let answered = b.s.sending(200);
  b.type("");
  x.send(a)();
  x.back(b, "first", answered(true));
  await x.settle();
  assert.deepEqual([x.state(), x.saves], [{ ...GONE, server: [4, null] }, []]);
  // the same, B's Send being slow: its emptied draft is saved first, refused as stale by A's removal
  const y = windows(2, 3, FIRST, false, 200);
  [a, b] = y.wins;
  answered = b.s.sending(200);
  b.type(""); b.s.flush();
  y.send(a)(); // (A's composer still holds the draft: B's save has not reached the server)
  await tick(5);
  y.back(b, "first", answered(true));
  await y.settle();
  assert.deepEqual([y.state(), y.saves], [{ ...GONE, server: [4, null] }, ['""@3']]);
  // a Send that failed with no answer: the removal is the other window's, or that of this Send, taken after all
  const z = windows(2, 3, FIRST, false, 200);
  [a, b] = z.wins;
  answered = b.s.sending(200);
  b.type("");
  z.send(a)();
  z.back(b, "first", answered(false));
  await z.settle();
  assert.deepEqual([z.state(), z.saves], [{ ...GONE, server: [4, null] }, []]);
});

test("sending: what ends a Send answers whether the sent draft was removed on the server while it was on its way", async () => {
  // no removal: the message goes back
  const a = counted(3, { text: "first" });
  let end = a.s.sending(50);
  a.s.change("");
  assert.equal(end(true), false);
  // the draft removed while the Send runs; told once
  const b = counted(3, { text: "first" });
  end = b.s.sending(50);
  b.s.change("");
  b.s.arrived(4, null);
  assert.deepEqual([end(true), end(true)], [true, false]);
  // text the server never had (typed and sent within the pause) is no draft another window can send: a removal is of something else
  const c = counted(3, { text: "fir" });
  c.s.change("first");
  end = c.s.sending(50);
  c.s.change("");
  c.s.arrived(4, null);
  assert.equal(end(true), false);
  // this composer's own emptied draft, saved during a slow Send, is no removal by another: the message goes back
  const d = counted(3, { text: "first" });
  end = d.s.sending(50);
  d.s.change(""); d.s.flush();
  await d.puts[0].ok(4);
  assert.equal(end(true), false);
  // nor is the removal of another draft that came from elsewhere since
  const e = counted(3, { text: "first" });
  end = e.s.sending(50);
  e.s.change("");
  e.s.arrived(4, { text: "theirs" }); e.s.arrived(5, null);
  assert.equal(end(true), false);
  // nor is the removal of text this composer saved since the Send began
  const i = counted(3, { text: "first" });
  end = i.s.sending(50);
  i.s.change(""); i.s.change("next"); i.s.flush();
  await i.puts[0].ok(4);
  i.s.arrived(5, null);
  assert.equal(end(true), false);
  // a held Send whose own text was never the server's (its save was refused as stale): nothing of it was removed
  const f = counted(3);
  f.s.change("hello");
  end = f.s.sending(50, true);
  f.s.change("");
  await f.puts[0].stale(4, null);
  assert.equal(end(true), false);
  // a held Send whose draft the server removed (the chat started there): told, and the composer decides (putsBack)
  const g = counted(3, { text: "first" });
  end = g.s.sending(50, true);
  g.s.change("");
  g.s.arrived(4, null);
  assert.equal(end(true), true);
  // a later Send starts anew
  const h = counted(3, { text: "first" });
  const first = h.s.sending(50);
  h.s.change("");
  h.s.arrived(4, null);
  end = h.s.sending(50);
  assert.deepEqual([first(true), end(true)], [false, false]);
});

test("own: only text this composer saved since its Send began is saved again when a removal comes", async () => {
  // a draft that was there before the Send, put back when it failed: a removal is the other window's Send of it
  const a = counted(3, { text: "first" });
  a.s.sending(50);
  a.s.change(""); a.s.change("first");
  a.s.arrived(4, null);
  await tick(30);
  assert.deepEqual([a.shown, a.local.d, a.puts.length], [[{ text: "" }], null, 0]);
  // a save that was in flight when the Send began is not one made since
  const b = counted(3);
  b.s.change("first"); b.s.flush();
  b.s.sending(50);
  b.s.change("");
  await b.puts[0].ok(4);
  b.s.change("first"); // put back
  b.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[{ text: "" }], null, 1]);
  // text saved since the Send began, then replaced by a draft from elsewhere: that one's removal is not this Send's
  const c = counted(3, { text: "first" });
  c.s.sending(50);
  c.s.change(""); c.s.change("next"); c.s.flush();
  await c.puts[0].ok(4);
  c.s.arrived(5, { text: "theirs" });
  c.s.arrived(6, null);
  await tick(30);
  assert.deepEqual([c.shown, c.local.d, c.puts.length], [[{ text: "theirs" }, { text: "" }], null, 1]);
  // the same text arriving from elsewhere is theirs as well
  const d = counted(3, { text: "first" });
  d.s.sending(50);
  d.s.change(""); d.s.change("next"); d.s.flush();
  await d.puts[0].ok(4);
  d.s.arrived(5, { text: "other" }); d.s.arrived(6, { text: "next" });
  d.s.arrived(7, null);
  await tick(30);
  assert.deepEqual([d.shown.at(-1), d.local.d, d.puts.length], [{ text: "" }, null, 1]);
  // text saved during an earlier Send is not this Send's own: sent again, the Send failing with no answer and the text put back, a removal is the other window's
  const e = counted(3, { text: "first" });
  const over = e.s.sending(5);
  e.s.change(""); e.s.change("next"); e.s.flush();
  await e.puts[0].ok(4);
  over();
  await tick(30); // the first Send is over
  e.s.sending(50);
  e.s.change(""); e.s.change("next");
  e.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([e.shown, e.local.d, e.puts.length], [[{ text: "" }], null, 1]);
});

test("sending: a Send that can have removed nothing is over with its answer, without the grace", async () => {
  // refused: nothing was taken, whatever was saved meanwhile
  const a = counted(3, { text: "first" });
  const refused = a.s.sending(50);
  a.s.change(""); a.s.change("next"); a.s.flush();
  await a.puts[0].ok(4);
  refused(true);
  a.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([a.shown, a.local.d, a.puts.length], [[{ text: "" }], null, 1]);
  // the server had no draft when it began, and nothing was saved until its answer: text saved after that is not the Send's to remove
  const b = counted(3);
  b.s.change("hello");
  const answered = b.s.sending(50);
  b.s.change("");
  answered();
  b.s.change("next"); b.s.flush();
  await b.puts[0].ok(4);
  b.s.arrived(5, null);
  await tick(30);
  assert.deepEqual([b.shown, b.local.d, b.puts.length], [[{ text: "" }], null, 1]);
  // the same, but a save of text is in flight at the answer: the Send may have found it, and the grace holds
  const c = counted(3);
  const end = c.s.sending(50);
  c.s.change("next"); c.s.flush();
  end();
  await c.puts[0].ok(4);
  c.s.arrived(5, null);
  assert.deepEqual([c.shown, c.puts.length, c.puts[1].d, c.puts[1].base], [[], 2, { text: "next" }, 5]);
  // the server had a draft when it began: the grace holds
  const d = counted(3, { text: "first" });
  const over = d.s.sending(50);
  d.s.change("");
  over();
  d.s.change("next"); d.s.flush();
  await d.puts[0].ok(4);
  d.s.arrived(5, null);
  assert.deepEqual([d.shown, d.puts.length, d.puts[1].d, d.puts[1].base], [[], 2, { text: "next" }, 5]);
  // the save of the deleted draft was in flight when it began: the server had that draft still, and the grace holds
  const e = counted(3, { text: "old" });
  e.s.change(""); e.s.flush();
  e.s.change("hi"); // typed and sent within the pause
  const done = e.s.sending(50);
  e.s.change("");
  done();
  await e.puts[0].ok(4);
  e.s.change("next"); e.s.flush();
  await e.puts[1].ok(5);
  e.s.arrived(6, null);
  assert.deepEqual([e.shown, e.puts.length, e.puts[2].d, e.puts[2].base], [[], 3, { text: "next" }, 6]);
});

// ---- a held Send: the first message of a chat on another server (T87 F5)

test("a held Send saves nothing: the sent text stays the draft, and no emptied copy is kept for a reload", async () => {
  const { puts, local, shown, s } = counted(3, { text: "first" });
  s.sending(5, true);
  s.change(""); // the Send empties the composer
  await tick(30);
  assert.deepEqual([puts.length, local.d, shown], [0, null, []]);
  s.flush(); s.flush(true); // the composer or the page goes away
  assert.deepEqual([puts.length, local.d], [0, null]);
});

test("a held Send of text not saved yet saves it at once, and nothing after it", async () => {
  const { puts, local, s } = counted(3);
  s.change("hello"); // Enter within the pause
  s.sending(5, true);
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "hello" }, 3]);
  s.change("");
  assert.deepEqual(local.d, { text: "hello" }); // until the server has it
  await puts[0].ok(4);
  await tick(30);
  assert.deepEqual([puts.length, local.d], [1, null]);
});

test("a held Send that is refused leaves the saved draft", async () => {
  const { puts, local, shown, s } = counted(3, { text: "first" });
  const answered = s.sending(5, true);
  s.change("");
  await tick(30);
  answered(true);
  s.change("first"); // the composer puts the text back
  await tick(30);
  assert.deepEqual([puts.length, local.d, shown], [0, null, []]);
  // also when nothing puts it back (the composer went away): the emptied draft is not saved
  const b = counted(3, { text: "first" });
  const end = b.s.sending(5, true);
  b.s.change("");
  end(true);
  await tick(30);
  assert.deepEqual([b.puts.length, b.local.d], [0, null]);
  // a later change is saved as ever
  b.s.change("first!"); b.s.flush();
  assert.deepEqual([b.puts.length, b.puts[0].d, b.puts[0].base], [1, { text: "first!" }, 3]);
});

test("a held Send that is accepted saves nothing, and the arrival of the next counter with no draft empties it", async () => {
  for (const eventFirst of [true, false]) {
    const { puts, local, shown, s } = counted(3, { text: "first" });
    const answered = s.sending(5, true);
    s.change("");
    await tick(30);
    if (eventFirst) s.arrived(4, null);
    answered();
    if (!eventFirst) s.arrived(4, null);
    await tick(30);
    assert.deepEqual([puts.length, local.d, shown.filter((d) => d.text)], [0, null, []], `event first: ${eventFirst}`);
    s.change(""); // the composer is empty, and that is the saved draft now
    await tick(30);
    assert.equal(puts.length, 0);
    s.change("next"); s.flush();
    assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "next" }, 4]);
  }
});

test("text typed during a held Send is saved after the answer", async () => {
  for (const refused of [false, true]) {
    const { puts, local, shown, s } = counted(3, { text: "first" });
    const answered = s.sending(5, true);
    s.change(""); s.change("next");
    await tick(30);
    assert.deepEqual([puts.length, local.d, local.base], [0, { text: "next" }, 3]);
    if (!refused) s.arrived(4, null); // the server removed the sent draft
    answered(refused);
    await tick(30);
    const base = refused ? 3 : 4;
    assert.deepEqual([puts.length, puts[0].d, puts[0].base, shown], [1, { text: "next" }, base, []], `refused: ${refused}`);
    await puts[0].ok(base + 1);
    assert.equal(local.d, null);
  }
  // a page that goes away during the hold saves the text at once
  const b = counted(3, { text: "first" });
  b.s.sending(5, true);
  b.s.change(""); b.s.change("next"); b.s.flush(true);
  assert.deepEqual([b.puts.length, b.puts[0].d, b.puts[0].keepalive], [1, { text: "next" }, true]);
});

test("a held Send answered before the save of its own text is: the sent text is not saved again (the review T105, D2)", async () => {
  // the chat started there: the save, on the counter of the chat that was not started, is refused as stale with no draft
  const a = counted(3);
  a.s.change("hello"); // Enter within the pause
  let answered = a.s.sending(5, true);
  a.s.change("");
  answered();
  await a.puts[0].stale(4, null);
  await tick(30);
  assert.deepEqual([a.puts.length, a.local.d, a.shown], [1, null, []]);
  a.s.change("next"); a.s.flush();
  assert.deepEqual([a.puts.length, a.puts[1].d, a.puts[1].base], [2, { text: "next" }, 4]);
  // the text landed after all: the emptied draft is saved over it
  const b = counted(3);
  b.s.change("hello");
  answered = b.s.sending(5, true);
  b.s.change("");
  answered();
  await b.puts[0].ok(4);
  assert.deepEqual([b.puts.length, b.puts[1].d, b.puts[1].base, b.shown], [2, { text: "" }, 4, []]);
  await b.puts[1].ok(5);
  await tick(30);
  assert.deepEqual([b.puts.length, b.local.d], [2, null]);
  // refused: the text is the draft, as it is being saved, and the composer puts it back
  const c = counted(3);
  c.s.change("hello");
  answered = c.s.sending(5, true);
  c.s.change("");
  assert.equal(answered(true), false);
  c.s.change("hello");
  await c.puts[0].ok(4);
  await tick(30);
  assert.deepEqual([c.puts.length, c.local.d, c.shown], [1, null, []]);
  // the same text typed again after the answer is text typed here: kept, and saved on the new counter
  const d = counted(3);
  d.s.change("hello");
  answered = d.s.sending(5, true);
  d.s.change("");
  answered();
  d.s.change("hello");
  await d.puts[0].stale(4, null);
  assert.deepEqual([d.puts.length, d.puts[1].d, d.puts[1].base, d.shown], [2, { text: "hello" }, 4, []]);
});

test("a first message whose text was kept (first_text_kept), told to the saver on a counter below the server's: the text put back is saved on the server's", async () => {
  // (kept counts from the saver's counter, which can be behind the server's: the save refused as stale brings the counter)
  const { puts, local, shown, s } = counted(3, { text: "second" });
  const answered = s.sending(5, true);
  s.change("");
  s.kept(); // what the composer tells: the draft went on the next counter
  assert.equal(putsBack(answered(true), "first_text_kept"), true);
  s.change("second"); s.flush();
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "second" }, 4]);
  await puts[0].stale(6, null);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base, shown], [2, { text: "second" }, 6, []]);
  await puts[1].ok(7);
  assert.equal(local.d, null);
});

test("kept (first_text_kept) counts the removal from the saver's own counter, and only when none has come since the Send began (the review T123, N1)", async () => {
  // The swap's removal has come, and after it another window's draft on the next counter (its saver saved its text again): the server is on that
  // counter. Counted from the record, which has that draft, it was one more, which the server never reaches: the save was refused with a lower counter.
  const { puts, local, shown, s } = counted(3, { text: "second" });
  let answered = s.sending(5, true);
  s.change("");
  s.arrived(4, null);
  s.arrived(5, { text: "theirs" });
  s.kept();
  assert.equal(putsBack(answered(true), "first_text_kept"), true);
  s.change("second");
  assert.deepEqual([local.d, local.base], [{ text: "second" }, 5], "the unsaved copy is on the server's counter: a reload shows it");
  s.flush();
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "second" }, 5]);
  await puts[0].ok(6);
  assert.deepEqual([local.d, shown], [null, [{ text: "theirs" }]]);

  // the answer before the removal's event: the removal is counted, and its event is then no news
  const a = counted(3, { text: "second" });
  answered = a.s.sending(5, true);
  a.s.change("");
  a.s.kept();
  assert.equal(answered(true), true);
  a.s.change("second");
  a.s.arrived(4, null);
  a.s.flush();
  assert.deepEqual([a.puts.length, a.puts[0].base, a.shown], [1, 4, []]);
  // told twice, it is counted once
  const twice = counted(3, { text: "second" });
  answered = twice.s.sending(5, true);
  twice.s.change("");
  twice.s.kept(); twice.s.kept();
  answered(true);
  twice.s.change("second"); twice.s.flush();
  assert.equal(twice.puts[0].base, 4);

  // the removal's event came while the save of the sent text was in flight, and waits for that save's answer: it has come, and is not counted again
  const b = counted(3);
  b.s.change("second");
  answered = b.s.sending(5, true); // (a held Send saves its text at once)
  assert.deepEqual([b.puts.length, b.puts[0].base], [1, 3]);
  b.s.change("");
  b.s.arrived(4, { text: "second" }); // that save's echo
  b.s.arrived(5, null);
  b.s.kept();
  answered(true);
  await b.puts[0].ok(4);
  b.s.change("typed after"); b.s.flush();
  assert.deepEqual([b.puts.length, b.puts[1].d, b.puts[1].base], [2, { text: "typed after" }, 5]);

  // with no Send of this composer's on its way, and for a draft with no counter, there is nothing to count
  const idle = counted(3, { text: "second" });
  idle.s.kept();
  idle.s.change("more"); idle.s.flush();
  assert.deepEqual([idle.puts[0].base, idle.shown], [3, []]);
  const plain = saver({ text: "second" });
  answered = plain.s.sending(5, true);
  plain.s.kept();
  answered(true);
  assert.deepEqual(plain.puts, []);
});

test("boxText: the box gets the draft to show as it appears, else the text the composer holds unseen (the review T105, D3)", () => {
  assert.equal(boxText({ text: "draft" }, "held"), "draft");
  assert.equal(boxText({ text: "", references: [quote] }, "held"), ""); // a draft of quotes alone
  assert.equal(boxText(undefined, "held"), "held"); // set while the chat was archived, and not the server's draft yet
  assert.equal(boxText({ text: "" }, "held"), "held");
  assert.equal(boxText(null, ""), null);
  assert.equal(boxText(undefined, ""), null);
});

test("staleTaken: what a save refused as stale tells goes into the store unless a later counter is known there", () => {
  assert.equal(staleTaken(5, 4), true);
  assert.equal(staleTaken(5, 5), true); // the record has the draft of the refused save, set before the server answered
  assert.equal(staleTaken(4, 5), false); // an event brought a later draft since
  assert.equal(staleTaken(0, undefined), true); // no record
});

test("answerNewer: a save's answer with a later counter than the record's brings its draft with it", async () => {
  assert.equal(answerNewer(5, 4), true);
  assert.equal(answerNewer(5, 5), false); // the event of that save came first: the record has both
  assert.equal(answerNewer(4, 5), false);
  assert.equal(answerNewer(1, undefined), true);
  assert.equal(answerNewer(undefined, 4), false); // a server with no counter
  // What it is for: the record had the server's earlier draft again (an event that came while the save was on its way) as the answer raised its
  // counter, and the saver was told that draft on the new counter before the save's own answer reached it. It put it into the box over the text saved.
  const { puts, shown, s } = counted(3, { text: "a" });
  s.change("ab"); s.flush();
  s.arrived(4, { text: "a" }); // (what the record gave then)
  await puts[0].ok(4);
  assert.deepEqual(shown, [{ text: "a" }]);
  // with the draft that counter counts, it is the save's echo
  const b = counted(3, { text: "a" });
  b.s.change("ab"); b.s.flush();
  b.s.arrived(4, { text: "ab" });
  await b.puts[0].ok(4);
  assert.deepEqual([b.shown, b.puts.length, b.local.d], [[], 1, null]);
});

// ---- the composer, read as source for what it passes on (the unit tests have no DOM)

test("the composer shows the text it holds when its box appears, takes a save's answer and a stale one by their counters, ends its Send for the saver whatever is thrown, and puts back by what the saver tells", () => {
  const composer = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
  // D3: after an unarchive the box has the composer's text when there is no draft to show
  assert.ok(composer.includes("    const d = draftToShow(chatId, branch), t = boxText(d, current.current);\n    if (t !== null) input.current?.set(t);\n    if (!hasDraft(d)) return;"));
  assert.ok(composer.includes("if (stale && staleTaken(stale.rev, draftRevOf(chat, branch)) && storeDraft(chat, branch, stale.draft)) setDraftRev(chat, branch, stale.rev);"));
  // a save's answer gives the record its counter together with the draft it counts
  assert.ok(composer.includes("    if (answerNewer(rev, draftRevOf(chat, branch))) storeDraft(chat, branch, d);\n    setDraftRev(chat, branch, rev);"));
  // D4: the saver is told of the Send inside the try, and nothing that can throw stands between the two
  assert.ok(composer.includes("    try {\n      answered = getState().moves[chatId] ? null : drafts.current!.sending(undefined, first);"));
  assert.equal(composer.split(".sending(").length, 2);
  assert.ok(composer.includes("    } finally {\n      answered?.(refused); setSending(false);"));
  // D1: the Send is ended before anything goes back, and nothing goes back when the saver tells of a removal
  const at = (t: string) => { const i = composer.indexOf(t); assert.ok(i >= 0, t); return i; };
  const ended = at("const removed = answered?.(refused) ?? false;\n      answered = null;\n      if (putsBack(removed, code)) {");
  const closed = at("      }\n      // The chat is read again when its state here is stale");
  for (const t of ["setQuotes((now) => mergeQuotes(qs, now));", "if (!current.current.trim()) input.current?.set(t);", "!current.current.trim()) setBox(t);", "drafts.current!.change(t, p, qs);"]) {
    assert.ok(at(t) > ended && at(t) < closed && composer.indexOf(t, at(t) + 1) < 0, t);
  }
  assert.ok(at("if (code === FIRST_TEXT_KEPT) drafts.current!.kept();") < ended);
  // D4: a composer that went away is known as gone: its failed Send goes to the saver, not to a box
  assert.ok(composer.includes("    return () => {\n      gone.current = true;\n      window.removeEventListener(\"pagehide\", hide);"));
  assert.ok(composer.includes("    window.addEventListener(\"pagehide\", hide);\n    gone.current = false;"));
});

test("the composer sets a text also when it draws no box (an archived chat), puts a refused Send's text back so, and tells its saver of a refusal and of a held Send", () => {
  const composer = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
  // a draft from the server, and what a move sets: with no box the text is what the composer holds all the same
  assert.ok(composer.includes("    if (input.current) input.current.set(t);\n    else { current.current = t; setText(t); }"));
  assert.ok(composer.includes("      setBox(d.text);\n      setPicked(d.mentions ?? []);"));
  assert.ok(composer.includes("if (h.text !== current.current) { setBox(h.text); caretToEnd(box.current); }"));
  // a Send refused while the chat was archived: the composer is still there, without a box
  assert.ok(composer.includes("if (!gone.current && !input.current && !current.current.trim()) setBox(t);"));
  assert.ok(composer.includes("if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs }, e)) drafts.current!.change(t, p, qs);"));
  // the first message of a chat on another server is held, and a refusal is told
  assert.ok(composer.includes("const first = !getState().moves[chatId] && startsThere(c);") && composer.includes("drafts.current!.sending(undefined, first);"));
  assert.ok(composer.includes("refused = e instanceof ApiError && e.status < 500;"));
  assert.ok(composer.includes("answered?.(refused); setSending(false);"));
});

test("a draft that is not none arriving after a Send replaces saved text as before", async () => {
  const { puts, shown, s } = counted(3, { text: "first" });
  s.change(""); s.change("next"); s.flush();
  await puts[0].ok(4);
  s.arrived(5, { text: "other window" });
  assert.deepEqual([shown, puts.length], [[{ text: "other window" }], 1]);
});

test("a stale refusal while more was typed keeps the text, and the next save names the new counter", async () => {
  const { puts, local, shown, s } = counted(1);
  s.change("late"); s.flush();
  s.change("late and more");
  await puts[0].stale(3, { text: "newer" });
  assert.deepEqual(shown, []); // the user's text stays
  assert.deepEqual([local.d, local.base], [{ text: "late and more" }, 3]);
  await tick(30);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "late and more" }, 3]);
  await puts[1].ok(4);
  assert.equal(local.d, null);
});

test("a newer draft arriving with nothing pending and nothing in flight is shown", async () => {
  const { puts, shown, s } = counted(2, { text: "old" });
  s.arrived(2, { text: "old" }); // not newer
  s.arrived(1, { text: "older" });
  assert.deepEqual(shown, []);
  s.arrived(3, { text: "theirs" });
  assert.deepEqual(shown, [{ text: "theirs" }]);
  s.arrived(4, null); // cleared elsewhere (sent from another window)
  assert.deepEqual(shown, [{ text: "theirs" }, { text: "" }]);
  s.change("mine"); s.flush();
  assert.deepEqual([puts.length, puts[0].base], [1, 4]);
});

test("a newer draft that is the one held already is not put in again", () => {
  const { shown, s } = counted(2, { text: "same" });
  s.arrived(3, { text: "same" });
  assert.deepEqual(shown, []);
});

test("a newer draft arriving while something is pending leaves the text, and the next save names the new counter", async () => {
  const { puts, local, shown, s } = counted(2, { text: "old" });
  s.change("typing");
  s.arrived(3, { text: "theirs" });
  assert.deepEqual(shown, []);
  assert.deepEqual([local.d, local.base], [{ text: "typing" }, 3]);
  await tick(30);
  assert.deepEqual([puts.length, puts[0].d, puts[0].base], [1, { text: "typing" }, 3]);
});

test("a newer draft arriving while something is pending that equals it leaves nothing to save", async () => {
  const { puts, local, shown, s } = counted(2, { text: "old" });
  s.change("both");
  s.arrived(3, { text: "both" });
  await tick(30);
  assert.deepEqual([puts.length, shown, local.d], [0, [], null]);
});

test("an event that equals the save in flight is its echo: nothing is shown and nothing is lost", async () => {
  const { puts, local, shown, s } = counted(2);
  s.change("mine"); s.flush();
  s.arrived(3, { text: "mine" }); // before the answer
  await puts[0].ok(3);
  s.arrived(3, { text: "mine" }); // and after it
  assert.deepEqual([shown, local.d, puts.length], [[], null, 1]);
  s.change("mine too"); s.flush();
  assert.equal(puts[1].base, 3);
});

test("a newer draft arriving while a save is in flight is shown once the save ended, when nothing was typed since", async () => {
  const { puts, shown, s } = counted(2);
  s.change("mine"); s.flush();
  s.arrived(4, { text: "theirs, over mine" }); // saved elsewhere on top of this save
  assert.deepEqual(shown, []);
  await puts[0].ok(3);
  assert.deepEqual(shown, [{ text: "theirs, over mine" }]);
  s.change("x"); s.flush();
  assert.equal(puts[1].base, 4);
});

test("a newer draft arriving while a save is in flight and more is typed leaves the text", async () => {
  const { puts, shown, s } = counted(2);
  s.change("mine"); s.flush();
  s.change("mine, more"); s.flush();
  s.arrived(3, { text: "theirs" });
  await puts[0].stale(3, { text: "theirs" });
  assert.deepEqual(shown, []);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base], [2, { text: "mine, more" }, 3]);
});

test("a save that failed otherwise keeps the unsaved copy on its base and the counter", async () => {
  const { puts, local, shown, s } = counted(2);
  s.change("mine"); s.flush();
  await puts[0].fail();
  assert.deepEqual([local.d, local.base, shown], [{ text: "mine" }, 2, []]);
  s.change("mine!"); s.flush();
  assert.equal(puts[1].base, 2);
});

test("a save that failed otherwise, then a newer draft from another window: the text typed stays, with its unsaved copy", async () => {
  const { puts, local, shown, s } = counted(3);
  s.change("typed while the stream was down"); s.flush();
  await puts[0].refused("unknown_client");
  s.arrived(4, { text: "other window" });
  assert.deepEqual(shown, []);
  assert.deepEqual([local.d, local.base], [{ text: "typed while the stream was down" }, 4]);
  await tick(30);
  assert.equal(puts.length, 1); // no timer: the next change or the composer's going away saves it
  s.flush(true);
  assert.deepEqual([puts.length, puts[1].d, puts[1].base, puts[1].keepalive], [2, { text: "typed while the stream was down" }, 4, true]);
  await puts[1].ok(5);
  assert.equal(local.d, null);
});

test("a save that failed otherwise while a newer draft arrived, or with more typed since, keeps what was typed", async () => {
  const a = counted(3);
  a.s.change("mine"); a.s.flush();
  a.s.arrived(4, { text: "other window" }); // while the save was in flight
  await a.puts[0].fail();
  assert.deepEqual([a.shown, a.local.d, a.local.base], [[], { text: "mine" }, 4]);
  const b = counted(3);
  b.s.change("mine"); b.s.flush();
  b.s.change("mine, more");
  await b.puts[0].fail();
  b.s.arrived(4, { text: "other window" });
  await tick(30);
  assert.deepEqual([b.shown, b.puts.length, b.puts[1].d, b.puts[1].base], [[], 2, { text: "mine, more" }, 4]);
  // changed back to what the server has: nothing is pending, and a newer draft is shown
  const c = counted(3, { text: "saved" });
  c.s.change("saved!"); c.s.flush();
  await c.puts[0].fail();
  c.s.change("saved");
  c.s.arrived(4, { text: "other window" });
  assert.deepEqual([c.shown, c.local.d], [[{ text: "other window" }], null]);
});

test("a saver with no counter names none and shows nothing (a run's goal)", async () => {
  const { puts, local, s } = saver();
  s.change("goal");
  s.arrived(3, { text: "other" });
  await tick(30);
  assert.deepEqual([puts.length, local.d], [1, null]);
});

test("unsavedToShow: a copy on the server's counter is used, one on an older base is dropped, one without a base is used", () => {
  const copy = (d: Draft | null, base?: number) => {
    const local = { d, base };
    const u: Unsaved = { read: () => local.d, base: () => local.base, write: (x, b) => { local.d = x; local.base = b; } };
    return { local, u };
  };
  const same = copy({ text: "mine" }, 3);
  assert.deepEqual(unsavedToShow(same.u, 3), { text: "mine" });
  const older = copy({ text: "mine" }, 2);
  assert.equal(unsavedToShow(older.u, 3), null);
  assert.equal(older.local.d, null); // dropped for good: it would replace the newer draft at the next save
  const none = copy({ text: "mine" });
  assert.deepEqual(unsavedToShow(none.u, 3), { text: "mine" }); // from a build before the counter
  assert.deepEqual(unsavedToShow(copy({ text: "mine" }, 2).u, undefined), { text: "mine" }); // the server's counter is not known
  assert.deepEqual(unsavedToShow({ read: () => ({ text: "mine" }), write: () => {} }, 3), { text: "mine" }); // a copy kept with no base at all
  assert.equal(unsavedToShow(copy(null).u, 3), null);
});

test("staleOf: the server's counter and draft of a save refused as stale; null for another error", () => {
  assert.deepEqual(staleOf(Object.assign(new Error("x"), { code: "stale", rev: 4, draft: { text: "d" } })), { rev: 4, draft: { text: "d" } });
  assert.deepEqual(staleOf(Object.assign(new Error("x"), { code: "stale", rev: 4, draft: null })), { rev: 4, draft: { text: "" } });
  assert.equal(staleOf(Object.assign(new Error("x"), { code: "stale" })), null); // a board's stale save has no draft's counter here
  assert.equal(staleOf(Object.assign(new Error("x"), { code: "not_holder", rev: 4 })), null);
  assert.equal(staleOf(new Error("offline")), null);
  assert.equal(staleOf(null), null);
});

test("revSet: the record of a branch gets a later counter; an earlier one, or no record, changes nothing", () => {
  const c = view({ branch: "main" });
  const main = { ...record("main"), draftRev: 2 }, b = record("b1");
  assert.deepEqual(revSet(c, [main, b], "main", 3), { ...main, draftRev: 3 });
  assert.deepEqual(revSet(c, [main, b], "b1", 1), { ...b, draftRev: 1 });
  assert.equal(revSet(c, [main, b], "main", 2), undefined);
  assert.equal(revSet(c, [main, b], "main", 1), undefined);
  assert.equal(revSet(c, [main], "b1", 5), undefined);
  assert.equal(revSet(c, [stateFromView(c)], "main", 5), undefined); // a server without records
});
