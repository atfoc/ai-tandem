// VC.4 (new, voice-chats P13b): speech mode, the composer's speech bar and the mic mark, on the mock with the stand-in voice service mounted at /voice
// (dev/voicestandin.mjs) and the checks' Chromium with its fake microphone (shot.mjs BROWSER_ARGS; mic.mjs says what happens where the fake microphone
// does not answer), at the desktop and the phone. Goal 3.1, 3.5, 4.6, 4.7, 6.1; architecture §9, VC-17, VC-21, VC-23. The microphone is a real capture:
// the stand-in sees the chunks the page made and answers the scripted words (`voice.script`); the reply is the mock's (`flags.reply`: several
// sentences, growing), so that the whole path is the page's: capture, 16 kHz, the socket, the engine, the bar, `sendMessage`, the stream, the
// splitter, one request per sentence to the stand-in, the player.
//   the bar        speech mode (`voice-speech`) puts `speech-bar` in the place of the box and the toolbar, which are hidden and not unmounted (the draft is
//                  still in the box when speech mode ends); it holds the wave, the words so far, Mute, End and the Auto-send toggle, and is gone at End
//   a turn         Auto-send on: the words said show in the bar (the guess first, then the finished words), the pause starts a countdown bar with the
//                  seconds left (`speech-countdown`), and 1.2 s later the words are an ordinary message: the same POST a typed message makes, with the
//                  spoken words and not the box's draft
//   the reply      spoken sentence by sentence: one request to the stand-in per sentence, in the reply's order, each once, the first one asked for and
//                  played (`__aiwbVoice.player()`) while the reply is still being written and before the stand-in has finished it; the sentence
//                  being spoken is in the bar (`speech-spoken`); afterwards the session listens again (`speech-bar` data-phase)
//   the draft      text typed in the box before speech mode is in the box again after the spoken turn (the turn clears nothing but itself)
//   the mark       the spoken message has the mic mark (`msg-mic`); a message typed after it has none
//   Cancel         inside the countdown it sends nothing and keeps the words (Send is on); talking on starts the pause again and the turn then goes
//   Auto-send off  the bar keeps listening and shows no countdown however long the silence; the message goes when Send is pressed, and not before
//   one setting    the Auto-send toggle of the bar is the voice setting: Settings (`vs-autosend`) and the board's pill (`pill-autosend`) show what was set in the bar
//   interrupt      a tap on the wave while the model speaks stops the sound, cancels the requests still open and asks for no more; the session listens
//   Mute, End      Mute sends no audio and keeps the socket; Unmute sends again; End sends none, closes the socket and gives the box and toolbar back
//   leaving        the session ends when its chat leaves the screen
// OUT=/tmp/x keeps a screenshot of the page in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { openState } from "./composer.mjs";
import { useMic } from "./mic.mjs";
import { back, byTid, openBoard, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_VC4CANARY1";
const MSG = /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages(\?|$)/;
const ANSWER = "Here is the plan. First we draw the boxes. Then we connect them with arrows. That is all.";
const J = JSON.stringify;

await check("VC.4 Speech mode: the bar, a spoken turn, the spoken reply, Cancel, Auto-send off, interrupt, Mute and End, the mic mark", async ({ url, viewport, layout, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const state = async () => (await seed(url, "A2")).find((s) => s.id === "plain-started");
  const log = () => mockEval("return voice.log();", url);
  const shot = async (p, name, still = true) => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    if (still) await atRest(p, 6).catch(() => {}); // (a waveform and a countdown never rest)
    await p.screenshot({ path: path.join(OUT, `VC.4-${viewport}-${name}.png`) });
  };
  const box = (p) => byTid(p, "composer-input").first();
  const text = async (p) => ((await box(p).textContent()) ?? "").replace(/ /g, " ");
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const settings = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const phaseIs = (p, ph, ms = 20000) => until(async () => (await sess(p)).phase === ph, ms);
  const idle = (p) => phaseIs(p, "idle", 10000);
  const shown = (loc, ms = 15000) => until(() => loc.first().isVisible().catch(() => false), ms);
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const hidden = async (loc) => (await loc.count()) === 0 || !(await loc.first().isVisible());
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const typeIn = async (p, s) => { await press(p, box(p)); await p.keyboard.type(s); };
  const stt = async () => (await log()).filter((e) => e.kind === "stt");
  const tts = async () => (await log()).filter((e) => e.kind === "tts");
  const posts = (calls, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && MSG.test(c.path));
  const bodyText = (c) => (c.body && typeof c.body === "object" ? c.body.text : c.body);
  const msgOf = (p, role, t) => byTid(p, "msg", { role }).filter({ hasText: t }).last();
  const script = (steps) => mockEval(`voice.script(${J(steps)}); return 1;`, url);
  const reply = (t, parts = 8, pace = 700) => mockEval(`flags.reply = { text: ${J(t)}, parts: ${parts}, pace: ${pace} }; return 1;`, url);
  /** In the page: when the reply being written starts and ends (the thread's assistant message `data-streaming`), as the page's clock says. */
  const watchReply = (p) => p.evaluate(() => {
    const r = (window.__reply = { start: null, end: null });
    const look = () => {
      const live = document.querySelectorAll('[data-testid="msg"][data-role="assistant"][data-streaming="true"]').length;
      if (live && r.start === null) r.start = Date.now();
      if (!live && r.start !== null && r.end === null) r.end = Date.now();
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-streaming"] });
  });
  /** In the page: every change of the bar's phase and of the sentence it shows, in order, 20 ms apart at the most. */
  const watchBar = (p) => p.evaluate(() => {
    const seen = (window.__bar = { phases: [], said: [] });
    setInterval(() => {
      const b = document.querySelector('[data-testid="speech-bar"]'), s = document.querySelector('[data-testid="speech-spoken"]');
      const ph = b ? b.getAttribute("data-phase") : "none";
      if (seen.phases[seen.phases.length - 1] !== ph) seen.phases.push(ph);
      const t = s ? s.textContent : null;
      if (t && seen.said[seen.said.length - 1] !== t) seen.said.push(t);
    }, 20);
  });
  const barSeen = (p) => p.evaluate(() => window.__bar);
  /** Speech mode's control: in the row, or in the open "more" popup when the row has no room. Presses it. */
  const pressSpeech = async (p) => {
    // (a page just opened is still measuring its toolbar: the pair is drawn in the row until its width is kept, then placed. Wait for a place that stays.)
    let last = "";
    for (let i = 0; i < 40; i++) {
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, "voice-speech").count()) { await press(p, byTid(p, "voice-speech")); return "row"; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, "more-speech").count(), 5000)) { fail("Speech mode is neither in the row nor in the \"more\" popup"); return null; }
    await press(p, byTid(p, "more-speech"));
    return "more";
  };
  /** A page with the stand-in reset, a key and a microphone; the box emptied (the mock keeps a draft the box saved). `o`: openState's options. */
  const fresh = async (o = {}) => {
    await sleep(1000); // (the page of the section before saves its draft as it closes: that call is over before the seed is made anew)
    await mockEval("voice.reset(); return 1;", url);
    const s = await state();
    const p = await openState(open, s, layout, 0, o);
    await useMic(p.page, note);
    await p.page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    if (await text(p.page)) { await press(p.page, box(p.page)); await p.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a"); await p.page.keyboard.press("Backspace"); }
    return p;
  };
  /** Starts speech mode and waits for the bar to listen. */
  const startSpeech = async (p, what) => {
    const got = await pressSpeech(p);
    if (got === null) return false;
    if (!await phaseIs(p, "listening")) {
      fail(`${what}: speech mode did not start listening: the session is ${J(await sess(p))}, the problem ${J(await p.evaluate(() => window.__aiwbVoice.state().problem))}`);
      return false;
    }
    if (!await shown(byTid(p, "speech-bar"))) { fail(`${what}: the session listens and the bar is not shown`); return false; }
    return true;
  };
  const off = { autoSend: false };
  const lsOf = (s) => ({ "aiwb.voice.settings": J(s) });

  // ---- a turn with Auto-send: the bar, the countdown, the ordinary message, the spoken reply, the mark
  {
    const { page, ctx } = await fresh();
    const calls = callsOf(page);
    await typeIn(page, "my draft");
    await watchReply(page);
    await watchBar(page);
    await script([{ after: 3, partial: "what is" }, { after: 6, partial: "what is the plan" }, { after: 8, committed: "what is the plan" }]);
    await reply(ANSWER);
    if (await byTid(page, "speech-bar").count()) fail("the speech bar is there before speech mode is on");
    const from = calls.length;
    if (!await startSpeech(page, "the turn")) { await ctx.close(); return; }
    // the bar stands in the place of the box and the toolbar, which are hidden
    for (const id of ["speech-wave", "speech-mute", "speech-end", "speech-autosend"]) if (!await shown(byTid(page, id), 5000)) fail(`the speech bar shows no ${id}`);
    if (!await hidden(byTid(page, "composer-input"))) fail("the box is still shown while the speech bar is");
    if (!await hidden(byTid(page, "composer-tools"))) fail("the toolbar is still shown while the speech bar is");
    if (!await hidden(byTid(page, "voice-speech"))) fail("the Speech mode button is still shown while the speech bar is");
    if (await byTid(page, "composer-input").count() !== 1) fail("the box was unmounted while the speech bar is shown (its draft would be lost)");
    if (await byTid(page, "speech-autosend").getAttribute("data-on") !== "true") fail("the Auto-send toggle is not on by default");
    // the words so far: the guess, then the finished words; the wave is the microphone's
    const wordsNow = async () => textOf(byTid(page, "speech-words"));
    if (!await until(async () => (await wordsNow()).includes("what is"), 20000)) fail(`the words said never reached the bar: it shows ${J(await textOf(byTid(page, "speech-bar")))}`);
    await shot(page, "1-listening", false);
    if (!await until(async () => (await wordsNow()) === "what is the plan", 20000)) fail(`the finished words are ${J(await wordsNow())}, not "what is the plan"`);
    if (!await until(async () => +(await byTid(page, "speech-wave").getAttribute("data-peak")) > 0, 15000)) fail("the waveform never moved: the microphone's level does not reach it");
    // the pause: a countdown with the seconds left
    let tC = 0;
    if (!await until(async () => { if (await byTid(page, "speech-countdown").count()) { tC = Date.now(); return true; } return false; }, 20000)) fail("no countdown after the pause");
    else {
      const left = +(await byTid(page, "speech-countdown").getAttribute("data-left"));
      if (!(left > 0 && left <= 1.2)) fail(`the countdown has ${left} s left, not 1.2 s or less`);
      if (!/^\d\.\d s$/.test(await textOf(byTid(page, "speech-countdown")).then((t) => t.replace(/Cancel/, "").trim()))) fail(`the countdown says ${J(await textOf(byTid(page, "speech-countdown")))}, not the seconds left and Cancel`);
      if (!await shown(byTid(page, "speech-cancel"), 3000)) fail("the countdown has no Cancel");
      await shot(page, "2-countdown", false);
      if (posts(calls, from).length) fail("the message went before the countdown ended");
    }
    let tP = 0;
    const sent = await until(() => { const m = posts(calls, from)[0]; if (m) tP = Date.now(); return m; }, 20000);
    if (!sent) fail("Auto-send sent nothing");
    else {
      if (bodyText(sent) !== "what is the plan") fail(`the message is ${J(sent.body)}, not the words said (the box's draft is not part of it)`);
      if (tC && tP - tC < 600) fail(`the message went ${tP - tC} ms after the countdown began (the pause is 1.2 s)`);
      if (!MSG.test(sent.path)) fail(`the message went to ${sent.path}, not a chat's messages`);
    }
    // the message in the thread, with the mic mark
    const mine = msgOf(page, "user", "what is the plan");
    if (!await until(async () => (await mine.count()) > 0, 15000)) fail("the spoken message is not in the thread");
    else if (!await until(async () => (await mine.locator(tidSel("msg-mic")).count()) === 1, 10000)) fail("the spoken message has no mic mark");
    // the reply, spoken sentence by sentence
    if (!await until(async () => (await tts()).length >= 4, 40000)) fail(`only ${(await tts()).length} of the reply's 4 sentences were asked of the voice service`);
    if (!await until(async () => (await sess(page)).phase === "listening" && (await page.evaluate(() => window.__reply.end)), 60000)) fail(`the session did not listen again after the reply: it is ${J((await sess(page)).phase)}`);
    const spoken = await tts();
    if (spoken.map((e) => e.text).join(" ").replace(/\s+/g, " ") !== ANSWER) fail(`the sentences asked for are ${J(spoken.map((e) => e.text))}, not the reply's, each once and in order`);
    if (spoken.some((e) => e.problems?.length)) fail(`the client broke the protocol: ${J(spoken.flatMap((e) => e.problems))}`);
    const replied = await page.evaluate(() => window.__reply), play = await page.evaluate(() => window.__aiwbVoice.player());
    if (!(replied.start && replied.end)) fail(`the reply's start and end were not seen: ${J(replied)}`);
    else {
      if (!(spoken[0].at < replied.end)) fail(`the first sentence was asked for ${spoken[0].at - replied.end} ms after the reply ended`);
      if (!(play.firstWriteAt && play.firstWriteAt < replied.end)) fail(`the first sentence was not played before the reply ended (first write ${play.firstWriteAt}, reply end ${replied.end})`);
    }
    if (spoken[0].finishedAt && play.firstWriteAt && !(play.firstWriteAt < spoken[0].finishedAt)) fail("playback began only after the voice service had finished the first sentence");
    await sleep(300);
    const bar = await barSeen(page);
    const order = ["listening", "countdown", "sending", "thinking", "speaking", "listening"];
    let at = -1;
    for (const ph of order) {
      const i = bar.phases.indexOf(ph, at + 1);
      if (i < 0 && !(ph === "sending" || ph === "thinking")) fail(`the bar never went through "${ph}" in order: ${bar.phases.join(" > ")}`);
      if (i >= 0) at = i;
    }
    for (const e of spoken) if (!bar.said.some((s) => s.includes(e.text.slice(0, 12)))) fail(`the bar never showed the sentence being spoken: ${J(e.text)} (it showed ${J(bar.said)})`);
    await shot(page, "3-speaking-done");
    // End: the box and the toolbar are back, with the draft; the socket is closed
    await press(page, byTid(page, "speech-end"));
    if (!await idle(page)) fail("End did not end the session");
    if (!await gone(byTid(page, "speech-bar"))) fail("the bar stays after End");
    if (!await shown(box(page), 5000)) fail("the box is not back after End");
    // the draft typed before speech mode is still there after the spoken turn: the server removed the branch's draft for the send, and the composer's
    // saver (`keeping`) saved it again instead of following the removal (a typed message is sent as before, below)
    if (!await until(async () => (await text(page)) === "my draft", 8000)) fail(`the box holds ${J(await text(page))} after the spoken turn, not the draft typed before speech mode`);
    else {
      await sleep(2500); // (the removal's event can reach the page just after the answer)
      if (await text(page) !== "my draft") fail(`the box lost the draft later: it holds ${J(await text(page))}`);
    }
    if (!await shown(byTid(page, "composer-tools"), 5000)) fail("the toolbar is not back after End");
    const closed = (await stt())[0];
    if (!closed || closed.closeCode === null || closed.closeCode === undefined) fail("End did not close the socket");
    // a typed message has no mark
    await press(page, box(page));
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.type("a typed one");
    await press(page, byTid(page, "send").first());
    const typed = msgOf(page, "user", "a typed one");
    if (!await until(async () => (await typed.count()) > 0, 15000)) fail("the typed message is not in the thread");
    else {
      await sleep(500);
      if (await typed.locator(tidSel("msg-mic")).count()) fail("a typed message has the mic mark");
      if (await byTid(page, "msg-mic").count() !== 1) fail(`the thread has ${await byTid(page, "msg-mic").count()} mic marks, not the one spoken message's`);
    }
    await shot(page, "4-thread");
    await ctx.close();
  }

  // ---- Cancel inside the countdown keeps the words and sends nothing; talking on goes from there
  {
    const { page, ctx } = await fresh();
    const calls = callsOf(page);
    await script([{ after: 3, partial: "send nothing" }, { after: 5, committed: "send nothing" }, { after: 45, partial: "please" }, { after: 48, committed: "please" }]);
    const from = calls.length;
    if (!await startSpeech(page, "Cancel")) { await ctx.close(); return; }
    if (!await until(() => byTid(page, "speech-countdown").count(), 20000)) fail("no countdown after the pause");
    else {
      await press(page, byTid(page, "speech-cancel"));
      if (!await gone(byTid(page, "speech-countdown"), 3000)) fail("the countdown stays after Cancel");
      if (await textOf(byTid(page, "speech-words")) !== "send nothing") fail(`Cancel did not keep the words: the bar shows ${J(await textOf(byTid(page, "speech-bar")))}`);
      if (!await until(async () => (await sess(page)).phase === "waiting", 3000)) fail(`after Cancel the session is ${J((await sess(page)).phase)}, not waiting`);
      if (await byTid(page, "speech-send").isDisabled()) fail("Send is off after Cancel, with words to send");
      await shot(page, "5-cancelled", false);
      await sleep(2800); // (more than the 1.2 s pause: a countdown that had not been cancelled would have sent by now)
      if (posts(calls, from).length) fail("a message was sent after Cancel");
      if (await byTid(page, "speech-countdown").count()) fail("a countdown began again by itself after Cancel");
      // talking on: the words go on from the kept ones, the pause runs again, the turn goes
      const sent = await until(() => posts(calls, from)[0], 30000);
      if (!sent) fail("talking on after Cancel did not lead to a send");
      else if (bodyText(sent) !== "send nothing please") fail(`the message is ${J(bodyText(sent))}, not the kept words and the new ones`);
    }
    await ctx.close();
  }

  // ---- Auto-send off: nothing is sent until Send; the toggle is the one setting
  {
    const { page, ctx } = await fresh();
    const calls = callsOf(page);
    await script([{ after: 3, partial: "tap" }, { after: 6, committed: "tap to send" }]);
    const from = calls.length;
    if (!await startSpeech(page, "Auto-send off")) { await ctx.close(); return; }
    await press(page, byTid(page, "speech-autosend"));
    if (!await until(async () => (await settings(page)).autoSend === false, 5000)) fail("the bar's Auto-send toggle did not change the voice setting");
    if (await byTid(page, "speech-autosend").getAttribute("data-on") !== "false") fail("the bar's toggle does not say Auto-send is off");
    if (!await until(async () => (await textOf(byTid(page, "speech-words"))) === "tap to send", 20000)) fail(`the words said never reached the bar: ${J(await textOf(byTid(page, "speech-bar")))}`);
    await sleep(3000); // (well past the 1.2 s pause)
    if (await byTid(page, "speech-countdown").count()) fail("a countdown runs with Auto-send off");
    if (posts(calls, from).length) fail("a message was sent with Auto-send off, before Send");
    if ((await sess(page)).phase !== "waiting") fail(`with Auto-send off the session is ${J((await sess(page)).phase)}, not waiting for Send`);
    if (await byTid(page, "speech-send").isDisabled()) fail("Send is off with words waiting");
    await shot(page, "6-tap-to-send", false);
    await press(page, byTid(page, "speech-send"));
    const sent = await until(() => posts(calls, from)[0], 15000);
    if (!sent) fail("Send sent nothing");
    else if (bodyText(sent) !== "tap to send") fail(`the message is ${J(bodyText(sent))}, not the words said`);
    await press(page, byTid(page, "speech-end"));
    await idle(page);
    // the setting is Settings' too (the phone shows the sidebar, where the gear is, after Back), and the pill's
    if (layout === "phone") await back(page);
    const gear = byTid(page, "settings-btn").first();
    if (!await shown(gear)) fail("the sidebar's Settings button is not shown");
    else {
      await press(page, gear);
      if (!await shown(byTid(page, "settings-dialog"))) fail("the Settings button opened no page");
      else {
        if (await byTid(page, "vs-autosend-false").getAttribute("aria-checked") !== "true") fail("Settings does not show Tap to send, which the bar set");
        await shot(page, "7-settings");
        await press(page, byTid(page, "vs-close"));
        await gone(byTid(page, "settings-dialog"));
      }
    }
    await openBoard(page, "b_ui");
    if (!await shown(byTid(page, "pill-orb"))) fail("the board shows no pill");
    else {
      await press(page, byTid(page, "pill-orb"));
      if (!await shown(byTid(page, "pill-autosend"), 20000)) fail("the pill's listening bar shows no Auto-send toggle");
      else if (await byTid(page, "pill-autosend").getAttribute("data-on") !== "false") fail("the pill does not show Tap to send, which the bar set");
      await shot(page, "8-pill", false);
      await press(page, byTid(page, "pill-orb"));
      await idle(page);
    }
    await ctx.close();
  }

  // ---- a tap on the waveform interrupts the model while it speaks
  {
    const { page, ctx } = await fresh();
    await script([{ after: 3, committed: "tell me a lot" }]);
    await mockEval("voice.pace({ chunkMs: 300, chunks: 10 }); return 1;", url);
    await reply("One is the first sentence. Two is the second sentence. Three is the third sentence. Four is the fourth sentence. Five is the fifth sentence.", 4, 400);
    if (!await startSpeech(page, "interrupt")) { await ctx.close(); return; }
    const wave = byTid(page, "speech-wave");
    if (!await until(async () => (await wave.getAttribute("data-phase")) === "speaking", 40000)) fail(`the model never spoke: the bar is ${J(await wave.getAttribute("data-phase"))}`);
    else {
      if (!await shown(byTid(page, "speech-spoken"), 5000)) fail("the bar shows no sentence while the model speaks");
      await shot(page, "9-speaking", false);
      const before = await tts();
      await press(page, wave);
      if (!await phaseIs(page, "listening", 8000)) fail(`a tap on the waveform left the session ${J((await sess(page)).phase)}, not listening`);
      if (!await gone(byTid(page, "speech-spoken"), 5000)) fail("the sentence stays in the bar after the interruption");
      await sleep(400);
      const after = await tts(), p2 = await page.evaluate(() => window.__aiwbVoice.player());
      if (!after.some((e) => e.cancelled)) fail(`no request was cancelled by the tap: ${J(after.map((e) => [e.text, e.finishedAt !== null, e.cancelled]))}`);
      if (after.some((e) => e.finishedAt === null && !e.cancelled)) fail(`a request is still open after the tap: ${J(after.filter((e) => e.finishedAt === null && !e.cancelled).map((e) => e.text))}`);
      if (!before.length) fail("the voice service had no request before the tap");
      const n = after.length, writes = p2.writes;
      await sleep(2500); // (the 5 sentences would have gone on for seconds: nothing more is asked or played)
      if ((await tts()).length !== n) fail(`more sentences were asked for after the tap (${n}, then ${(await tts()).length})`);
      if ((await page.evaluate(() => window.__aiwbVoice.player())).writes !== writes) fail("sound was written to the player after the tap");
      if ((await sess(page)).phase !== "listening") fail(`the session is ${J((await sess(page)).phase)} after the interruption, not listening`);
    }
    await press(page, byTid(page, "speech-end"));
    await ctx.close();
  }

  // ---- Mute and End send no audio; End closes the socket
  {
    const { page, ctx } = await fresh({ ls: lsOf(off) });
    await script([{ after: 3, committed: "hold on" }]);
    await typeIn(page, "my draft");
    if (!await startSpeech(page, "Mute")) { await ctx.close(); return; }
    const chunks = async () => (await stt())[0]?.chunks ?? 0;
    if (!await until(async () => (await chunks()) >= 6, 20000)) fail(`the microphone's audio does not reach the voice service (${await chunks()} chunks)`);
    await press(page, byTid(page, "speech-mute"));
    if (!await until(async () => (await sess(page)).muted === true, 5000)) fail("Mute did not mute the session");
    if (await byTid(page, "speech-mute").getAttribute("data-on") !== "true") fail("the Mute control does not say it is on");
    if (await textOf(byTid(page, "speech-mute")) !== "Unmute") fail(`the Mute control says ${J(await textOf(byTid(page, "speech-mute")))} while muted`);
    await sleep(500);
    const c1 = await chunks();
    await shot(page, "10-muted", false);
    await sleep(1500);
    if (await chunks() !== c1) fail(`audio went up while muted (${c1} chunks, then ${await chunks()})`);
    if ((await stt())[0].closeCode !== null) fail("Mute closed the socket");
    await press(page, byTid(page, "speech-mute"));
    if (!await until(async () => (await chunks()) > c1, 8000)) fail("no audio went up after Unmute");
    await press(page, byTid(page, "speech-end"));
    if (!await idle(page)) fail("End did not end the session");
    await sleep(500);
    const e = (await stt())[0], c2 = e.chunks;
    if (e.closeCode === null || e.closeCode === undefined) fail("End did not close the socket");
    await sleep(1200);
    if (await chunks() !== c2) fail(`audio went up after End (${c2} chunks, then ${await chunks()})`);
    if (e.problems?.length) fail(`the client broke the protocol: ${J(e.problems)}`);
    if (J(e).includes(KEY)) fail("the key is in the stand-in's log");
    if (!await gone(byTid(page, "speech-bar"))) fail("the bar stays after End");
    if (!await shown(box(page), 5000)) fail("the box is not back after End");
    else if (await text(page) !== "my draft") fail(`the box holds ${J(await text(page))} after speech mode, not the draft it had (the box is hidden while the bar shows, not unmounted)`);
    await ctx.close();
  }

  // ---- the session ends when its chat leaves the screen
  {
    const { page, ctx } = await fresh({ ls: lsOf(off) });
    await script([{ after: 3, committed: "never sent" }]);
    if (!await startSpeech(page, "leaving")) { await ctx.close(); return; }
    if (layout === "phone") await back(page);
    else {
      const here = await byTid(page, "composer").first().getAttribute("data-chat");
      const other = await page.evaluate((h) => [...document.querySelectorAll('[data-testid="side-row"][data-kind="chat"]')].map((e) => e.dataset.key).find((k) => k && k !== h) ?? null, here);
      if (!other) note("no other chat row to open: the session was not tried against a chat that is left on a wide layout");
      else await press(page, byTid(page, "side-row", { kind: "chat", key: other }).first());
    }
    if (layout === "phone" || (await page.evaluate(() => document.querySelector('[data-testid="speech-bar"]') === null))) {
      if (!await idle(page)) fail(`the session is ${J((await sess(page)).phase)} after its chat left the screen, not idle`);
      await sleep(500);
      const e = (await stt())[0];
      if (!e || e.closeCode === null || e.closeCode === undefined) fail("the socket stays open after the chat left the screen");
    }
    await ctx.close();
  }
}, { viewports, page: false });
