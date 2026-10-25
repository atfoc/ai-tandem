// SI.2b (new, small-improvements package d1): the delay before send in Speech mode, on the mock with the stand-in voice service (dev/voicestandin.mjs; its
// transcripts are scripted, no ElevenLabs) and the checks' microphone (mic.mjs), at the desktop, the tablet and the phone. Small-improvements goal 3.2 (the
// countdown bar and the seconds count the chosen delay at any value in range), 6.2 (third and fourth bullets). The words are one `committed` transcript with
// no guess before it, so the turn machine is quiet the moment they arrive: the countdown starts at once, `session.countdown = { startedAt, ms }` (the engine's
// own clock and the delay it was given), and the message goes when it ends. A turn is sent after the delay chosen, at 0.1 s, 1.2 s and 10 s:
//   the delay       `sent - startedAt` (sent: the page's clock at the message call, the mock's `POST …/messages`, which the page's `fetch` is patched to stamp;
//                   startedAt: the engine's) is the chosen delay `ms`, within the margin MARGIN below, and `ms` is the setting
//   the countdown   the bar (`speech-countdown`, its `data-left` and its text: "N.N s" beside the bar, or the phone's state word "Sending in N s") is drawn from
//                   about the start to about the send: it begins at the delay (10 s: "10.0 s", "Sending in 10 s"), goes down and ends near 0 (the last "Sending in
//                   1 s"), every sample's seconds are the time that is left on the engine's clock, its filled part is the share of the delay gone, and it is there for the
//                   delay (at 0.1 s it is there for no longer than that and a render; one sample may miss it, so it is not required there)
//   one value       the value set in Settings > Voice (the slider's keys, 3.4 s) is the one the Speech bar's countdown, and the board's pill (the card on the phone)
//                   count, and the turn goes at that time
// The margin: a message goes at or after the delay (a timer fires after its time, never before), so the least is the delay less 50 ms (the clock's rounding
// between the page's two reads), and the most is the delay plus 600 ms, which is a machine that runs four times slower than the one this was written on
// (there the send follows the deadline within 30 ms; other checks of this folder allow a render's 100 to 300 ms). The countdown's samples are taken every 10 ms
// in the page; a sample's seconds may be as stale as the bar's own 50 ms timer and a frame, so they may differ from the engine's clock by 300 ms.
// OUT=/tmp/x keeps a screenshot of the bar at each delay (SI.2b-<viewport>-<delay>.png).
export const limit = 600;
import fs from "node:fs";
import path from "node:path";
import { check, mockEval, seed, until } from "../shot.mjs";
import { useMic } from "./mic.mjs";
import { byTid, openBoard, openChat, press, tidSel } from "./sel.mjs";
import { pauseOf, setPause } from "./slider.mjs";
import { atRest } from "./settings.mjs";
import { stackNames, openVoice } from "./voicephone.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_SI2BCANARY1";
const J = JSON.stringify;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const SAID = "what is the plan";
const MSG = /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages(\?|$)/;
/** At or after the delay, less the clock's rounding; and at most this much after it (a machine four times slower than the writer's). */
const MARGIN = { early: 50, late: 600 };
/** The seconds a sample says against the engine's clock; the filled share against the share of the delay gone. */
const STALE = { left: 0.3, frac: 0.15 };

await check("SI.2b the delay before send in Speech mode: a spoken turn goes after 0.1 s, 1.2 s and 10 s; the countdown bar and its seconds count the same time; Settings, the bar and the pill share the value", async ({ url, viewport, layout, open, fail, note }) => {
  const wide = layout !== "phone";
  const settingsOf = (pauseMs) => J({ autoSend: true, pauseMs });
  const script = (steps) => mockEval(`voice.script(${J(steps)}); return 1;`, url);
  const reply = (t = "Okay. Done.") => mockEval(`flags.reply = { text: ${J(t)}, parts: 2, pace: 100 }; return 1;`, url);
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const dialog = (p) => byTid(p, "settings-dialog");
  const shown = (loc, ms = 15000) => until(() => loc.first().isVisible().catch(() => false), ms);

  /** The surfaces that count down, by what they draw: the testID that holds `data-left`, the one whose text says the seconds, the filled share. */
  const SURFACE = {
    bar: wide ? { cd: "speech-countdown", text: "speech-countdown", frac: { bar: "speech-countdown-bar" } }
      : { cd: "speech-countdown", text: "speech-state", frac: { bar: "speech-countdown-bar" } },
    pill: wide ? { cd: "pill-countdown", text: "pill-countdown", frac: { attr: ["pill-countdown-ring", "data-frac"] } }
      : { cd: "voice-card-state", text: "voice-card-state", frac: { attr: ["voice-card-countdown", "data-frac"] } },
  };

  /** In the page: from now on, every 10 ms, what the countdown draws (seconds left, its text, its filled share, the engine's own countdown), and the
   *  time of each message call (a stamp on `fetch`, so that the two ends of the delay are read on the clock the engine reads). */
  const record = (p, surface) => p.evaluate(({ s, MSG }) => {
    const r = (window.__si = { samples: [], engine: [], sent: [] });
    const f = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = new URL(typeof input === "string" ? input : input.url, location.href), path = u.searchParams.get("path") ?? "", method = (u.searchParams.get("method") ?? init?.method ?? "").toUpperCase();
        if (u.pathname === "/host/call" && method === "POST" && new RegExp(MSG).test(path)) r.sent.push(Date.now());
      } catch { /* not a call */ }
      return f.apply(this, arguments);
    };
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    clearInterval(window.__siTimer);
    window.__siTimer = setInterval(() => {
      const now = Date.now(), c = window.__aiwbVoice.state().session.countdown;
      if (c && (!r.engine.length || r.engine.at(-1).startedAt !== c.startedAt)) r.engine.push({ startedAt: c.startedAt, ms: c.ms, seen: now });
      const el = q(s.cd);
      if (!el || el.getAttribute("data-left") === null || el.getAttribute("data-left") === "") { r.samples.push({ now, on: false }); return; }
      let frac = null;
      if (s.frac.bar) { const b = q(s.frac.bar), w = b?.parentElement?.getBoundingClientRect().width; frac = b && w ? b.getBoundingClientRect().width / w : null; }
      else { const a = q(s.frac.attr[0]); frac = a ? Number(a.getAttribute(s.frac.attr[1])) / 100 : null; } // (data-frac is a whole percent)
      r.samples.push({ now, on: true, left: Number(el.getAttribute("data-left")), text: (q(s.text)?.innerText ?? "").replace(/\s+/g, " ").replace(/Cancel/, "").trim(), frac });
    }, 10);
  }, { s: SURFACE[surface], MSG: MSG.source });
  const recorded = (p) => p.evaluate(() => { clearInterval(window.__siTimer); return window.__si; });

  /** The page's clock read against what happened: judges one turn at the delay `ms`. `where`: what draws the countdown. */
  const judge = (m, ms, tag, { required = ms >= 1000 } = {}) => {
    const first = m.engine[0], sent = m.sent[0];
    if (!first) return fail(`${tag}: the engine never started a countdown (session.countdown stayed null)`);
    if (first.ms !== ms) fail(`${tag}: the countdown the engine started is ${first.ms} ms, not the delay ${ms} ms`);
    if (m.engine.length !== 1) fail(`${tag}: the countdown started ${m.engine.length} times (the words came once)`);
    if (sent === undefined) return fail(`${tag}: the turn was never sent`);
    const delay = sent - first.startedAt;
    if (m.sent.length !== 1) fail(`${tag}: ${m.sent.length} messages were sent for one spoken turn`);
    if (delay < ms - MARGIN.early || delay > ms + MARGIN.late) fail(`${tag}: the message went ${delay} ms after the words, not ${ms} ms (−${MARGIN.early} ms … +${MARGIN.late} ms)`);
    const on = m.samples.filter((s) => s.on);
    if (!on.length) {
      if (required) fail(`${tag}: the countdown was never drawn`);
      return { delay, drawn: 0 };
    }
    const t0 = on[0].now, t1 = on.at(-1).now;
    const drawn = t1 - t0;
    if (t0 < first.startedAt - 30) fail(`${tag}: the countdown was drawn ${first.startedAt - t0} ms before the engine started it`);
    if (required) {
      if (t0 - first.startedAt > 500) fail(`${tag}: the countdown was drawn only ${t0 - first.startedAt} ms after it began`);
      if (drawn < ms - 500 || drawn > ms + MARGIN.late) fail(`${tag}: the countdown was drawn for ${drawn} ms, not about ${ms} ms`);
      if (t1 > sent + 300) fail(`${tag}: the countdown was still drawn ${t1 - sent} ms after the message went`);
    } else if (drawn > ms + MARGIN.late) fail(`${tag}: the countdown was drawn for ${drawn} ms at a delay of ${ms} ms`);
    // the seconds: a sample's are the time left on the engine's clock; they only go down; they start at the delay and end near 0
    let prev = Infinity;
    for (const s of on) {
      const want = (first.startedAt + ms - s.now) / 1000;
      if (Math.abs(s.left - want) > STALE.left) { fail(`${tag}: at ${s.now - first.startedAt} ms the bar says ${s.left} s left, the clock ${want.toFixed(2)} s`); break; }
      if (s.left > prev + 1e-9) { fail(`${tag}: the seconds went up, ${prev} then ${s.left}`); break; }
      prev = s.left;
      if (s.frac !== null && ms >= 1000 && s.now - first.startedAt >= 300 && Math.abs(s.frac - (s.now - first.startedAt) / ms) > STALE.frac && s.now - first.startedAt <= ms) { fail(`${tag}: at ${s.now - first.startedAt} ms of ${ms} the bar is ${(s.frac * 100).toFixed(0)}% filled, not about ${(((s.now - first.startedAt) / ms) * 100).toFixed(0)}%`); break; }
    }
    if (required) {
      const top = ms / 1000;
      if (on[0].left < top - 0.6 || on[0].left > top + 1e-9) fail(`${tag}: the countdown begins at ${on[0].left} s, not at ${top} s`);
      if (on.at(-1).left > 0.8 && ms >= 1000) fail(`${tag}: the countdown ends at ${on.at(-1).left} s left, not near 0`);
      const texts = [...new Set(on.map((s) => s.text))];
      const nums = texts.map((t) => (wide ? Number((t.match(/(\d+\.\d) s/) ?? [])[1]) : Number((t.match(/^Sending in (\d+) s$/) ?? [])[1])));
      if (nums.some((n) => !Number.isFinite(n))) fail(`${tag}: the countdown's words are not "N s": ${J(texts.slice(0, 5))}`);
      else {
        if (!wide && nums[0] !== Math.ceil(top)) fail(`${tag}: the first word is ${J(texts[0])}, not "Sending in ${Math.ceil(top)} s"`);
        if (wide && Math.abs(nums[0] - top) > 0.6) fail(`${tag}: the first text is ${J(texts[0])}, not about ${top.toFixed(1)} s`);
        if (nums.some((n, i) => i && n > nums[i - 1] + 1e-9)) fail(`${tag}: the words went up: ${J(texts.slice(0, 12))}`);
        if (!wide && nums.some((n, i) => i && nums[i - 1] - n > 1)) fail(`${tag}: a second was skipped in the words: ${J(texts)}`);
        if (!wide && nums.at(-1) > 1) fail(`${tag}: the last word is ${J(texts.at(-1))}, not "Sending in 1 s"`);
      }
      if (ms >= 10000 && on.some((s) => s.frac !== null) && on.find((s) => s.now - first.startedAt >= ms / 2)?.frac !== undefined) {
        const mid = on.find((s) => s.now - first.startedAt >= ms / 2);
        if (mid.frac !== null && (mid.frac < 0.35 || mid.frac > 0.65)) fail(`${tag}: half way through ${ms / 1000} s the bar is ${(mid.frac * 100).toFixed(0)}% filled`);
      }
    }
    return { delay, drawn, first: on[0].text, last: on.at(-1).text, texts: new Set(on.map((s) => s.text)).size };
  };

  const pressSpeech = async (p) => {
    let last = "";
    for (let i = 0; wide && i < 40; i++) { // (a page just opened is still measuring its toolbar: wait for a place that stays)
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, "voice-speech").count()) { await press(p, byTid(p, "voice-speech")); return; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, "more-speech").count(), 5000)) throw new Error("Speech mode is neither in the row nor in the \"more\" popup");
    await press(p, byTid(p, "more-speech"));
  };
  const world = async (seedName) => {
    await mockEval("delete flags.send; delete flags.reply; voice.reset(); return 1;", url);
    await seed(url, seedName);
  };
  const keyAndMic = async (p) => {
    await useMic(p, note);
    await p.waitForFunction(() => !!window.__aiwbVoice?.setKey, null, { timeout: 30000 });
    await p.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
  };
  const shot = async (p, name) => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await p.screenshot({ path: path.join(OUT, `SI.2b-${viewport}-${name}.png`) });
  };

  /** A spoken turn in Speech mode on the plain chat with the delay `ms` saved: the measures. */
  const turn = async (ms) => {
    await world("UXV1");
    const o = await open({ sel: { chat: "c_UXV1_plain" }, wait: tidSel("composer"), ls: { "aiwb.voice.settings": settingsOf(ms) } });
    const p = o.page, tag = `the bar at ${ms / 1000} s`;
    try {
      await keyAndMic(p);
      if ((await p.evaluate(() => window.__aiwbVoice.settings().pauseMs)) !== ms) fail(`${tag}: the voice setting is not ${ms}`);
      await script([{ after: 3, committed: SAID }]);
      await reply();
      await record(p, "bar");
      await pressSpeech(p);
      if (!await until(async () => (await sess(p)).phase !== "idle", 20000)) throw new Error(`${tag}: speech mode never started (${J(await sess(p))})`);
      // the turn: the words, the countdown (at 0.1 s one may not see it), the message
      if (!await until(async () => (await p.evaluate(() => window.__si.sent.length)) > 0, ms + 40000)) throw new Error(`${tag}: the turn was not sent in ${(ms + 40000) / 1000} s`);
      return judge(await recorded(p), ms, tag);
    } finally { await o.ctx.close().catch(() => {}); }
  };

  const results = [];
  for (const ms of [100, 1200, 10000]) {
    try {
      const r = await turn(ms);
      if (r) results.push(`${ms / 1000} s: sent ${r.delay} ms after the words, countdown drawn ${r.drawn} ms${r.first ? ` ("${r.first}" … "${r.last}", ${r.texts} different texts)` : ""}`);
    } catch (e) { fail(String(e.message ?? e).split("\n")[0]); }
  }
  for (const line of results) note(line);

  // ---- a screenshot of the bar counting a long delay, for a person's look
  if (OUT) {
    await world("UXV1");
    const o = await open({ sel: { chat: "c_UXV1_plain" }, wait: tidSel("composer"), ls: { "aiwb.voice.settings": settingsOf(10000) } });
    try {
      await keyAndMic(o.page);
      await script([{ after: 3, committed: SAID }]);
      await reply();
      await pressSpeech(o.page);
      if (await until(async () => (await byTid(o.page, "speech-countdown").count()) > 0, 20000)) { await sleep(2500); await shot(o.page, "10s-countdown"); }
    } finally { await o.ctx.close().catch(() => {}); }
  }

  // ---- one value: set in Settings > Voice with the slider, counted by the Speech bar and by the board's pill
  const SET = 3400;
  const viaSettings = async (ls = {}) => {
    const o = await open({ ls: { "aiwb.voice.settings": settingsOf(1200), ...ls }, wait: tidSel("app-root") });
    const p = o.page;
    await keyAndMic(p);
    if (wide) {
      await press(p, byTid(p, "settings-btn").first());
      if (!await shown(dialog(p))) throw new Error("the Settings button opened no dialog");
      if (!await byTid(p, "vs-advanced-body").count()) await press(p, byTid(p, "vs-advanced"));
      await atRest(p, "vs-adv-pause");
      await setPause(p, SET);
      await until(async () => (await pauseOf(p)) === SET);
      await press(p, byTid(p, "vs-close"));
      await until(async () => (await dialog(p).count()) === 0);
    } else {
      await openVoice(p);
      await atRest(p, "vs-adv-pause");
      await setPause(p, SET);
      await until(async () => (await pauseOf(p)) === SET);
      for (let i = 0; i < 4 && (await stackNames(p)).at(-1) !== "settings"; i++) await press(p, byTid(p, "nav-back").last());
    }
    if ((await p.evaluate(() => window.__aiwbVoice.settings().pauseMs)) !== SET) fail(`Settings set ${await p.evaluate(() => window.__aiwbVoice.settings().pauseMs)}, not ${SET}`);
    return o;
  };
  {
    await world("UXV1");
    const o = await viaSettings();
    const p = o.page, tag = `the bar after ${SET / 1000} s was set in Settings`;
    try {
      await openChat(p, "c_UXV1_plain");
      await script([{ after: 3, committed: SAID }]);
      await reply();
      await record(p, "bar");
      await pressSpeech(p);
      if (!await until(async () => (await p.evaluate(() => window.__si.sent.length)) > 0, 60000)) throw new Error(`${tag}: the turn was not sent`);
      const r = judge(await recorded(p), SET, tag);
      note(`${tag}: sent ${r?.delay} ms after the words, drawn ${r?.drawn} ms, "${r?.first}" … "${r?.last}"`);
    } catch (e) { fail(String(e.message ?? e).split("\n")[0]); }
    await o.ctx.close().catch(() => {});
  }
  {
    await world("A2");
    const o = await viaSettings();
    const p = o.page, tag = `the ${wide ? "pill" : "card"} after ${SET / 1000} s was set in Settings`;
    try {
      await openBoard(p, "b_ui");
      const orb = wide ? "pill-orb" : "voice-orb";
      if (!await shown(byTid(p, orb), 20000)) throw new Error(`${tag}: the board shows no ${orb}`);
      await script([{ after: 3, committed: "draw a red box" }]);
      await reply("Sure. I drew it.");
      await record(p, "pill");
      await press(p, byTid(p, orb));
      if (!await until(async () => (await p.evaluate(() => window.__si.sent.length)) > 0, 60000)) throw new Error(`${tag}: the turn was not sent`);
      const r = judge(await recorded(p), SET, tag);
      note(`${tag}: sent ${r?.delay} ms after the words, drawn ${r?.drawn} ms, "${r?.first}" … "${r?.last}"`);
    } catch (e) { fail(String(e.message ?? e).split("\n")[0]); }
    await o.ctx.close().catch(() => {});
  }
}, { viewports, page: false });
