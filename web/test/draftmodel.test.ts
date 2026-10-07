// A model check of a chat's draft in two windows: random scripts of typing, Sends, refusals and
// archiving, run with the real DraftSaver under a virtual clock, against a model of the server's
// counter rule and of what Composer.tsx does around its saver (the rules it asks the logic for
// are the real ones: boxText, staleTaken, putsBack). Three families: a local chat, a chat archived
// during a Send, and the held first Send of a chat on another server.
//
// DRAFT_MODEL_SCRIPTS sets the scripts per family and prints the classes they ended in; the
// default is what runs in a few seconds. DRAFT_MODEL_SEEDS=1 prints the first scripts of each
// class with them, DRAFT_MODEL_OLD=back,box,stale,answer,together runs the composer as it was, and
// DRAFT_MODEL_TRACE=family:seed prints what one script did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftSaver, answerNewer, boxText, hasDraft, staleOf, staleTaken, unsavedToShow, type Unsaved } from "../src/logic/drafts.ts";
import { putsBack } from "../src/logic/sendend.ts";
import type { Draft } from "../src/types.ts";

type Family = "local" | "archive" | "remote";
/** The composer as it was before a fix, to see that the model finds the fault: back puts a failed
 *  Send's message back whatever the saver tells (D1), box leaves the box empty when there is no
 *  draft to show (D3), stale takes a stale answer whatever its counter (D3), answer gives the
 *  record a save's counter without its draft. together is no fault
 *  of the composer's: the events of one moment reach the saver as one (see stored). */
type Old = { back?: boolean; box?: boolean; stale?: boolean; answer?: boolean; together?: boolean };
type Ev = { rev?: number; draft?: Draft | null; archived?: boolean; started?: boolean };
type Plan = { how: "ok" | "refuse" | "fail" | "lost"; lock: boolean; wait: number; dur: number }; // wait: how long the request is on its way; dur: how long the Send runs

const turn = () => new Promise<void>((r) => setImmediate(r)); // every promise that can go on has gone on

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock that moves only when run: the timers of the saver and of the model are its own. */
function clock() {
  let now = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const set = (fn: () => void, ms = 0) => { q.set(++seq, { at: now + Math.max(0, ms || 0), fn }); return seq; };
  const clear = (id?: number) => { if (id !== undefined) q.delete(id); };
  const next = () => {
    let best: number | undefined;
    for (const [id, t] of q) if (best === undefined || t.at < q.get(best)!.at) best = id; // the earliest, and of those the first set
    return best;
  };
  const run = async (until: number) => {
    for (;;) {
      const id = next();
      if (id === undefined || q.get(id)!.at > until) break;
      const t = q.get(id)!;
      q.delete(id);
      now = t.at;
      t.fn();
      await turn();
    }
    now = Math.max(now, until);
  };
  return { set, clear, run, now: () => now, waiting: () => q.size };
}

/** One script: what it ended in, as classes (none: every window and the server agree, and no
 *  sent text is a draft). */
async function script(family: Family, seed: number, old: Old = {}, trace?: string[]): Promise<string[]> {
  const rnd = rng(seed * 3 + ["local", "archive", "remote"].indexOf(family));
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chance = (p: number) => rnd() < p;
  const c = clock();
  const say = (...a: unknown[]) => { trace?.push(`${String(c.now()).padStart(6)} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`); };
  const sleep = (ms: number) => new Promise<void>((r) => { c.set(r, ms); });
  const lag = () => (chance(0.2) ? int(20, 120) : int(0, 15));
  const initial: Draft | null = chance(0.6) ? { text: "t0" } : null;
  const srv = { rev: int(0, 3), draft: initial, archived: false, started: false, starting: false, lock: null as Promise<void> | null };
  const saves: { w: number; text: string; at: number; ok: boolean }[] = [];
  const takes: { w: number; text: string; at: number; held: boolean; dropped?: number; was?: string }[] = []; // dropped: the counter on which that Send removed the draft, which was `was`
  // from: when the Send it ends began; taken: that Send was taken; heard: the last counter the window had heard of, and heard0 the one as the Send began
  const backs: { w: number; text: string; from: number; at: number; taken: boolean; heard: number; heard0: number }[] = [];
  const typed: { w: number; text: string; at: number }[] = [];
  const sends: { w: number; from: number; to: number }[] = [];
  const wins: ReturnType<typeof open>[] = [];

  // ---- the server
  const emit = (ev: Ev) => {
    for (const w of wins) {
      w.evAt = Math.max(w.evAt, c.now() + lag()); // one stream per window: its events come in their order
      c.set(() => w.event(ev), w.evAt - c.now());
    }
  };
  const refusal = (status: number, code: string) => Object.assign(new Error(code), { status, code });
  const save = async (w: number, d: Draft, base?: number) => {
    while (srv.lock) await srv.lock;
    const ok = base === srv.rev;
    saves.push({ w, text: d.text, at: c.now(), ok });
    say(`w${w} save`, d.text, `@${base}`, ok ? "ok" : `stale ${srv.rev} ${srv.draft?.text ?? null}`);
    if (!ok) throw Object.assign(refusal(409, "stale"), { rev: srv.rev, draft: srv.draft });
    if (!hasDraft(d) && !srv.draft) return srv.rev; // an empty save over no draft counts nothing
    srv.rev++; srv.draft = hasDraft(d) ? d : null;
    emit({ rev: srv.rev, draft: srv.draft });
    return srv.rev;
  };
  const send = async (w: number, text: string, held: boolean, plan: Plan, did: { taken: boolean }) => {
    await sleep(plan.wait);
    if (srv.archived) throw refusal(409, "archived");
    if (family === "remote" && !srv.started) {
      // The creation call on the chat's server: one at a time. Taken, the chat is swapped for the started one, whose draft counter is the one at
      // the hand-over plus one, with no draft.
      if (srv.starting) throw refusal(409, "busy");
      if (plan.how === "refuse") throw refusal(409, "refused");
      srv.starting = true;
      await sleep(plan.dur);
      srv.starting = false;
      if (plan.how === "fail") throw refusal(503, "server_unreachable");
      const was = srv.draft?.text;
      srv.rev++; srv.draft = null; srv.started = true;
      takes.push({ w, text, at: c.now(), held, dropped: srv.rev, was });
      did.taken = true;
      say(`w${w} started with`, text);
      emit({ rev: srv.rev, draft: null, started: true });
      if (plan.how === "lost") throw refusal(504, "start_unconfirmed");
      return;
    }
    if (plan.how === "refuse") throw refusal(409, "refused");
    if (plan.how === "fail") { await sleep(plan.dur); throw refusal(502, "down"); }
    while (srv.lock) await srv.lock;
    // The message is taken: the Send reads the draft's counter, and at its end drops the draft only on that counter. An ordinary chat's Send holds
    // the chat's lock meanwhile, and a save waits for it; a fork's first message does not.
    const at = srv.rev;
    let free = () => {};
    if (plan.lock) srv.lock = new Promise<void>((r) => { free = r; });
    const take: (typeof takes)[number] = { w, text, at: c.now(), held };
    takes.push(take);
    did.taken = true;
    say(`w${w} taken`, text);
    await sleep(plan.dur);
    if (srv.draft && srv.rev === at) { take.was = srv.draft.text; srv.rev++; srv.draft = null; take.dropped = srv.rev; emit({ rev: srv.rev, draft: null }); }
    if (plan.lock) { srv.lock = null; free(); }
    if (plan.how === "lost") throw refusal(502, "down"); // taken, and the answer never came
  };
  /** A request: the way there, the server, the way back. */
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    await sleep(lag());
    let out: T;
    try { out = await f(); } catch (e) { await sleep(lag()); throw e; }
    await sleep(lag());
    return out;
  };

  // ---- a window: the store's record of the branch, the composer and its saver
  function open(i: number) {
    const local: { d: Draft | null; base?: number } = { d: null };
    const unsaved: Unsaved = { read: () => local.d, base: () => local.base, write: (d, b) => { local.d = d; local.base = d ? b : undefined; } };
    const text = initial?.text ?? "";
    const w = {
      i, local, text, given: text, box: text as string | null, // box: what the box shows, null while none is drawn (an archived chat)
      store: { rev: srv.rev, draft: initial, started: false }, effRev: srv.rev,
      archived: false, appeared: false, sending: false, wake: false, dirty: false, evAt: 0, heard: srv.rev,
      s: null as unknown as DraftSaver,
      /** What React runs after a render. The store is read through useSyncExternalStore: a change of it is rendered, and its effects run, before
       *  anything else happens (stored: the box that appeared gets its text, and the saver gets a changed counter with the record's draft). A text
       *  set from the continuation of a request is rendered a little later (told: the saver gets the changed text). With `together` the two run as
       *  one, a moment later: several events are then one render, as after a stream that came back. */
      stored() {
        w.wake = false;
        if (w.appeared) {
          w.appeared = false;
          const d = unsavedToShow(unsaved, w.store.rev) ?? w.store.draft;
          const t = old.box ? (hasDraft(d) ? d.text : null) : boxText(d, w.text);
          if (t !== null) w.input(t);
        }
        if (w.store.rev !== w.effRev) { w.effRev = w.store.rev; say(`w${i} arrived`, w.store.rev, w.store.draft?.text ?? null); w.s.arrived(w.store.rev, w.store.draft); }
      },
      told() {
        w.dirty = false;
        if (w.text !== w.given) { w.given = w.text; say(`w${i} change`, w.text); w.s.change(w.text); }
      },
      render() {
        if (w.wake) return;
        w.wake = true;
        if (old.together) c.set(() => { if (w.wake) w.stored(); }, 0);
        else queueMicrotask(() => { if (w.wake) w.stored(); });
      },
      later() { if (!w.dirty) { w.dirty = true; c.set(() => { if (w.dirty) w.told(); }, 0); } },
      /** Effects run before the next thing the user does. */
      settle() { for (let k = 0; (w.wake || w.dirty) && k < 10; k++) { if (w.wake) w.stored(); if (w.dirty) w.told(); } },
      input(t: string) { w.box = t; w.text = t; w.later(); }, // RefInput.set, and typing: the box, and by onChange what the composer holds
      setBox(t: string) { if (w.box !== null) w.input(t); else { w.text = t; w.later(); } },
      event(ev: Ev) {
        say(`w${i} event`, ev);
        if (ev.rev !== undefined) { w.store.rev = ev.rev; w.store.draft = ev.draft ?? null; w.heard = Math.max(w.heard, ev.rev); }
        if (ev.started) w.store.started = true;
        if (ev.archived !== undefined && ev.archived !== w.archived) {
          w.archived = ev.archived;
          w.box = ev.archived ? null : ""; // the box is drawn anew, empty
          w.appeared = !ev.archived;
        }
        w.render();
      },
      type(t: string) {
        w.settle();
        if (w.box === null) return;
        typed.push({ w: i, text: t, at: c.now() });
        say(`w${i} types`, t);
        w.input(t);
      },
      /** Composer's submit. */
      async submit(plan: Plan) {
        w.settle();
        const t = w.text.trim();
        if (!t || w.box === null || w.sending) return;
        w.sending = true;
        say(`w${i} sends`, t, plan);
        const first = family === "remote" && !w.store.started;
        const span = { w: i, from: c.now(), to: Infinity }, heard0 = w.heard;
        sends.push(span);
        let answered: ((refused?: boolean) => boolean) | null = null;
        let refused = false;
        const did = { taken: false };
        try {
          answered = w.s.sending(undefined, first);
          w.input("");
          await call(() => send(i, t, first, plan, did));
        } catch (e: any) {
          refused = e.status < 500;
          const removed = answered?.(refused) ?? false;
          say(`w${i} send failed`, e.code, removed ? "removed" : "");
          answered = null;
          if (old.back || putsBack(removed, e.code)) {
            if (!w.text.trim()) { backs.push({ w: i, text: t, from: span.from, at: c.now(), taken: did.taken, heard: w.heard, heard0 }); w.setBox(t); } // into the box, or what the composer holds when none is drawn
          }
        } finally {
          answered?.(refused);
          w.sending = false;
          span.to = c.now();
        }
      },
    };
    /** Composer's saveDraft: the record gets the draft at once, the counter with the answer, and what a stale answer tells. */
    const put = async (d: Draft, _keepalive: boolean, base?: number) => {
      w.store.draft = hasDraft(d) ? d : null;
      try {
        const rev = await call(() => save(i, d, base));
        w.heard = Math.max(w.heard, rev);
        if (old.answer ? rev > w.store.rev : answerNewer(rev, w.store.rev)) {
          if (!old.answer) w.store.draft = hasDraft(d) ? d : null; // the counter comes with the draft it counts
          w.store.rev = rev;
          w.render();
        }
        return rev;
      } catch (e) {
        const stale = staleOf(e);
        if (stale) w.heard = Math.max(w.heard, stale.rev);
        if (stale && (old.stale || staleTaken(stale.rev, w.store.rev))) {
          w.store.draft = hasDraft(stale.draft) ? stale.draft : null;
          if (stale.rev > w.store.rev) w.store.rev = stale.rev;
          w.render();
        }
        throw e;
      }
    };
    w.s = new DraftSaver(put, initial ?? undefined, unsaved, undefined, srv.rev, (d) => { say(`w${i} shows`, d.text); w.setBox(d.text); });
    return w;
  }

  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  globalThis.setTimeout = c.set as unknown as typeof setTimeout;
  globalThis.clearTimeout = c.clear as unknown as typeof clearTimeout;
  try {
    wins.push(open(0), open(1));
    let n = 0;
    const gap = () => (chance(0.5) ? int(0, 12) : chance(0.6) ? int(12, 450) : int(450, 2500));
    const plan = (): Plan => {
      const p = rnd();
      return { how: p < 0.5 ? "ok" : p < 0.75 ? "refuse" : p < 0.88 ? "fail" : "lost", lock: chance(0.7), wait: chance(0.6) ? 0 : int(0, 900), dur: chance(0.5) ? int(0, 20) : chance(0.6) ? int(20, 200) : int(200, 1500) };
    };
    const archive = (on: boolean) => { say(on ? "archive" : "unarchive"); srv.archived = on; emit({ archived: on }); };
    for (let k = int(3, 9); k > 0; k--) {
      await c.run(c.now() + gap());
      const w = wins[int(0, 1)], p = rnd();
      if (family === "archive" && p < 0.2) archive(!srv.archived);
      else if (p < 0.5) void w.submit(plan());
      else if (p < 0.6) w.type("");
      else w.type(`t${++n}`);
      await turn();
    }
    if (srv.archived) { await c.run(c.now() + gap()); archive(false); await turn(); }
    const last = c.now();
    say("last action");
    await c.run(last + 30_000);

    say("end", { server: [srv.rev, srv.draft?.text ?? null], texts: wins.map((w) => w.text), boxes: wins.map((w) => w.box), unsaved: wins.map((w) => w.local.d) });
    // ---- what it ended in
    const out: string[] = [];
    const quiet = Math.max(last, ...sends.map((s) => s.to)); // the last thing a user did, and the last answer of a Send
    const after = saves.filter((s) => s.at > quiet).length;
    if (c.waiting()) out.push("loop");
    if (after > 4) out.push("saves>4");
    if (wins.some((w) => w.box !== w.text)) out.push(D3);
    const end = srv.draft?.text ?? "", texts = wins.map((w) => w.text);
    const back = [end, ...texts].find((t) => t && takes.some((k) => k.text === t));
    if (texts.some((t) => t !== end) || wins.some((w) => w.local.d)) out.push(back ? "diverged, a sent text being a draft again" : "diverged");
    if (back) {
      const mine = takes.filter((k) => k.text === back), b = backs.filter((x) => x.text === back).at(-1); // the last time it was put back: what left it there
      // the other window's Sends of it that this Send can have crossed: taken while it ran, or before it with a removal not heard of as it began
      const theirs = b ? mine.filter((k) => k.w !== b.w && k.at <= b.at && (k.at >= b.from || (k.dropped !== undefined && k.dropped > b.heard0))) : [];
      if (b && !b.taken && !theirs.length && !mine.some((k) => k.at > b.at)) {} // sent again after it had been put back, and that Send was not taken: the draft it is
      else if (b?.taken) out.push(OWN);
      else if (b && theirs.some((k) => k.dropped !== undefined && k.was === back && k.dropped <= b.heard)) out.push(D1); // (it removed that very draft)
      else if (theirs.length) out.push(HIDDEN);
      else if (mine.some((k) => k.held && !backs.some((x) => x.text === back && x.w === k.w) && saves.some((x) => x.ok && x.text === back && x.w === k.w && x.at >= k.at))) out.push(D2);
      else out.push(OTHER);
    }
    // The text typed last, with no message taken since, is the draft at the end, unless something else went on close to it.
    const t = typed.at(-1);
    if (t && t.text && !takes.some((k) => k.at >= t.at) && end !== t.text) {
      const near = sends.some((s) => s.from <= t.at + 3000 && s.to + 3000 >= t.at) || typed.some((o) => o !== t && Math.abs(o.at - t.at) < 3000);
      out.push(near ? "text typed last is not the draft, a Send or other typing being close" : "text typed last is not the draft, nothing being close");
    }
    return out;
  } finally {
    globalThis.setTimeout = real.set;
    globalThis.clearTimeout = real.clear;
  }
}

async function family(f: Family, count: number, old: Old = {}): Promise<Record<string, number>> {
  const classes: Record<string, number> = {};
  for (let seed = 1; seed <= count; seed++) {
    for (const k of await script(f, seed, old)) {
      classes[k] = (classes[k] ?? 0) + 1;
      if (process.env.DRAFT_MODEL_SEEDS && (seeds[`${f} ${k}`] ??= []).length < 4) seeds[`${f} ${k}`].push(`${f}:${seed}`);
    }
  }
  return classes;
}

const seeds: Record<string, string[]> = {}; // DRAFT_MODEL_SEEDS: the first scripts of each class, to trace
const OLD: Old = Object.fromEntries((process.env.DRAFT_MODEL_OLD ?? "").split(",").filter(Boolean).map((k) => [k, true]));
const COUNT = Number(process.env.DRAFT_MODEL_SCRIPTS) || 1000;
// A sent text that is a draft at the end:
const D1 = "put back after the other window sent it, the removal of the draft having come (D1)";
const HIDDEN = "put back after the other window sent it, the removal being unknown here";
const OWN = "put back after this window's own Send, taken with no answer";
const D2 = "a held Send's text saved again with nothing put back (D2)";
const OTHER = "a draft again otherwise";
const D3 = "box≠state (D3)";
const NEVER = ["loop", "saves>4", "diverged", D1, D2, D3, "text typed last is not the draft, nothing being close"];

for (const f of ["local", "archive", "remote"] as const) {
  test(`model: ${COUNT} random scripts of two windows on a draft, ${f}: no loop, no window left apart, no sent draft put back`, async () => {
    const classes = await family(f, COUNT, OLD);
    if (process.env.DRAFT_MODEL_SCRIPTS) console.log(`model ${f} (${COUNT}):`, JSON.stringify(classes), process.env.DRAFT_MODEL_SEEDS ? JSON.stringify(seeds) : "");
    for (const k of NEVER) assert.equal(classes[k] ?? 0, 0, `${k}: ${JSON.stringify(classes)}`);
  });
}

test("model: it finds the faults of the composer as it was (D1, D3, a save's counter without its draft)", async () => {
  const n = 1500;
  assert.ok(((await family("local", n, { back: true }))[D1] ?? 0) > 0, "D1");
  assert.ok(((await family("archive", n, { box: true, stale: true }))[D3] ?? 0) > 0, "D3");
  assert.ok(((await family("local", n, { answer: true })).diverged ?? 0) > 0, "a save's counter without its draft");
});

if (process.env.DRAFT_MODEL_TRACE) {
  const [f, seed] = process.env.DRAFT_MODEL_TRACE.split(":");
  test(`model: trace of ${f} ${seed}`, async () => {
    const trace: string[] = [];
    const classes = await script(f as Family, Number(seed), OLD, trace);
    console.log(trace.join("\n"), "\n", classes);
  });
}
