// A draft typed while its server was away is saved by itself (src/logic/draftsback.ts): which
// open composers are told when a section's tree arrives and when the page's own connection opens, with a
// real DraftSaver behind each; and where conn.ts and Composer.tsx use it, read as source. The
// events through the real event layer are in conn.test.ts, the saver's own rules in drafts.test.ts.
// The drafts of the composers that are not open are in keptdrafts.test.ts and keptpage.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftBacks, draftBacks } from "../src/logic/draftsback.ts";
import { DraftSaver } from "../src/logic/drafts.ts";
import { LOCAL_SERVER, type ChatImage, type Draft } from "../src/types.ts";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** A composer of a chat on a server that is away or not: its saver, and the saves that server got. */
function composer(backs: DraftBacks, server: string) {
  const c = { server, away: true, rev: 3, saved: [] as string[], drafts: [] as Draft[], tries: 0, gone: () => {} };
  const s = new DraftSaver(async (d: Draft, _keepalive, base) => {
    c.tries++;
    if (c.away) throw Object.assign(new Error("not connected"), { status: 503, code: "server_unreachable" });
    assert.equal(base, c.rev);
    c.saved.push(d.text); c.drafts.push(d);
    return ++c.rev;
  }, undefined, undefined, 5, 3);
  c.gone = backs.add({ server: () => c.server, back: () => s.back() });
  return { c, s };
}
/** Types a text and lets its save fail. */
async function typeAway(x: ReturnType<typeof composer>, text: string) {
  x.s.change(text); x.s.flush();
  await tick();
  assert.deepEqual([x.c.tries, x.c.saved], [1, []]);
}

test("a section's tree arrives: the draft typed while that server was away is saved, and no other server's composer is asked", async () => {
  const backs = new DraftBacks();
  const a = composer(backs, "s_1"), b = composer(backs, "s_2"), here = composer(backs, LOCAL_SERVER);
  await typeAway(a, "for s_1"); await typeAway(b, "for s_2"); await typeAway(here, "for here");
  a.c.away = false;
  backs.sectionBack("s_1");
  await tick();
  assert.deepEqual(a.c.saved, ["for s_1"]);
  assert.deepEqual([b.c.tries, here.c.tries], [1, 1], "the others were not tried");
  // nothing waits for a keystroke, and nothing is saved twice
  await tick(30);
  backs.sectionBack("s_1");
  await tick();
  assert.deepEqual([a.c.saved, a.c.tries], [["for s_1"], 2]);
});

test("the page's own connection opens again: every open composer saves what waits, this computer's chats and the others", async () => {
  const backs = new DraftBacks();
  const here = composer(backs, LOCAL_SERVER), there = composer(backs, "s_1"), still = composer(backs, "s_2");
  await typeAway(here, "local"); await typeAway(there, "remote"); await typeAway(still, "still away");
  here.c.away = false; there.c.away = false;
  backs.opened();
  await tick();
  assert.deepEqual([here.c.saved, there.c.saved], [["local"], ["remote"]]);
  // one whose own server is still away fails again, keeps its text, and is saved when that section's tree arrives
  assert.deepEqual([still.c.saved, still.c.tries], [[], 2]);
  still.c.away = false;
  backs.sectionBack("s_2");
  await tick();
  assert.deepEqual(still.c.saved, ["still away"]);
});

test("the draft that waits is saved with its images: one of images alone is saved too, when the section's tree arrives and when the page's connection opens", async () => {
  const img = (n: number): ChatImage => ({ id: String(n).padStart(64, "0"), name: `i${n}.png`, type: "image/png", size: 1000 + n });
  const backs = new DraftBacks();
  const a = composer(backs, "s_1"), b = composer(backs, "s_1"), here = composer(backs, LOCAL_SERVER);
  // text with two images; an image alone (its upload was answered just before the server went away); and a local chat's while the page's stream was down
  a.s.change("look", [], [], [img(1), img(2)]); a.s.flush();
  b.s.change("", [], [], [img(3)]); b.s.flush();
  here.s.change("", [], [], [img(4)]); here.s.flush();
  await tick();
  assert.deepEqual([a.c.tries, b.c.tries, here.c.tries, a.c.drafts, b.c.drafts], [1, 1, 1, [], []]);
  a.c.away = false; b.c.away = false;
  backs.sectionBack("s_1");
  await tick();
  assert.deepEqual([a.c.drafts, b.c.drafts], [[{ text: "look", images: [img(1), img(2)] }], [{ text: "", images: [img(3)] }]]);
  assert.equal(here.c.tries, 1);
  here.c.away = false;
  backs.opened();
  await tick();
  assert.deepEqual(here.c.drafts, [{ text: "", images: [img(4)] }]);
  // an image removed while the server was away again: what is left is what is saved, and nothing is saved twice
  a.c.away = true;
  a.s.change("look", [], [], [img(2)]); a.s.flush();
  await tick();
  a.c.away = false;
  backs.sectionBack("s_1"); backs.opened();
  await tick(30);
  assert.deepEqual([a.c.drafts.at(-1), a.c.drafts.length, b.c.drafts.length], [{ text: "look", images: [img(2)] }, 2, 1]);
});

test("a composer that went away is told no more, and a chat's server is read when the event comes", async () => {
  const backs = new DraftBacks();
  const a = composer(backs, "s_1");
  await typeAway(a, "mine");
  a.c.gone();
  a.c.away = false;
  backs.sectionBack("s_1"); backs.opened();
  await tick();
  assert.deepEqual([a.c.saved, a.c.tries], [[], 1]);
  // a chat with no server named is on this computer; one whose server is known only later is asked by that one
  const b = composer(backs, "");
  await typeAway(b, "local");
  b.c.away = false;
  backs.sectionBack("s_1");
  await tick();
  assert.deepEqual(b.c.saved, []);
  backs.sectionBack(LOCAL_SERVER);
  await tick();
  assert.deepEqual(b.c.saved, ["local"]);
  const c = composer(backs, LOCAL_SERVER);
  await typeAway(c, "on a board of s_9");
  c.c.server = "s_9"; c.c.away = false;
  backs.sectionBack("s_9");
  await tick();
  assert.deepEqual(c.c.saved, ["on a board of s_9"]);
});

test("the copies the browser keeps are this computer's chats' alone: a section's tree asks the open composers only, a stream's snapshot asks the kept ones", async () => {
  const backs = new DraftBacks();
  let kept = 0;
  backs.kept = { back: async () => { kept++; } } as unknown as DraftBacks["kept"];
  const a = composer(backs, "s_1");
  await typeAway(a, "typed in the open composer");
  a.c.away = false;
  backs.sectionBack("s_1");
  await tick();
  assert.deepEqual([a.c.saved, kept], [["typed in the open composer"], 0], "a composer that is not open has nothing kept to save");
  backs.opened();
  await tick();
  assert.equal(kept, 0, "nor at `hello`: the chats and their counters are not known again yet");
  backs.snapshot();
  await tick();
  assert.equal(kept, 1);
  backs.sectionBack(LOCAL_SERVER);
  assert.equal(kept, 1);
  // with no saver of kept drafts set, a snapshot does nothing
  backs.kept = null;
  backs.snapshot();
});

test("the page: conn.ts tells of `hello`, of a stream's snapshot and of a section's tree, and each composer adds its saver while it is open", () => {
  assert.ok(draftBacks instanceof DraftBacks);
});
