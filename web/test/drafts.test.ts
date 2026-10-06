import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DraftSaver, chatHasDraft, draftKey, draftKeyOf, draftOf, draftSet, draftsAfterSent, hasDraft, heldOf, joinDrafts, legacyDraftKey,
  legacyDraftRenames, otherDrafts, sameDraft, type Unsaved,
} from "../src/logic/drafts.ts";
import { stateFromView } from "../src/logic/branches.ts";
import type { BranchState, ChatView, Draft, Held, Reference } from "../src/types.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function saver(initial?: Draft, fail = false) {
  const puts: [Draft, boolean][] = [];
  const local: { d: Draft | null } = { d: null };
  const unsaved: Unsaved = { read: () => local.d, write: (d) => { local.d = d; } };
  const put = async (d: Draft, k: boolean) => { puts.push([d, k]); if (fail) throw new Error("not_active"); };
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
