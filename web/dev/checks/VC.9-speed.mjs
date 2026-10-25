// VC.9 (new, small-improvements 3.1, 4.1 to 4.5, 6.1): the playback speed in the real page, on the mock with the stand-in voice service mounted at /voice
// (dev/voicestandin.mjs) and a spy on the page's player (playback.mjs: every `AudioBufferSourceNode` of the 24 kHz context with its `when`, length, frequency
// and stop time, the ctx clock, the text of an element and the presses on one, all by that clock). The stand-in answers a sine at `220 + 30 * voice index` Hz,
// 0.05 s of it per character, so the sound the page makes of it can be measured. Desktop only. A key `sk_test_…`, the voice Carol (280 Hz).
//   the picker     Settings > Voice > Advanced options' Playback speed (`vs-adv-speed`) lists exactly 0.5×, 1×, 1.5×, 2×; a speed saved before this work (1.2)
//                  is read as the nearest, 1×: shown, and `__aiwbVoice.settings().speed`
//   Read aloud     at each of the four speeds (set through the seam's `setSettings`, as Settings would) a message of three sentences: no request has
//                  a `voice_settings` (the stand-in logs no problem), and the texts and models asked for are the same at every speed; the samples played are
//                  the sum of round(n / speed) over the sentences (n: what the stand-in sent), within 1%; the time from the first sound to the end of the last
//                  is that many samples at 24 kHz within 5% (+50 ms); the pitch of what is played (the spy's zero crossings, the first and last buffer of a
//                  sentence left out) is the voice's within 2%; the reading ends (the engine's `reading.key` goes null) not before the last sound ends and
//                  within 400 ms after it, so "done" follows the stretched sound. The stand-in is paced faster here (30 ms between chunks) so that the page
//                  is never short of audio and the schedule has no gaps of the machine's making
//   the sentence   in Speech mode (a scripted turn through the checks' microphone, the reply the mock's) at 0.5× and at 2×: the sentence the bar shows
//                  (`speech-spoken`) changes to sentence k within 150 ms of the start of sentence k's sound (the source at the boundary the stretched
//                  lengths give), by the ctx clock
//   stopping       at 2× and at 0.5×, End reading in the middle of the second sentence (and, in Speech mode, a tap on `speech-wave`): within 300 ms every sound
//                  not over is stopped, none begins after the stop, the stand-in's open requests are cancelled and no sentence is asked for afterwards
//   a change       the speed changed to 2× while the first sentence of five plays at 1× (the stand-in slowed, so that the others are not yet streamed): each
//                  sentence is asked for once, in order; the first is played at 1× and every later one at 2× (a sentence is played at one speed, and once
//                  a sentence is at 2× the next are too), within 1%; the reading is marked as read all the way (never null in between), the player is
//                  not stopped or restarted, and the samples played are the sum of the sentences' own, so nothing is repeated or dropped
//   the first sound goal 4.5: from the stand-in's first TTS response to the first sound (the spy's `when`, as a time of day through the page's clock at the call
//                  of `start`; the stand-in runs in the mock's process on this machine, so the two clocks are one) at 0.5× and 2× is within 100 ms of
//                  the time at 1×, each the median of three
// OUT is not used: nothing is drawn that a picture would show better than the numbers, which `note` gives.
import { check, mockEval, seed, until } from "../shot.mjs";
import { useMic } from "./mic.mjs";
import { installPlayback } from "./playback.mjs";
import { byTid, press } from "./sel.mjs";
import { pressAct } from "./fork.mjs";

export const viewports = ["desktop"];

const KEY = "sk_test_VC9CANARY1";
const CHAT = "c_A4_turns";
const MSG = '[data-testid="msg"]';
const J = JSON.stringify;
const RATE = 24000;
const VOICE = { id: "vsCarol", name: "Carol", hz: 280 };
const SPEEDS = [0.5, 1, 1.5, 2];
// (the sentences are long enough to stay whole under the splitter and to be heard for a second or more)
const SHORT = ["Alpha is the first sentence of three.", "Beta is the second one, a little longer than that.", "Gamma ends it all with the third sentence here."];
const LONG = [
  "Delta begins this longer text with a sentence.",
  "Epsilon is the second sentence of the five.",
  "Zeta comes in the middle of the whole text.",
  "Eta is the fourth one, close to the end.",
  "Theta closes the five sentences of this reading.",
];
const TALK = "Iota says a first sentence to speak. Kappa follows it with a second. Lambda is the third and last of them.";
const TALK_SENTENCES = TALK.split(/(?<=\.) /);

await check("VC.9 Playback speed: the picker, Read aloud and Speech mode at each speed, the sentence shown, stopping, a change in a reply, the first sound", async ({ url, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const knob = (code) => mockEval(code, url);
  const tts = async () => (await mockEval("return voice.log();", url)).filter((e) => e.kind === "tts");
  const pace = (chunkMs, chunks) => knob(`voice.pace({ chunkMs: ${chunkMs}, chunks: ${chunks} }); return 1;`);
  const state = (p) => p.evaluate(() => window.__aiwbVoice.state());
  const sourcesOf = (p) => p.evaluate(() => window.__aiwbPlayback.sources());
  const nowOf = (p) => p.evaluate(() => window.__aiwbPlayback.now());
  const setSpeed = (p, speed) => p.evaluate((s) => window.__aiwbVoice.setSettings({ speed: s }), speed);
  const msgOf = (p, text) => byTid(p, "msg", { role: "assistant" }).filter({ hasText: text }).last();
  const idle = (p, ms = 90000) => until(async () => (await state(p)).reading.key === null && !(await byTid(p, "voice-reading").count()), ms);
  const ms3 = (x) => Math.round(x * 1000);
  const pct = (x) => `${(x * 100).toFixed(2)}%`;

  // ---- what the spy and the stand-in say, as numbers
  /** The samples the stand-in sent for each request, in the order asked: bytes / 2. */
  const sentOf = (entries) => entries.map((e) => e.bytes / 2);
  const expected = (ns, speed) => ns.map((n) => Math.round(n / speed));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  /** Where each source starts, in samples from the first. */
  const offsetsOf = (srcs) => { let c = 0; return srcs.map((s) => { const o = c; c += s.samples; return o; }); };
  const nearest = (offs, at) => offs.reduce((best, o, i) => (Math.abs(o - at) < Math.abs(offs[best] - at) ? i : best), 0);
  const slack = (at) => 480 + Math.round(at * 0.01);
  /** The source each sentence's sound starts with, given the samples each is played as: [{ index, err }], err in samples. */
  const boundaries = (srcs, played) => {
    const offs = offsetsOf(srcs);
    let at = 0;
    return played.map((len) => { const i = nearest(offs, at); const b = { index: i, err: offs[i] - at, at }; at += len; return b; });
  };
  const hzOfSentences = (srcs, bounds) => {
    let w = 0, s = 0;
    bounds.forEach((b, k) => {
      const end = k + 1 < bounds.length ? bounds[k + 1].index : srcs.length;
      for (const x of srcs.slice(b.index + 1, end - 1)) if (x.hz !== null) { w += x.samples; s += x.hz * x.samples; }
    });
    return w ? s / w : null;
  };

  // ---- pages
  /** The page of the app on the chat of the mock's A4 section, with the spy, the key and the voice; `settings` are the saved voice settings it starts with. */
  const boot = async (settings = {}) => {
    await sleep(600); // (the page before saves its draft as it closes)
    await knob("voice.reset(); flags.reply = undefined; return 1;");
    await seed(url, "A4");
    const ls = { "aiwb.voice.settings": J({ voiceId: VOICE.id, voiceName: VOICE.name, autoSend: true, pauseMs: 600, ...settings }) };
    const o = await open({ sel: { chat: CHAT }, wait: MSG, ls });
    await installPlayback(o.ctx);
    await o.page.reload();
    await o.page.waitForSelector(MSG, { timeout: 30000 });
    await o.page.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbPlayback && !!window.__aiwbSend, null, { timeout: 30000 });
    await o.page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    // the moment, by the player's clock, at which a reading ends: the first time its mark is gone after it was there
    await o.page.evaluate(() => {
      window.__end = { seen: false, at: null, nulls: 0 };
      setInterval(() => {
        const e = window.__end, k = window.__aiwbVoice.state().reading.key;
        if (k !== null) e.seen = true;
        else if (e.seen && e.at === null) e.at = window.__aiwbPlayback.now();
      }, 4);
    });
    return o;
  };
  const armEnd = (p) => p.evaluate(() => { window.__end = { seen: false, at: null }; });
  const sendReply = async (p, sentences, tag) => {
    await knob(`flags.reply = ${J({ text: sentences.join(" "), parts: 3, pace: 100 })}; return 1;`);
    await p.evaluate(([c, t]) => { void window.__aiwbSend(c, t); }, [CHAT, `Say it, ${tag}`]);
    const m = msgOf(p, sentences[0]);
    await m.waitFor({ state: "attached", timeout: 20000 });
    await until(async () => (await byTid(p, "msg", { role: "assistant", streaming: true }).count()) === 0, 30000);
    return m;
  };
  /** Starts a reading of `msg` at `speed` with a clean log and spy; resolves once it is on its way. */
  const startRead = async (p, msg, speed, { chunkMs = 100, chunks = 6, press: watch = [] } = {}) => {
    await knob("voice.reset(); return 1;");
    await pace(chunkMs, chunks);
    await setSpeed(p, speed);
    await p.evaluate((w) => { window.__aiwbPlayback.reset(); for (const id of w) window.__aiwbPlayback.watchPress(id); }, watch);
    await armEnd(p);
    await pressAct(p, msg, "read");
  };

  // ============================================================ the picker, and a speed saved before
  let page, ctx;
  ({ page, ctx } = await boot({ speed: 1.2 }));
  {
    const at = (await page.evaluate(() => window.__aiwbVoice.settings())).speed;
    if (at !== 1) fail(`a speed saved before (1.2) is read as ${at}, not 1`);
    await press(page, byTid(page, "settings-btn").first());
    await byTid(page, "settings-dialog").waitFor({ state: "visible", timeout: 15000 });
    await press(page, byTid(page, "vs-advanced"));
    const row = byTid(page, "vs-adv-speed");
    await row.waitFor({ state: "visible", timeout: 10000 });
    const shown = ((await row.innerText()) ?? "").replace(/[▾\s]+$/, "").trim();
    if (shown !== "1×") fail(`the saved 1.2 is shown as ${J(shown)}, not "1×"`);
    await press(page, row);
    await byTid(page, "menu-item").first().waitFor({ state: "visible", timeout: 10000 });
    const items = (await byTid(page, "menu-item").allTextContents()).map((s) => s.replace(/[✓\s]+/g, " ").trim());
    if (items.join(",") !== "0.5×,1×,1.5×,2×") fail(`the speeds listed are ${J(items)}, not exactly 0.5×, 1×, 1.5×, 2×`);
    await page.keyboard.press("Escape");
    await until(async () => !(await byTid(page, "menu").count()), 3000);
    await press(page, byTid(page, "vs-close"));
    await until(async () => !(await byTid(page, "settings-dialog").count()), 5000);
    note(`the picker lists ${items.join(", ")}; a saved 1.2 shows ${shown} and the setting is ${at}`);
  }

  // ============================================================ Read aloud at each speed
  const shortMsg = await sendReply(page, SHORT, "short");
  const longMsg = await sendReply(page, LONG, "long");
  const reference = { texts: null, hz: null };
  for (const speed of [1, 0.5, 1.5, 2]) {
    await startRead(page, shortMsg, speed, { chunkMs: 30, chunks: 6 });
    if (!await idle(page)) { fail(`Read aloud at ${speed}× did not end`); continue; }
    const entries = await tts();
    const srcs = await sourcesOf(page);
    const end = await page.evaluate(() => window.__end.at);
    const asked = entries.map((e) => `${e.model}|${e.text}`);
    if (entries.length !== SHORT.length) { fail(`${speed}×: ${entries.length} requests, not ${SHORT.length}: ${J(entries.map((e) => e.text))}`); continue; }
    if (entries.some((e) => e.problems?.length)) fail(`${speed}×: the stand-in saw the client break the protocol: ${J(entries.flatMap((e) => e.problems))}`);
    if (entries.some((e) => e.finishedAt === null)) fail(`${speed}×: a request was not read to its end`);
    if (reference.texts === null) reference.texts = asked;
    else if (J(asked) !== J(reference.texts)) fail(`${speed}×: the texts or models asked for differ from the ones at 1×: ${J(asked)} and ${J(reference.texts)}`);
    const ns = sentOf(entries), want = expected(ns, speed);
    const played = sum(srcs.map((s) => s.samples)), wantTotal = sum(want);
    if (Math.abs(played / wantTotal - 1) > 0.01) fail(`${speed}×: ${played} samples were played, not ${wantTotal} (the stretched lengths of ${J(ns)}): ${pct(played / wantTotal - 1)}`);
    const first = srcs[0], last = srcs[srcs.length - 1];
    const span = last.when + last.duration - first.when, wantSpan = wantTotal / RATE;
    if (Math.abs(span - wantSpan) > 0.05 * wantSpan + 0.05) fail(`${speed}×: the sound lasts ${ms3(span)} ms from the first to the last, not ${ms3(wantSpan)} ms`);
    const bounds = boundaries(srcs, want);
    for (const [k, b] of bounds.entries()) if (Math.abs(b.err) > slack(b.at)) fail(`${speed}×: sentence ${k + 1} does not start where the stretched lengths put it (${b.err} samples off)`);
    const hz = hzOfSentences(srcs, bounds);
    if (hz === null) fail(`${speed}×: no buffer in the middle of a sentence to measure the pitch on (${srcs.length} sources)`);
    else {
      if (Math.abs(hz / VOICE.hz - 1) > 0.02) fail(`${speed}×: the pitch of what is played is ${hz.toFixed(1)} Hz, not the voice's ${VOICE.hz} Hz`);
      if (reference.hz === null) reference.hz = hz;
    }
    const lastEnd = last.when + last.duration;
    if (end === null) fail(`${speed}×: the reading's end was not seen`);
    else if (end < lastEnd - 0.03 || end > lastEnd + 0.4) fail(`${speed}×: the reading ended ${ms3(end - lastEnd)} ms after the last sound (it must not be before it and within 400 ms)`);
    note(`Read aloud ${speed}×: ${played} samples for ${wantTotal} expected (${pct(played / wantTotal - 1)}), the sound lasts ${ms3(span)} ms for ${ms3(wantSpan)}, ${hz === null ? "no pitch" : `${hz.toFixed(1)} Hz`}, the boundaries are ${bounds.map((b) => b.err).join("/")} samples off, "done" ${end === null ? "never" : `${ms3(end - lastEnd)} ms`} after the last sound, ${srcs.length} writes`);
  }

  // ============================================================ stopping, at 2× and 0.5×
  /** The sound being in the middle of the second sentence: the first request is read to its end (so its stretched length is known) and the second sentence's
   *  first source has been playing for 100 ms. Answers the ctx time the second sentence starts at, or null. */
  const inSecond = async (p, speed) => {
    let at = null;
    await until(async () => {
      const first = (await tts())[0];
      if (!first || first.finishedAt === null) return false;
      const srcs = await sourcesOf(p);
      const offs = offsetsOf(srcs);
      const i = nearest(offs, Math.round(first.bytes / 2 / speed));
      if (!srcs.length || i === 0) return false;
      const now = await nowOf(p);
      if (now < srcs[i].when + 0.1) return false;
      at = srcs[i].when;
      return true;
    }, 60000);
    return at;
  };
  /** After the press (the spy's record of it): what the stop did. `what` names the case. */
  const stoppedAfter = async (p, what, pressId) => {
    const press_ = (await p.evaluate(() => window.__aiwbPlayback.presses())).filter((x) => x.testId === pressId);
    if (!press_.length) { fail(`${what}: the spy saw no press on ${pressId}`); return; }
    const at = press_[0].at;
    await sleep(500);
    const writes = await p.evaluate(() => window.__aiwbVoice.player().writes);
    const srcs = await sourcesOf(p);
    const late = srcs.filter((s) => s.when + s.duration > at + 0.02 && (s.stoppedAt === null || s.stoppedAt - at > 0.3));
    if (late.length) fail(`${what}: ${late.length} of ${srcs.length} sounds were not stopped within 300 ms of the press (stops after the press: ${J(late.map((s) => s.stoppedAt === null ? null : ms3(s.stoppedAt - at)))} ms)`);
    const lastStop = Math.max(...srcs.map((s) => s.stoppedAt ?? 0));
    const after = srcs.filter((s) => s.calledAt > Math.max(lastStop, at + 0.3) + 0.005);
    if (after.length) fail(`${what}: ${after.length} sounds were started after the stop`);
    const entries = await tts();
    const open = entries.filter((e) => e.finishedAt === null);
    if (!open.length || open.some((e) => !e.cancelled)) fail(`${what}: the open requests are ${J(entries.map((e) => [e.finishedAt !== null, e.cancelled]))} (some must have been open at the press, and all of those cancelled)`);
    const n = entries.length;
    await sleep(800);
    if ((await tts()).length !== n) fail(`${what}: a sentence was asked for after the stop`);
    if ((await p.evaluate(() => window.__aiwbVoice.player().writes)) !== writes) fail(`${what}: sound was written to the player after the stop`);
    const lastS = srcs.filter((s) => s.stoppedAt !== null);
    return { at, worst: lastS.length ? Math.max(...lastS.map((s) => s.stoppedAt - at)) : null, stopped: lastS.length, all: srcs.length, requests: n };
  };

  for (const speed of [2, 0.5]) {
    await startRead(page, longMsg, speed, { chunkMs: 300, chunks: 10, press: ["voice-reading"] });
    const at = await inSecond(page, speed);
    if (at === null) { fail(`stop at ${speed}×: the reading never came to the second sentence`); await pressAct(page, longMsg, "read"); await idle(page, 8000); continue; }
    await page.mouse.move(2, 2);
    const chip = byTid(page, "voice-reading");
    await chip.first().waitFor({ state: "visible", timeout: 5000 });
    await press(page, chip.first());
    if (!await idle(page, 8000)) fail(`stop at ${speed}×: End reading did not stop the reading`);
    const r = await stoppedAfter(page, `End reading at ${speed}×`, "voice-reading");
    if (r) note(`End reading at ${speed}×, ${ms3(r.at - at)} ms into the second sentence: ${r.stopped} of ${r.all} sounds stopped (the slowest ${r.worst === null ? "-" : ms3(r.worst)} ms after the press), ${r.requests} requests, the open ones cancelled, none more asked for`);
  }

  // ============================================================ a change of speed in the middle of a reply
  {
    await startRead(page, longMsg, 1, { chunkMs: 300, chunks: 6 });
    const started = await until(async () => { const s = await sourcesOf(page); return s.length > 0 && (await nowOf(page)) >= s[0].when; }, 30000);
    if (!started) fail("the change: the first sentence never played");
    const stops0 = await page.evaluate(() => window.__aiwbVoice.player().stops);
    await setSpeed(page, 2);
    if (!await idle(page)) fail("the change: the reading did not end");
    const stops1 = await page.evaluate(() => window.__aiwbVoice.player().stops);
    const entries = await tts();
    const srcs = await sourcesOf(page);
    const end = await page.evaluate(() => window.__end.at);
    if (J(entries.map((e) => e.text)) !== J(LONG)) fail(`the change: the sentences asked for are ${J(entries.map((e) => e.text))}, not each of the five once and in order`);
    if (entries.some((e) => e.problems?.length)) fail(`the change: the stand-in saw the client break the protocol: ${J(entries.flatMap((e) => e.problems))}`);
    if (stops1 !== stops0) fail(`the change: the player was stopped ${stops1 - stops0} times (a change of speed must not restart anything)`);
    const ns = sentOf(entries), total = sum(srcs.map((s) => s.samples));
    // the speed of each sentence: the one sequence, 1× up to some sentence and 2× from it, in which every sentence starts where the lengths put it
    let found = null;
    for (let j = 0; j <= ns.length && !found; j++) {
      const per = ns.map((n, k) => Math.round(n / (k < j ? 1 : 2)));
      const bounds = boundaries(srcs, per);
      if (bounds.every((b) => Math.abs(b.err) <= slack(b.at)) && Math.abs(total / sum(per) - 1) <= 0.01) found = { j, per, bounds, ratio: total / sum(per) - 1 };
    }
    if (!found) fail(`the change: no sequence of 1× then 2× fits what was played (${total} samples in ${srcs.length} writes for sentences of ${J(ns)} samples; their starts are ${J(offsetsOf(srcs))})`);
    else {
      if (found.j < 1 || found.j > ns.length - 1) fail(`the change: ${found.j} sentences were played at 1×; the first must have been, and the last must not`);
      const lastEnd = srcs[srcs.length - 1].when + srcs[srcs.length - 1].duration;
      // (the reading is marked from its start until the last sound is over: it never went null before, which `end` says)
      if (end === null || end < lastEnd - 0.03 || end > lastEnd + 0.4) fail(`the change: the reading ended ${end === null ? "never" : ms3(end - lastEnd)} ms after the last sound`);
      note(`a change to 2× during sentence 1 of 5: ${found.j} sentence(s) at 1×, ${ns.length - found.j} at 2×, ${total} samples played for ${sum(found.per)} (${pct(found.ratio)}), the starts ${found.bounds.map((b) => b.err).join("/")} samples off, the reading marked until ${ms3(end - lastEnd)} ms after the last sound, the player stopped ${stops1 - stops0} times`);
    }
  }
  await setSpeed(page, 1);

  // ============================================================ the first sound
  {
    const times = new Map(SPEEDS.filter((s) => s !== 1.5).map((s) => [s, []]));
    for (let round = 0; round < 3; round++) {
      for (const speed of [1, 0.5, 2]) {
        await startRead(page, shortMsg, speed, { press: [] });
        let t = null;
        await until(async () => {
          const srcs = await sourcesOf(page), e = (await tts())[0];
          if (!srcs.length || !e || e.startedAt === null) return false;
          t = srcs[0].calledDate + (srcs[0].when - srcs[0].calledAt) * 1000 - e.startedAt;
          return true;
        }, 20000);
        if (t === null) fail(`the first sound at ${speed}× never came`);
        else times.get(speed).push(t);
        await pressAct(page, shortMsg, "read"); // (End reading)
        await idle(page, 8000);
      }
    }
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const base = median(times.get(1));
    for (const speed of [0.5, 2]) {
      const m = median(times.get(speed));
      if (Math.abs(m - base) > 100) fail(`the first sound comes ${Math.round(m)} ms after the stand-in's first response at ${speed}× and ${Math.round(base)} ms at 1× (more than 100 ms apart)`);
    }
    note(`the first sound after the stand-in's first response (ms; three each): 1× ${times.get(1).map(Math.round).join("/")}, 0.5× ${times.get(0.5).map(Math.round).join("/")}, 2× ${times.get(2).map(Math.round).join("/")} (medians ${[1, 0.5, 2].map((s) => Math.round(median(times.get(s)))).join(", ")})`);
  }
  await ctx.close();

  // ============================================================ Speech mode, at 0.5× and 2×: the sentence shown, and a tap on the wave
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const phaseIs = (p, ph, ms = 30000) => until(async () => (await sess(p)).phase === ph, ms);
  /** Speech mode's control, in the row or in the "more" popup, once the toolbar has settled. */
  const pressSpeech = async (p) => {
    let last = "";
    for (let i = 0; i < 40; i++) {
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, "voice-speech").count()) { await press(p, byTid(p, "voice-speech")); return true; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, "more-speech").count(), 5000)) return false;
    await press(p, byTid(p, "more-speech"));
    return true;
  };
  const turn = async (p, words, reply, paceNow, watch) => {
    await knob(`voice.reset(); voice.script(${J([{ after: 3, committed: words }])}); voice.pace(${J(paceNow)}); flags.reply = ${J(reply)}; return 1;`);
    await p.evaluate((w) => { window.__aiwbPlayback.reset(); for (const id of w.press) window.__aiwbPlayback.watchPress(id); window.__aiwbPlayback.watchText("speech-spoken"); }, watch);
    if (!await pressSpeech(p)) { fail("Speech mode is neither in the row nor in the \"more\" popup"); return false; }
    if (!await phaseIs(p, "listening")) { fail(`speech mode did not start listening: ${J(await sess(p))}, ${J(await p.evaluate(() => window.__aiwbVoice.state().problem))}`); return false; }
    return true;
  };

  for (const speed of [0.5, 2]) {
    const label = `Speech mode at ${speed}×`;
    const o = await boot({ speed });
    await useMic(o.page, note);
    const p = o.page;
    // ---- the sentence shown follows the sound
    if (await turn(p, "tell me the plan", { text: TALK, parts: 4, pace: 150 }, { chunkMs: 30, chunks: 6 }, { press: [] })) {
      const done = await until(async () => (await tts()).length >= TALK_SENTENCES.length && (await sess(p)).phase === "listening" && (await state(p)).reading.key === null && !(await byTid(p, "speech-spoken").count()), 90000);
      if (!done) fail(`${label}: the reply was not spoken to its end: ${J((await tts()).map((e) => e.text))}, ${J(await sess(p))}`);
      const entries = await tts(), srcs = await sourcesOf(p);
      if (J(entries.map((e) => e.text)) !== J(TALK_SENTENCES)) fail(`${label}: the sentences asked for are ${J(entries.map((e) => e.text))}`);
      else if (entries.some((e) => e.problems?.length)) fail(`${label}: the stand-in saw the client break the protocol: ${J(entries.flatMap((e) => e.problems))}`);
      else {
        const bounds = boundaries(srcs, expected(sentOf(entries), speed));
        const texts = (await p.evaluate(() => window.__aiwbPlayback.texts("speech-spoken"))).filter((t) => t.text !== "");
        const errs = [];
        entries.forEach((e, k) => {
          const rec = texts.find((t) => t.text.includes(e.text.slice(0, 12)));
          if (!rec) { fail(`${label}: the bar never showed sentence ${k + 1} (it showed ${J(texts.map((t) => t.text))})`); return; }
          if (Math.abs(bounds[k].err) > slack(bounds[k].at)) fail(`${label}: sentence ${k + 1} does not start where the stretched lengths put it (${bounds[k].err} samples off)`);
          const diff = rec.at - srcs[bounds[k].index].when;
          errs.push(diff);
          if (Math.abs(diff) > 0.15) fail(`${label}: the bar shows sentence ${k + 1} ${ms3(diff)} ms after its sound began (it must be within 150 ms)`);
        });
        const order = texts.map((t) => entries.findIndex((e) => t.text.includes(e.text.slice(0, 12))));
        if (order.some((v, i) => i && v < order[i - 1])) fail(`${label}: the bar showed the sentences out of order (${order.join(",")})`);
        note(`${label}: the bar's sentence changed ${errs.map((e) => ms3(e)).join(" / ")} ms after the start of each sentence's sound`);
      }
    }
    await press(p, byTid(p, "speech-end"));
    await phaseIs(p, "idle", 10000);

    // ---- a tap on the wave in the middle of the second sentence
    if (await turn(p, "tell me a lot", { text: LONG.join(" "), parts: 4, pace: 300 }, { chunkMs: 300, chunks: 10 }, { press: ["speech-wave"] })) {
      const at = await inSecond(p, speed);
      if (at === null) fail(`${label}: the reply never came to the second sentence`);
      else {
        const wave = byTid(p, "speech-wave");
        await press(p, wave);
        if (!await phaseIs(p, "listening", 8000)) fail(`${label}: a tap on the wave left the session ${J((await sess(p)).phase)}, not listening`);
        const r = await stoppedAfter(p, `${label}, a tap on the wave`, "speech-wave");
        if (r) note(`${label}, a tap on the wave ${ms3(r.at - at)} ms into the second sentence: ${r.stopped} of ${r.all} sounds stopped (the slowest ${r.worst === null ? "-" : ms3(r.worst)} ms after the tap), ${r.requests} requests, the open ones cancelled, none more asked for`);
      }
    }
    await press(p, byTid(p, "speech-end"));
    await o.ctx.close();
  }
}, { viewports, page: false, allowConsole: [/the mock failed this read|tree/i] });
