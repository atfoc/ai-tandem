// VC.3 (new, voice-chats P13a): Dictate, the composer's microphone control, on the mock with the stand-in voice service mounted at /voice
// (dev/voicestandin.mjs) and the checks' Chromium with its fake microphone (shot.mjs BROWSER_ARGS), at the desktop, the tablet and the phone.
// Goal 3.2, 3.4, 4.7, 6.1; architecture §8.1, VC-17. The microphone is the browser's own fake device: the stand-in sees the audio chunks it
// really captured and answers the scripted words (`voice.script`), so the whole path is the page's: capture, 16 kHz, base64 frames, the socket,
// the engine, the sink, the box.
//   where         Dictate (`voice-dictate`) works from the composer's toolbar row, and from the "more" popup when the row has no room for it
//                 (VC.7 holds where it stands at each width)
//   the words     the box holds the typed text first (the base); the live guess shows in it as ordinary text while the person speaks, finished
//                 words are appended after the base, and a guess that is replaced leaves nothing of itself behind
//   the audio     the stand-in's log for the session: 16 kHz, chunks of about 100 ms, no protocol problem, the key only as the header; the socket
//                 is closed when Dictate is pressed again (a closed socket sends nothing more)
//   no sending    however long the silence, nothing is sent (no POST of a message); the person presses Send, and the message is the box's text
//   typing        typing in the box while dictating ends dictation, the box is left as typed and the words that come later are not put in it
//   no key        Dictate shows the "needs your key" popover, hung from the control, and starts nothing: no socket, no microphone; the box is as it was
//   no mic        a blocked microphone shows its popover and leaves the box as it was
// The phone (V1, goal 3.7.2, mockup co-06c) draws it otherwise: the live guess is NOT in the box but muted under the text (`dictate-guess`), the finished
// words go into the box as plain text after what was typed, `dictate-line` shows while it listens ("Listening…", "Tap the mic to end"), and the primary stays
// Send while it listens (Talk is the primary of an empty box otherwise). The no-key and blocked-microphone problems are the "Set up voice" sheet.
// OUT=/tmp/x keeps a screenshot of the composer in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { openState } from "./composer.mjs";
import { useMic } from "./mic.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_VC3CANARY1";
const POST = /\/chats\/(\w+)\/messages(\?|$)/;
const J = JSON.stringify;

await check("VC.3 Dictate: words in the box through the stand-in, nothing sent, typing ends it, the popovers", async ({ url, viewport, layout, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const state = async () => (await seed(url, "A2")).find((s) => s.id === "plain-started");
  const log = () => mockEval("return voice.log();", url);
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await byTid(p, "composer").first().screenshot({ path: path.join(OUT, `VC.3-${viewport}-${name}.png`) }); } };
  const box = (p) => byTid(p, "composer-input").first();
  const text = async (p) => ((await box(p).textContent()) ?? "").replace(/ /g, " ");
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const idle = (p) => until(async () => (await sess(p)).phase === "idle");
  /** Records every text the box shows, in order (a MutationObserver on the box, so a short-lived guess is seen too). */
  const record = (p) => p.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-input"]');
    const seen = (window.__seen = [el.textContent]);
    new MutationObserver(() => { const t = el.textContent; if (seen[seen.length - 1] !== t) seen.push(t); }).observe(el, { childList: true, subtree: true, characterData: true });
  });
  const seen = (p) => p.evaluate(() => window.__seen.map((t) => t.replace(/ /g, " ")));
  const phone = layout === "phone";
  /** The phone's guesses: every text `dictate-guess` shows, in order (a MutationObserver on the page, as the guess comes and goes with its element). */
  const recordGuess = (p) => p.evaluate(() => {
    const seen = (window.__guesses = []);
    const look = () => { const g = document.querySelector('[data-testid="dictate-guess"]'); const t = g ? (g.textContent ?? "").trim() : ""; if (t && seen[seen.length - 1] !== t) seen.push(t); };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    look();
  });
  const guesses = (p) => p.evaluate(() => window.__guesses);
  /** Types at the END of the box: a press lands in the middle of the text, and the phone's box keeps the caret where it was pressed (the wide ones put it at the end). */
  const typeIn = async (p, s) => {
    await press(p, box(p));
    if (phone) await p.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await p.keyboard.type(s);
  };
  /** The Dictate control: in the row, or in the open "more" popup when the row has none. Presses it. */
  const pressDictate = async (p) => {
    // (a page just opened is still measuring its toolbar: the pair is drawn in the row until its width is kept, then placed. Wait for a place that stays.)
    let last = "";
    for (let i = 0; !phone && i < 40; i++) { // (the phone's toolbar has no "more" popup: Dictate is always in the row)
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, "voice-dictate").count()) { await press(p, byTid(p, "voice-dictate")); return "row"; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, "more-dictate").count(), 5000)) { fail("Dictate is neither in the row nor in the \"more\" popup"); return null; }
    await press(p, byTid(p, "more-dictate"));
    return "more";
  };
  const isOn = async (p) => {
    if (await byTid(p, "voice-dictate").count()) return (await byTid(p, "voice-dictate").getAttribute("data-on")) === "true";
    return (await sess(p)).owner?.kind === "dictation";
  };
  const fresh = async () => {
    await sleep(1000); // (the page of the section before saves its draft as it closes: that call is over before the seed is made anew)
    await mockEval("voice.reset();", url);
    const s = await state();
    const p = await openState(open, s, layout, 0);
    await useMic(p.page, note);
    await p.page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    // (the mock keeps a draft the box saved: an earlier section's text is not this one's)
    if (await text(p.page)) { await press(p.page, box(p.page)); await p.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a"); await p.page.keyboard.press("Backspace"); }
    return p;
  };

  // ---- the words
  {
    const { page, ctx } = await fresh();
    const calls = callsOf(page);
    await typeIn(page, "Note:");
    await record(page);
    if (phone) await recordGuess(page);
    await mockEval(`voice.script([
      { after: 2, partial: "hello" }, { after: 4, partial: "hello wor" }, { after: 6, committed: "hello world" },
      { after: 9, partial: "this is" }, { after: 11, committed: "this is a test" }]);`, url);
    const got = await pressDictate(page);
    note(`Dictate is in the ${got}`);
    if (!await until(async () => (await sess(page)).phase === "listening", 20000)) {
      fail(`Dictate did not start listening (the fake microphone or the socket): the session is ${J(await sess(page))}, the problem ${J(await page.evaluate(() => window.__aiwbVoice.state().problem))}`);
    } else {
      if ((await sess(page)).owner?.kind !== "dictation") fail(`the session is ${J((await sess(page)).owner)}, not dictation`);
      if (!await isOn(page)) fail("Dictate does not say it is on while listening");
      if (phone) { // the line over the text, and Send as the primary while it listens
        const line = byTid(page, "dictate-line");
        if (!await until(() => line.count(), 10000)) fail("the phone's box shows no dictate-line while it listens");
        else {
          const words = ((await line.first().textContent()) ?? "").replace(/\s+/g, " ");
          if (!words.includes("Listening…") || !words.includes("Tap the mic to end")) fail(`the dictate line says ${J(words)}, not "Listening…" and "Tap the mic to end"`);
        }
        if (!await byTid(page, "send").count() || await byTid(page, "voice-speech").count()) fail("while Dictate listens the primary is not Send");
      }
      if (!await until(async () => (await text(page)).includes("this is a test"), 20000)) fail(`the words never reached the box: it shows ${J(await text(page))}`);
      await shot(page, "1-words");
      const shown = await seen(page);
      if (shown[0] !== "Note:") fail(`the box began as ${J(shown[0])}, not the typed "Note:"`);
      if (phone) { // the guess is `dictate-guess`'s, never the box's: the box holds the typed text, then the finished words
        const g = await guesses(page);
        for (const guess of ["hello wor", "this is"]) if (!g.includes(guess)) fail(`dictate-guess never showed ${J(guess)}; it showed ${J(g)}`);
        for (const guess of ["Note: hello", "Note: hello wor", "Note: hello world this is"]) if (shown.includes(guess)) fail(`the box showed the guess ${J(guess)}; it showed ${J(shown)}`);
        if (!shown.includes("Note: hello world")) fail(`the box never showed the finished words "Note: hello world"; it showed ${J(shown)}`);
      } else for (const [guess, why] of [["Note: hello", "the first guess"], ["Note: hello wor", "the second guess"], ["Note: hello world", "the finished words"], ["Note: hello world this is", "the next guess"]]) {
        if (!shown.includes(guess)) fail(`the box never showed ${J(guess)} (${why}); it showed ${J(shown)}`);
      }
      if (shown.at(-1) !== "Note: hello world this is a test") fail(`the box ends as ${J(shown.at(-1))}, not "Note: hello world this is a test"`);
      if (shown.some((t) => /wor this|hello hello|world world/.test(t))) fail(`a guess was left behind in the box: ${J(shown)}`);
      // the silence: far longer than the pause of speech mode (1.2 s); dictation never sends, and does not end by itself
      await sleep(3500);
      if (calls.some((c) => c.method === "POST" && POST.test(c.path))) fail("a message was sent during dictation");
      if (!await isOn(page) || (await sess(page)).phase === "idle") fail("dictation ended by itself in the silence");
      if (await text(page) !== "Note: hello world this is a test") fail(`the box changed in the silence: ${J(await text(page))}`);
      // stop: Dictate again
      await pressDictate(page);
      if (!await idle(page)) fail("pressing Dictate again did not stop listening");
      if (await text(page) !== "Note: hello world this is a test") fail(`stopping changed the box: ${J(await text(page))}`);
      if (await isOn(page)) fail("Dictate still says it is on after it was stopped");
      if (phone && await byTid(page, "dictate-line").count()) fail("the dictate line stays after dictation was stopped");
      const stt = (await log()).filter((e) => e.kind === "stt");
      if (stt.length !== 1) fail(`the stand-in saw ${stt.length} listening sessions, not 1`);
      else {
        const e = stt[0];
        if (!(e.chunks >= 12)) fail(`the stand-in got ${e.chunks} chunks of audio (the script needed 12): the microphone's audio did not arrive`);
        if (e.sampleRates?.join() !== "16000") fail(`the audio is at ${J(e.sampleRates)} Hz, not 16000`);
        if (!(e.chunkMsMin >= 50 && e.chunkMsMax <= 400)) fail(`a chunk holds ${e.chunkMsMin} to ${e.chunkMsMax} ms of audio, not about 100 to 250`);
        if (e.problems?.length) fail(`the client broke the protocol: ${J(e.problems)}`);
        if (!e.keyHeader && !e.token) fail("the socket carried neither the key header nor a token");
        if (e.closeCode === undefined || e.closeCode === null) fail("the socket was not closed when dictation stopped");
        if (JSON.stringify(e).includes(KEY)) fail("the key is in the stand-in's log");
        const chunks = e.chunks;
        await sleep(600);
        const later = (await log()).filter((x) => x.kind === "stt")[0];
        if (later.chunks !== chunks) fail(`audio went up after dictation stopped (${chunks} chunks, then ${later.chunks})`);
      }
      // the person edits and presses Send: the message is the box's text
      await typeIn(page, " please");
      const send = byTid(page, "send").first();
      if (await send.isDisabled()) fail("Send is off with text in the box");
      else {
        const from = calls.length;
        await press(page, send);
        const sent = await until(() => calls.slice(from).find((c) => c.method === "POST" && POST.test(c.path)), 10000);
        if (!sent) fail("Send did not send the dictated text");
        else if (!J(sent.body ?? sent.postData ?? "").includes("Note: hello world this is a test please")) fail(`the message is ${J(sent.body ?? sent.postData)}, not the box's text`);
      }
    }
    await ctx.close();
  }

  // ---- typing ends dictation
  {
    const { page, ctx } = await fresh();
    await record(page);
    await mockEval(`voice.script([{ after: 2, partial: "first" }, { after: 4, committed: "first words" }, { after: 14, committed: "late words" }]);`, url);
    await pressDictate(page);
    if (phone) { // (an empty box: the primary stays Send while it listens, Talk would start speech mode over the dictation)
      if (!await until(() => byTid(page, "dictate-line").count(), 20000)) fail("the phone's box shows no dictate-line while it listens");
      if (!await byTid(page, "send").count() || await byTid(page, "voice-speech").count()) fail("an empty box that is dictated into does not keep Send as the primary");
    }
    if (!await until(async () => (await text(page)).includes("first words"), 20000)) fail(`no words came before the typing: the box shows ${J(await text(page))}`);
    else {
      await shot(page, "2-before-typing");
      await typeIn(page, "!");
      if (!await idle(page)) fail("typing in the box did not end dictation");
      await sleep(2500); // (the script's late words would have come by now)
      const t = await text(page);
      if (t !== "first words!") fail(`after typing the box is ${J(t)}, not "first words!" (it showed ${J(await seen(page))})`);
      if (await isOn(page)) fail("Dictate says it is on after typing ended it");
    }
    await ctx.close();
  }

  // ---- the popovers: no key, no microphone
  {
    const { page, ctx } = await fresh();
    await page.evaluate(() => window.__aiwbVoice.clearKey());
    await typeIn(page, "keep me");
    await pressDictate(page);
    const pop = byTid(page, "voice-problem");
    if (!await until(() => pop.count(), 10000)) fail("Dictate with no key shows no popover");
    else {
      if (await pop.getAttribute("data-kind") !== "no_key") fail(`the popover is of kind ${await pop.getAttribute("data-kind")}, not no_key`);
      const acts = (await pop.getByRole("button").allTextContents()).map((s) => s.trim()).filter(Boolean);
      if (phone) { // the one "Set up voice" sheet
        const body = ((await byTid(page, "voice-problem-text").textContent()) ?? "").trim();
        if (!/^Talk to .+, or dictate into the box, with your voice\.$/.test(body)) fail(`the sheet says ${J(body)}`);
        if (!(await pop.textContent()).includes("Set up voice")) fail(`the sheet has no title "Set up voice": ${J(await pop.textContent())}`);
        if (acts.join() !== "Open Settings › Voice,Not now") fail(`the sheet's buttons are ${acts.join()}`);
      } else {
        if (!(await pop.textContent()).includes("Voice needs your ElevenLabs key. It stays on this device.")) fail(`the popover says ${J(await pop.textContent())}`);
        if (acts.join() !== "Not now,Open Settings") fail(`the popover's buttons are ${acts.join()}`);
      }
      await shot(page, "3-nokey");
      await press(page, byTid(page, "voice-problem-dismiss"));
      if (!await until(async () => !await byTid(page, "voice-problem").count())) fail("Not now leaves the popover");
    }
    if ((await sess(page)).phase !== "idle") fail(`with no key the session is ${J(await sess(page))}`);
    if ((await log()).some((e) => e.kind === "stt" || e.kind === "token")) fail("with no key a socket or a token was asked for");
    if (await text(page) !== "keep me") fail(`the box is ${J(await text(page))}, not as it was`);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    await page.evaluate(() => window.__aiwbVoice.denyMic(true));
    await pressDictate(page);
    if (!await until(() => byTid(page, "voice-problem", { kind: "mic_blocked" }).count(), 10000)) fail("a blocked microphone shows no mic_blocked popover");
    else await shot(page, "4-mic-blocked");
    if (await text(page) !== "keep me") fail(`the box is ${J(await text(page))} after a blocked microphone`);
    await ctx.close();
  }
}, { viewports, page: false });
