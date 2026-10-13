// A draft typed while the page's own connection was away is saved by itself also when its composer
// is closed by the time the connection is back (src/logic/draftsback.ts KeptDrafts): the rules,
// against a server that keeps the counter rule and takes a draft of images alone as a draft, as the
// real one does. The copies the browser keeps are of this computer's chats alone: nothing of a
// section's chat is among them. The same through the page's real event layer, store and saver is in
// keptpage.test.ts; the open composers are in draftsback.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftBacks, KEPT_TRIES, KeptDrafts, keptOf, type Kept } from "../src/logic/draftsback.ts";
import { draftKey, legacyDraftKey } from "../src/logic/drafts.ts";
import type { ChatImage, Draft } from "../src/types.ts";

const tick = () => new Promise<void>((r) => setImmediate(r));
/** An image as a draft names it: id, name, type and size. */
const img = (n: number, name = `i${n}.png`): ChatImage => ({ id: String(n).padStart(64, "0"), name, type: "image/png", size: 1000 + n });
type Put = { chat: string; branch: string; draft: Draft; base: number | undefined; end(): Promise<void> };

/** A page with no composer open, and the local server behind its chats: c_1 to c_4 are chats of this computer that the store knows. */
function page() {
  const copies = new Map<string, string>();                         // the browser's unsaved copies, by localStorage key
  const there = new Map<string, { rev: number; draft: Draft | null }>(); // what the server has, by chat and branch
  const p = {
    copies, there,
    chats: new Set<string>(["c_1", "c_2", "c_3", "c_4"]), // the chats the store has
    away: true,                              // the server takes no call: the page's connection to it is down
    known: new Map<string, number>(),        // the counters the store has, by chat and branch
    open: new Set<string>(), moving: new Set<string>(),
    puts: [] as Put[],                       // every save, as it was asked
    held: null as Put[] | null,              // when set, a save is answered only when the test ends it
    taken: [] as string[],                   // the texts the server took, in order
    stored: (chat: string, branch = "main") => there.get(`${chat}:${branch}`) ?? { rev: 0, draft: null },
    copy: (chat: string, branch = "main") => { const raw = copies.get(draftKey(chat, branch)); return raw === undefined ? null : JSON.parse(raw); },
    keep: (chat: string, d: object, base?: number, branch = "main") => { copies.set(draftKey(chat, branch), JSON.stringify(base === undefined ? d : { ...d, base })); },
  };
  const answer = (chat: string, branch: string, d: Draft, base: number | undefined): number => {
    if (p.away) throw new TypeError("Failed to fetch");
    const at = p.stored(chat, branch);
    if (base !== at.rev) throw Object.assign(new Error("stale"), { status: 409, code: "stale", rev: at.rev, draft: at.draft });
    there.set(`${chat}:${branch}`, { rev: at.rev + 1, draft: d.text || d.references?.length || d.images?.length ? d : null }); // (images alone are a draft)
    p.taken.push(d.text);
    return at.rev + 1;
  };
  const kept = new KeptDrafts({
    all: () => [...copies].map(([k, raw]) => keptOf(k, raw)).filter((k): k is Kept => !!k),
    raw: (chat, branch) => copies.get(draftKey(chat, branch)) ?? null,
    write: (chat, branch, d, base) => { if (d) p.keep(chat, d, base, branch); else copies.delete(draftKey(chat, branch)); },
    open: (chat, branch) => p.open.has(`${chat}:${branch}`),
    moving: (chat) => p.moving.has(chat),
    known: (chat) => p.chats.has(chat),
    rev: (chat, branch) => p.known.get(`${chat}:${branch}`),
    save: (chat, branch, draft, base) => new Promise<number>((resolve, reject) => {
      const end = async () => { try { resolve(answer(chat, branch, draft, base)); } catch (e) { reject(e); } await tick(); };
      const put = { chat, branch, draft, base, end };
      p.puts.push(put);
      if (p.held) p.held.push(put); else void end();
    }),
  });
  return { p, kept };
}

test("a kept draft is read from its localStorage entry as it was written; a run's goal and a chat's from before the branches are none", () => {
  assert.deepEqual(keptOf(draftKey("c_1", "main"), '{"text":"hi","base":3}'), { chat: "c_1", branch: "main", draft: { text: "hi" }, base: 3, raw: '{"text":"hi","base":3}' });
  // every field of the draft stays, its images and the ones this code does not know too: it is handed on as it came
  const raw = JSON.stringify({ text: "see", images: [img(1)], references: [{ quote: "q", item: 1, start: 0, end: 1 }], later: { field: 1 }, base: 7 });
  assert.deepEqual(keptOf(draftKey("c_1", "ab12cd34"), raw)?.draft, { text: "see", images: [img(1)], references: [{ quote: "q", item: 1, start: 0, end: 1 }], later: { field: 1 } });
  // a draft of images alone is one: its text is "", as the composer writes it
  assert.deepEqual(keptOf(draftKey("c_1", "main"), JSON.stringify({ text: "", images: [img(1)], base: 2 }))?.draft, { text: "", images: [img(1)] });
  assert.deepEqual(keptOf(draftKey("c_1", "main"), '{"text":""}'), { chat: "c_1", branch: "main", draft: { text: "" }, raw: '{"text":""}' }); // an emptied composer; no base: a copy of a build before the counter
  for (const [key, value] of [[legacyDraftKey("r_1"), '{"text":"a goal"}'], [legacyDraftKey("c_1"), '{"text":"old"}'], ["aiwb.sel", "{}"], ["aiwb.draft.:main", '{"text":"x"}'], [draftKey("c_1", ""), '{"text":"x"}'],
    [draftKey("c_1", "main"), "not json"], [draftKey("c_1", "main"), '{"base":3}'], [draftKey("c_1", "main"), "null"]] as const) assert.equal(keptOf(key, value), null, key + " " + value);
  assert.equal(keptOf(draftKey("c_1", "main"), null), null);
});

test("the page's own stream opened again: the drafts kept of the chats that are known are saved, each naming the counter it was typed on; a chat that is not known waits", async () => {
  const { p, kept } = page();
  p.there.set("c_1:main", { rev: 3, draft: null }); p.there.set("c_2:ab12cd34", { rev: 9, draft: { text: "old" } });
  p.keep("c_1", { text: "for c_1" }, 3); p.keep("c_2", { text: "for a branch" }, 9, "ab12cd34"); p.keep("c_4", { text: "another chat" }, 0); p.keep("c_9", { text: "nobody's" }, 0);
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => [x.chat, x.branch, x.draft, x.base]),
    [["c_1", "main", { text: "for c_1" }, 3], ["c_2", "ab12cd34", { text: "for a branch" }, 9], ["c_4", "main", { text: "another chat" }, 0]]);
  assert.deepEqual([p.stored("c_1"), p.stored("c_2", "ab12cd34"), p.stored("c_4")], [{ rev: 4, draft: { text: "for c_1" } }, { rev: 10, draft: { text: "for a branch" } }, { rev: 1, draft: { text: "another chat" } }]);
  // saved: the copies go. The one of a chat that is not known waits as it was.
  assert.deepEqual([p.copy("c_1"), p.copy("c_2", "ab12cd34"), p.copy("c_4")], [null, null, null]);
  assert.deepEqual(p.copy("c_9"), { text: "nobody's", base: 0 });
  // and nothing is saved twice
  await kept.back();
  assert.equal(p.puts.length, 3);
});

test("a copy of a chat that is not known waits, and is saved at the first event after the chat is there", async () => {
  const { p, kept } = page();
  p.keep("c_9", { text: "its chat comes with a later snapshot" }, 0);
  p.away = false;
  await kept.back();
  assert.deepEqual([p.puts.length, p.copy("c_9")], [0, { text: "its chat comes with a later snapshot", base: 0 }], "the server is not asked for a chat the store does not have");
  p.chats.add("c_9");
  await kept.back();
  assert.deepEqual([p.puts.map((x) => x.chat), p.stored("c_9"), p.copy("c_9")], [["c_9"], { rev: 1, draft: { text: "its chat comes with a later snapshot" } }, null]);
});

test("back takes no server: the copies are this computer's chats', and every one that is known is saved at the one event", async () => {
  const { p, kept } = page();
  assert.equal(kept.back.length, 0);
  p.keep("c_1", { text: "one" }, 0); p.keep("c_3", { text: "two" }, 0);
  p.away = false;
  await (kept.back as (server?: string) => Promise<void>)("s_1"); // (what once named a server names nothing)
  assert.deepEqual(p.taken, ["one", "two"]);
});

test("a draft is handed on as it was kept: its images, and a field this code does not know, reach the server and stay in the copy that is kept on a new counter", async () => {
  const { p, kept } = page();
  const d = { text: "look", images: [img(1), img(2)], mentions: [{ name: "B", id: "b_1" }], later: ["a field of a later build"] };
  p.keep("c_1", d, 2);
  p.there.set("c_1:main", { rev: 5, draft: { text: "theirs" } });
  p.away = false;
  p.held = [];
  const done = kept.back();
  await p.held.shift()!.end(); // refused: the counter is 5 there
  assert.deepEqual(p.copy("c_1"), { ...d, base: 5 });
  await p.held.shift()!.end();
  await done;
  assert.deepEqual(p.puts.map((x) => [x.draft, x.base]), [[d, 2], [d, 5]]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 6, draft: d }, null]);
});

test("refused as stale: a draft with text is the later text, kept and saved again on the counter the refusal gave, as an open composer's is", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "typed while away" }, 3);
  p.there.set("c_1:main", { rev: 4, draft: { text: "typed in another window" } }); // changed there meanwhile; this page does not know yet
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => x.base), [3, 4]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 5, draft: { text: "typed while away" } }, null]);
});

test("refused as stale: a draft of quotes alone is saved again too; an emptied one goes, and the server's draft stands", async () => {
  const { p, kept } = page();
  const quotes = { text: "", references: [{ quote: "q", item: 1, start: 0, end: 1 }] };
  p.keep("c_1", quotes, 1); p.keep("c_2", { text: "" }, 1);
  p.there.set("c_1:main", { rev: 2, draft: { text: "theirs" } }); p.there.set("c_2:main", { rev: 2, draft: { text: "theirs" } });
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => [x.chat, x.base]), [["c_1", 1], ["c_1", 2], ["c_2", 1]]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 3, draft: quotes }, null]);
  assert.deepEqual([p.stored("c_2"), p.copy("c_2")], [{ rev: 2, draft: { text: "theirs" } }, null], "the emptied composer's save was refused: what the server has is shown at the next open");
});

// ---- images: a kept draft carries them through every step, and images alone are not "empty"

test("a draft of images alone typed while the page's connection was away is saved when it is back, with its images", async () => {
  const { p, kept } = page();
  const alone = { text: "", images: [img(1), img(2)] };
  p.keep("c_1", alone, 0); p.keep("c_4", { text: "", images: [img(3)] }, 0);
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => [x.chat, x.draft, x.base]), [["c_1", alone, 0], ["c_4", { text: "", images: [img(3)] }, 0]]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 1, draft: alone }, null], "the server has the images, and the copy goes");
  assert.deepEqual([p.stored("c_4"), p.copy("c_4")], [{ rev: 1, draft: { text: "", images: [img(3)] } }, null]);
});

test("refused as stale: a draft of images alone is the user's later draft and is saved again; it is not dropped as an emptied one is", async () => {
  const { p, kept } = page();
  const alone = { text: "", images: [img(1)] };
  p.keep("c_1", alone, 1); p.keep("c_2", { text: "" }, 1);
  p.there.set("c_1:main", { rev: 2, draft: { text: "theirs" } }); p.there.set("c_2:main", { rev: 2, draft: { text: "theirs", images: [img(9)] } });
  p.away = false;
  p.held = [];
  const done = kept.back();
  await p.held.shift()!.end(); // refused: the counter is 2 there
  assert.deepEqual(p.copy("c_1"), { ...alone, base: 2 }, "kept with its images on the counter the refusal gave");
  p.held = null;
  for (const put of p.puts.filter((x) => x.base === 2)) await put.end();
  await done;
  assert.deepEqual(p.puts.map((x) => [x.chat, x.base]), [["c_1", 1], ["c_1", 2], ["c_2", 1]]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 3, draft: alone }, null]);
  assert.deepEqual([p.stored("c_2"), p.copy("c_2")], [{ rev: 2, draft: { text: "theirs", images: [img(9)] } }, null], "the emptied composer's copy goes, and the server's draft stands with its images");
});

test("refused as stale: two drafts are the same only with the same images; one that differs in its images alone is saved again", async () => {
  const { p, kept } = page();
  // the very draft, images and all: the save had been taken and its answer lost
  p.keep("c_1", { text: "abc", images: [img(1), img(2)] }, 3);
  p.there.set("c_1:main", { rev: 4, draft: { text: "abc", images: [img(1), img(2)] } });
  // the same text with other images there (one was removed in another window): the copy is the later draft
  p.keep("c_2", { text: "abc", images: [img(1), img(2)] }, 3);
  p.there.set("c_2:main", { rev: 4, draft: { text: "abc", images: [img(1)] } });
  // the same images under the same text, and the copy has none: also another draft
  p.keep("c_1", { text: "abc" }, 3, "ab12cd34");
  p.there.set("c_1:ab12cd34", { rev: 4, draft: { text: "abc", images: [img(1)] } });
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => [x.chat, x.branch, x.base]), [["c_1", "main", 3], ["c_2", "main", 3], ["c_2", "main", 4], ["c_1", "ab12cd34", 3], ["c_1", "ab12cd34", 4]]);
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 4, draft: { text: "abc", images: [img(1), img(2)] } }, null]);
  assert.deepEqual([p.stored("c_2"), p.copy("c_2")], [{ rev: 5, draft: { text: "abc", images: [img(1), img(2)] } }, null]);
  assert.deepEqual([p.stored("c_1", "ab12cd34"), p.copy("c_1", "ab12cd34")], [{ rev: 5, draft: { text: "abc" } }, null]);
});

test("an emptied composer whose save failed: the kept empty draft is saved, and the server's old text goes", async () => {
  const { p, kept } = page();
  p.there.set("c_1:main", { rev: 2, draft: { text: "deleted here while away" } });
  p.keep("c_1", { text: "" }, 2);
  p.away = false;
  await kept.back();
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 3, draft: null }, null]);
});

test("refused as stale with the very draft: the save had been taken and its answer lost; the copy goes and nothing is saved again", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "abc" }, 3);
  p.there.set("c_1:main", { rev: 4, draft: { text: "abc" } });
  p.away = false;
  await kept.back();
  assert.deepEqual([p.puts.length, p.stored("c_1"), p.copy("c_1")], [1, { rev: 4, draft: { text: "abc" } }, null]);
});

test("a server that refuses again and again is asked a few times at one event; the copy stays on the last counter it gave", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "mine" }, 0);
  p.there.set("c_1:main", { rev: 1, draft: { text: "theirs" } });
  p.away = false;
  p.held = [];
  const done = kept.back();
  for (let i = 0; i < KEPT_TRIES; i++) {
    await tick();
    const put = p.held.shift()!;
    const at = p.stored("c_1");
    p.there.set("c_1:main", { rev: at.rev + 1, draft: { text: "theirs " + i } }); // another page saves just before each of this page's
    await put.end();
  }
  await done;
  assert.deepEqual([p.puts.map((x) => x.base), p.held.length, p.copy("c_1")], [[0, 2, 3], 0, { text: "mine", base: KEPT_TRIES + 1 }]);
  // (a refusal with a lower counter than the one named gives no counter to save on: the copy is left)
  p.keep("c_2", { text: "x" }, 9);
  p.held = null;
  await kept.back();
  assert.deepEqual(p.copy("c_2"), { text: "x", base: 9 });
});

test("still away, or no answer: the copy stays as it was, and is saved the next time the stream opens", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "waits", images: [img(1)] }, 0);
  await kept.back(); // told too early: the server takes no call yet
  assert.deepEqual([p.puts.length, p.taken, p.copy("c_1")], [1, [], { text: "waits", images: [img(1)], base: 0 }]);
  p.away = false;
  await kept.back();
  assert.deepEqual([p.taken, p.copy("c_1"), p.stored("c_1").draft], [["waits"], null, { text: "waits", images: [img(1)] }]);
});

test("a copy typed on another counter than the one known here is left alone: the server's draft is newer, and the composer that opens next drops the copy", async () => {
  const { p, kept } = page();
  p.away = false;
  p.keep("c_4", { text: "older" }, 3);
  p.there.set("c_4:main", { rev: 5, draft: { text: "newer, from another window" } });
  p.known.set("c_4:main", 5); // the snapshot told
  await kept.back();
  assert.deepEqual([p.puts.length, p.stored("c_4").draft, p.copy("c_4")], [0, { text: "newer, from another window" }, { text: "older", base: 3 }]);
  // typed on the counter known here: saved
  p.keep("c_4", { text: "mine" }, 5);
  await kept.back();
  assert.deepEqual([p.puts.map((x) => x.base), p.stored("c_4")], [[5], { rev: 6, draft: { text: "mine" } }]);
  // a copy from before the counter has no base: it is saved on the counter the page's save names (none here)
  p.keep("c_4", { text: "old build" });
  await kept.back();
  assert.equal(p.puts[1].base, undefined);
});

test("a branch whose composer is open is not touched: its own saver has the draft; nor a chat with a pending move", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "open here" }, 0); p.keep("c_1", { text: "another branch" }, 0, "ab12cd34"); p.keep("c_2", { text: "what Back would leave" }, 0);
  p.open.add("c_1:main"); p.moving.add("c_2");
  p.away = false;
  await kept.back();
  assert.deepEqual(p.puts.map((x) => [x.chat, x.branch]), [["c_1", "ab12cd34"]], "the chat's other branch has no composer: its draft is saved");
  assert.deepEqual([p.copy("c_1"), p.copy("c_2")], [{ text: "open here", base: 0 }, { text: "what Back would leave", base: 0 }]);
});

test("the composer opens while the save is on its way: the copy is the composer's from then on, and is neither dropped nor saved again by this", async () => {
  // the save is taken
  let { p, kept } = page();
  p.keep("c_1", { text: "abc" }, 0);
  p.away = false;
  p.held = [];
  let done = kept.back();
  p.open.add("c_1:main");
  p.keep("c_1", { text: "abc and more" }, 0); // typed since, kept by the composer's saver
  await p.held.shift()!.end();
  await done;
  assert.deepEqual([p.stored("c_1").draft, p.copy("c_1")], [{ text: "abc" }, { text: "abc and more", base: 0 }], "what was typed since is still the browser's copy");
  // the save is refused as stale: the composer's saver is the one that saves on the new counter
  ({ p, kept } = page());
  p.keep("c_1", { text: "abc" }, 0);
  p.there.set("c_1:main", { rev: 1, draft: { text: "theirs" } });
  p.away = false;
  p.held = [];
  done = kept.back();
  p.open.add("c_1:main");
  await p.held.shift()!.end();
  await done;
  assert.deepEqual([p.puts.length, p.stored("c_1").draft, p.copy("c_1")], [1, { text: "theirs" }, { text: "abc", base: 0 }]);
});

test("the copy is written again while the save is on its way (the composer was opened, typed in and closed): the newer copy stays, and is saved at the next event", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "abc" }, 0);
  p.away = false;
  p.held = [];
  const done = kept.back();
  p.keep("c_1", { text: "abc, and more" }, 0);
  await p.held.shift()!.end();
  await done;
  assert.deepEqual([p.stored("c_1"), p.copy("c_1")], [{ rev: 1, draft: { text: "abc" } }, { text: "abc, and more", base: 0 }]);
  // the next event saves it: refused on the counter it was typed on (the first save raised it), then taken on the one the refusal gave
  p.held = null;
  await kept.back();
  assert.deepEqual([p.puts.map((x) => x.base), p.stored("c_1"), p.copy("c_1")], [[0, 0, 1], { rev: 2, draft: { text: "abc, and more" } }, null]);
});

test("the chat is deleted while the save is on its way: nothing is kept for it again", async () => {
  const { p, kept } = page();
  p.keep("c_2", { text: "x" }, 4); // (refused as stale: a copy that were still this saver's would be kept on the new counter)
  p.away = false;
  p.held = [];
  const done = kept.back();
  p.chats.delete("c_2"); p.copies.delete(draftKey("c_2", "main"));
  await p.held.shift()!.end();
  await done;
  assert.deepEqual([p.puts.length, p.copy("c_2")], [1, null]);
});

test("the copies are saved one after the other: a save that waits holds one of the page's connections, not one each", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "one" }, 0); p.keep("c_2", { text: "two" }, 0); p.keep("c_1", { text: "three" }, 0, "ab12cd34");
  p.away = false;
  p.held = [];
  const done = kept.back();
  for (const text of ["one", "two", "three"]) {
    await tick();
    assert.deepEqual([p.held.length, p.held[0]?.draft.text], [1, text]);
    await p.held.shift()!.end();
  }
  await done;
  assert.deepEqual(p.taken, ["one", "two", "three"]);
});

test("two events at once save a copy once", async () => {
  const { p, kept } = page();
  p.keep("c_1", { text: "once" }, 0);
  p.away = false;
  p.held = [];
  const both = [kept.back(), kept.back()];
  assert.equal(p.puts.length, 1);
  await p.held.shift()!.end();
  await Promise.all(both);
  assert.deepEqual([p.puts.length, p.taken], [1, ["once"]]);
});

test("DraftBacks tells the kept drafts of a stream's snapshot, and of nothing else; with nothing set it tells nobody", async () => {
  const backs = new DraftBacks();
  backs.sectionBack("s_1"); backs.opened(); backs.snapshot(); // no kept drafts are watched: nothing fails
  const told: unknown[][] = [];
  backs.kept = { back: async (...args: unknown[]) => { told.push(args); } } as unknown as KeptDrafts;
  backs.sectionBack("s_1"); // a section's tree arrived: nothing of that server's chats is kept in the browser
  backs.sectionBack("local");
  backs.opened(); // `hello`: the store is of before the stream; the snapshot that follows tells
  assert.deepEqual(told, []);
  backs.snapshot();
  assert.deepEqual(told, [[]], "once, and with no server named");
});
