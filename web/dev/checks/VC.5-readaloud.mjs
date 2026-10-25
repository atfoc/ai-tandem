// VC.5 (new, voice-chats P14): Read aloud on every message, on the mock with the stand-in voice service mounted at /voice (dev/voicestandin.mjs), at the
// desktop and the phone (where the action is a row of the message sheet a finger's hold opens: `openActs` of fork.mjs). Goal 3.3, 3.5, 3.8, 4.7, 6.2; architecture VC-24 and VC-25. What the stand-in's log says is the proof of what was sent.
//   the action       a mouse sees "Read aloud" in the bar over a message (`fk-act`, kind `read`), a finger in the "⋯" menu (the phone: the first row of the message sheet), on the person's message and the
//                    model's alike, and also where no fork action is (an archived chat); a reply still being written has none until it is done
//   what is said     the TTS texts sent for each message have no markdown mark, no link, no URL, no image and no code (Skip code blocks is on by default),
//                    and keep the words of the message; with "Skip code blocks" off the code is read; the stand-in saw nothing against the protocol
//   (voice devices D9: while a reading is paused, `voice-reading-continue` stands beside the `voice-reading` chip; VC.8 drives it, this check does not)
//   stop             while a message is read, the control says "End reading" and a chip (`voice-reading`) stays on the message when the pointer leaves
//                    it; both stop the reading, and the stand-in's open request is cancelled
//   one at a time    a Read aloud on another message stops the first at once (the first's open requests are cancelled, none of
//                    its later sentences is asked for) and then reads the second
//   playback         the first sound is written to the player while the stand-in is still producing the first sentence
//   no key           Read aloud shows the "needs your key" popover on the message, which stays when the pointer leaves, and asks the service for nothing
// OUT=/tmp/x keeps a screenshot in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, check, hostCall, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, touchNow } from "./sel.mjs";
import { actsIn, openActs, pressAct, still } from "./fork.mjs";

export const viewports = ["desktop", "phone"];

const OUT = process.env.OUT;
const CHAT = "c_A4_turns";
const KEY = "sk_test_P14CANARY9";
const MSG = '[data-testid="msg"]';
const ASK = [
  "**Please** read [the docs](https://docs.example.com/guide) and run `npm test` first.",
  "Look at https://raw.example.com/page for the rest.",
  "",
  "```sh",
  "npm run secretcode",
  "```",
  "",
  "Then _tell me_ what you think.",
].join("\n");
const ANSWER = [
  "# The plan",
  "",
  "First, **fix** the _config_ in [the guide](https://guide.example.com/config).",
  "Then run this:",
  "",
  "```js",
  "const codeSecret = readTheFile(\"x\");",
  "```",
  "",
  "- check the first item",
  "- check the second item",
  "",
  "See ![a diagram](https://img.example.com/d.png) for more.",
  "All done now, thank you very much.",
].join("\n");
// What may never reach the voice service: a mark, a link, a URL, an image, the code.
const MARKS = /[*_`#\[\]<>]|\]\(|https?:|:\/\/|example\.com|diagram/;

await check("VC.5 Read aloud: on both messages, cleaned, stopped, one at a time, playing early", async ({ url, viewport, layout, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const log = () => mockEval("return voice.log();", url);
  const tts = async () => (await log()).filter((e) => e.kind === "tts");
  const knob = (code) => mockEval(code, url);
  const state = (p) => p.evaluate(() => window.__aiwbVoice.state());
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.5-${viewport}-${name}.png`) }); } };
  const idle = (p, ms = 60000) => until(async () => (await state(p)).reading.key === null && !(await byTid(p, "voice-reading").count()), ms);
  const msgOf = (p, role, text) => byTid(p, "msg", { role }).filter({ hasText: text }).last();
  const itemOf = async (loc) => +(await loc.getAttribute("data-item"));
  const openApp_ = async (o = {}) => {
    await seed(url, "A4");
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: MSG, ...o });
    await page.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbSend, null, { timeout: 30000 });
    return { page, ctx };
  };
  const send = async (p, text, reply) => {
    await knob(`flags.reply = ${JSON.stringify(reply)};`);
    await p.evaluate(([c, t]) => { void window.__aiwbSend(c, t); }, [CHAT, text]);
  };
  const reading = async (p, loc) => {
    const o = await openActs(p, loc);
    const acts = await actsIn(p, o.scope);
    await o.close();
    return acts.find((a) => a.kind === "read") ?? null;
  };

  // ---- the first page: a chat to read, no key yet
  {
    const { page, ctx } = await openApp_();
    // the person's message and the model's reply, the reply streaming slowly so that its middle can be looked at
    await send(page, ASK, { text: ANSWER, parts: 6, pace: 900 });
    const user = await until(async () => (await msgOf(page, "user", "secretcode").count()) > 0);
    if (!user) fail("the message sent by the check did not appear");
    const mine = msgOf(page, "user", "secretcode"), reply = byTid(page, "msg", { role: "assistant", streaming: true }).last();
    await reply.waitFor({ state: "attached", timeout: 15000 });
    // a reply being written has no Read aloud; once it is done it has
    const wr = await reading(page, reply).catch(() => null);
    if (wr) fail(`a reply that is still being written offers ${JSON.stringify(wr)}`);
    await until(async () => (await byTid(page, "msg", { role: "assistant", streaming: true }).count()) === 0, 30000);
    const done = msgOf(page, "assistant", "All done now");
    if (!await until(async () => !!(await reading(page, done).catch(() => null)), 8000)) fail("a finished reply offers no Read aloud");

    // ---- the action on both messages: its words, and what the bar / menu holds
    const ru = await reading(page, mine), ra = await reading(page, done);
    for (const [who, r] of [["the person's message", ru], ["the model's reply", ra]]) {
      if (!r) { fail(`${who} offers no Read aloud`); continue; }
      if (r.text !== "Read aloud") fail(`${who}'s action says "${r.text}", not "Read aloud"`);
      if (r.disabled) fail(`${who}'s Read aloud is disabled`);
    }
    const opened = await openActs(page, done);
    const kinds = (await actsIn(page, opened.scope)).map((a) => a.kind);
    // (the wide bar and menu end with Read aloud; the phone's message sheet (T1) opens with it, above the fork actions)
    if (kinds[opened.sheet ? 0 : kinds.length - 1] !== "read") fail(`Read aloud is not the ${opened.sheet ? "first" : "last"} of the reply's actions (${kinds.join()})`);
    await shot(page, "1-actions");
    await opened.close();

    // ---- no key: the popover on the message, no request
    await knob("voice.reset();");
    await pressAct(page, done, "read");
    if (!await until(async () => !!(await byTid(page, "voice-problem").count()))) fail("Read aloud with no key shows no popover");
    else {
      if (await byTid(page, "voice-problem").getAttribute("data-kind") !== "no_key") fail(`the popover is "${await byTid(page, "voice-problem").getAttribute("data-kind")}", not the one for no key`);
      // (the phone's sheet, V1: "Set up voice", the body that says what voice is for, and the note that the ElevenLabs key is needed and stays on this device)
      const said = ((await byTid(page, "voice-problem-text").textContent()) ?? "").trim();
      if (layout === "phone" ? !/^Talk to .+, or dictate into the box, with your voice\.$/.test(said) || !(await byTid(page, "voice-problem").first().textContent()).includes("Add your ElevenLabs API key once; it stays on this device")
        : said !== "Voice needs your ElevenLabs key. It stays on this device.") fail(`the popover does not say the key is needed (${JSON.stringify(said)})`);
      if (!await touchNow(page)) { await page.mouse.move(2, 2); await sleep(200); }
      if (!await byTid(page, "voice-problem").count()) fail("the popover went when the pointer left the message");
      // (on the phone the popover is a sheet from the bottom: it hangs from nothing)
      const box = await byTid(page, "voice-problem").first().boundingBox(), at = await done.boundingBox();
      if (layout !== "phone" && box && at && (box.y > at.y + at.height + 4 || box.y + box.height < at.y - 4)) fail(`the popover (y ${Math.round(box.y)}) is not next to the message (y ${Math.round(at.y)})`);
      await shot(page, "2-nokey");
      await page.waitForTimeout(100);
      await press(page, byTid(page, "voice-problem-dismiss"));
      await until(async () => !(await byTid(page, "voice-problem").count()));
    }
    if ((await log()).length) fail(`Read aloud with no key asked the service for something: ${JSON.stringify((await log()).map((e) => e.kind))}`);
    if ((await state(page)).reading.key !== null) fail("a message is marked as read after the refusal");

    // ---- an archived chat: nothing of forking but Label, and Read aloud
    await hostCall(url, "POST", `/api/chats/${CHAT}/archive`);
    await page.waitForTimeout(400);
    const arch = await reading(page, done).catch(() => null);
    if (!arch) fail("an archived chat's reply offers no Read aloud");
    const ao = await openActs(page, done);
    const akinds = (await actsIn(page, ao.scope)).map((a) => a.kind).sort().join();
    await ao.close();
    if (akinds !== "label,read") fail(`an archived chat's reply offers ${akinds}, not Label and Read aloud`);
    await hostCall(url, "POST", `/api/chats/${CHAT}/unarchive`);
    await ctx.close();
  }

  // ---- the second page: the key is set, Skip code blocks is on (the default)
  {
    const { page, ctx } = await openApp_();
    await send(page, ASK, { text: ANSWER, parts: 3, pace: 100 });
    const mine = msgOf(page, "user", "secretcode"), done = msgOf(page, "assistant", "All done now");
    await done.waitFor({ state: "attached", timeout: 20000 });
    await until(async () => (await byTid(page, "msg", { role: "assistant", streaming: true }).count()) === 0, 30000);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    if ((await page.evaluate(() => window.__aiwbVoice.settings().skipCode)) !== true) fail("Skip code blocks is not on by default");

    const readOnce = async (loc) => {
      await knob("voice.reset();");
      await pressAct(page, loc, "read");
      await until(async () => (await state(page)).reading.key !== null, 8000);
      await shot(page, "3-reading");
      if (!await until(async () => !!(await byTid(page, "voice-reading").count()), 5000)) fail("no chip shows that a message is being read");
      await idle(page);
      return (await tts()).map((e) => e.text);
    };
    const checkClean = (who, texts, words, banned) => {
      if (!texts.length) { fail(`${who}: no TTS request was made`); return; }
      const all = texts.join(" ");
      if (MARKS.test(all)) fail(`${who}: the text sent has a mark, a link or an image: ${JSON.stringify(texts)}`);
      for (const w of banned) if (all.includes(w)) fail(`${who}: the text sent has "${w}": ${JSON.stringify(texts)}`);
      for (const w of words) if (!all.includes(w)) fail(`${who}: the text sent lacks "${w}": ${JSON.stringify(texts)}`);
    };
    const userTexts = await readOnce(mine);
    checkClean("the person's message", userTexts, ["Please read the docs", "npm test", "tell me what you think"], ["secretcode", "npm run"]);
    const replyTexts = await readOnce(done);
    checkClean("the model's reply", replyTexts, ["The plan", "fix the config in the guide", "check the first item", "check the second item", "All done now"], ["codeSecret", "readTheFile"]);
    if ((await log()).some((e) => e.problems?.length)) fail(`the stand-in saw the client break the protocol: ${JSON.stringify((await log()).filter((e) => e.problems?.length).map((e) => e.problems))}`);
    if (JSON.stringify(await log()).includes("P14CANARY")) fail("the key reached the log other than as a header");
    // it ran to its end by itself: nothing is left marked as read
    if ((await state(page)).reading.key !== null || await byTid(page, "voice-reading").count()) fail("a reading that ended leaves the chip or the mark");
    const ids = { user: await itemOf(mine), reply: await itemOf(done) };

    // ---- the sound starts before the stand-in has finished the sentence; End reading ends it, and the open request is cancelled
    await knob("voice.reset(); voice.pace({ chunkMs: 300, chunks: 10 });");
    const w0 = await page.evaluate(() => window.__aiwbVoice.player().writes);
    await pressAct(page, done, "read");
    let early = null;
    await until(async () => {
      if ((await page.evaluate(() => window.__aiwbVoice.player().writes)) <= w0) return false;
      early = await tts();
      return true;
    }, 20000);
    if (!early?.length) fail("nothing was written to the player");
    else if (early[0].finishedAt !== null || early[0].chunks >= 10) fail(`the first sound was written only after the stand-in had finished the first sentence (chunks ${early[0].chunks}, finishedAt ${early[0].finishedAt})`);
    // the chip and the control both say End reading, with the pointer away
    if (!await touchNow(page)) { await page.mouse.move(2, 2); await sleep(150); }
    const chip = byTid(page, "voice-reading");
    if (!await until(async () => !!(await chip.count()), 5000)) fail("no chip shows the message being read");
    else {
      if (((await chip.first().textContent()) ?? "").trim() !== "End reading") fail(`the chip says "${await chip.first().textContent()}"`);
      if (await byTid(done, "voice-reading").count() !== 1) fail("the chip is not on the message that is read");
      await shot(page, "4-chip");
    }
    const during = await reading(page, done);
    if (during?.text !== "End reading") fail(`the control of a message being read says "${during?.text}", not "End reading"`);
    await press(page, chip.first());
    if (!await idle(page, 8000)) fail("the chip does not stop the reading");
    // (the player's own stop is counted only while sound is queued, and a slow stand-in lets the queue run dry: what is proved here is that nothing more is written)
    const wStop = await page.evaluate(() => window.__aiwbVoice.player().writes);
    await until(async () => (await tts()).every((e) => e.finishedAt !== null || e.cancelled), 8000);
    const open1 = (await tts()).filter((e) => e.finishedAt === null);
    if (open1.length === 0 || open1.some((e) => !e.cancelled)) fail(`End reading left a request open: ${JSON.stringify((await tts()).map((e) => [e.chunks, e.finishedAt !== null, e.cancelled]))}`);
    const after = (await tts()).length;
    await sleep(800);
    if ((await tts()).length !== after) fail("a sentence was asked for after the reading was stopped");
    if ((await page.evaluate(() => window.__aiwbVoice.player().writes)) !== wStop) fail("sound was still written to the player after the reading was stopped");
    const afterReading = await reading(page, done);
    if (afterReading?.text !== "Read aloud") fail(`after the stop the control says "${afterReading?.text}"`);

    // the control of the bar stops it too
    await knob("voice.reset();");
    await pressAct(page, done, "read");
    await until(async () => (await state(page)).reading.key !== null, 8000);
    await pressAct(page, done, "read");
    if (!await idle(page, 8000)) fail("the control that says End reading does not stop it");

    // ---- one at a time: another message's Read aloud stops the first
    await knob("voice.reset(); voice.pace({ chunkMs: 300, chunks: 10 });");
    await pressAct(page, done, "read");
    await until(async () => (await tts()).length > 0, 20000);
    await until(async () => (await state(page)).reading.key?.endsWith(`:${ids.reply}`) === true, 5000);
    await pressAct(page, mine, "read");
    await until(async () => (await state(page)).reading.key?.endsWith(`:${ids.user}`) === true, 8000);
    if ((await state(page)).reading.key?.endsWith(`:${ids.user}`) !== true) fail(`the reading is of ${(await state(page)).reading.key}, not the person's message`);
    await until(async () => (await tts()).some((e) => replyTexts.indexOf(e.text) < 0), 20000);
    await sleep(500);
    const now = await tts();
    const first = now.filter((e) => replyTexts.includes(e.text)), second = now.filter((e) => userTexts.includes(e.text));
    if (!first.length || !second.length) fail(`the log lacks one of the two readings: ${JSON.stringify(now.map((e) => e.text))}`);
    else {
      const t2 = Math.min(...second.map((e) => e.startedAt));
      for (const e of first) {
        if (e.startedAt > t2) fail(`a sentence of the first message was asked for after the second began: "${e.text}"`);
        if (e.finishedAt === null && !e.cancelled) fail(`a request of the first message is still open: "${e.text}"`);
        if (e.finishedAt !== null && e.finishedAt > t2 + 50) fail(`a request of the first message finished after the second began: "${e.text}"`);
      }
      if (first.length >= replyTexts.length) fail("every sentence of the first message was asked for before it was stopped (the check cannot tell a stop)");
      if (second.some((e) => e.startedAt < t2)) fail("the second reading's requests start out of order");
    }
    if (await byTid(done, "voice-reading").count()) fail("the first message still shows the chip");
    if (await byTid(mine, "voice-reading").count() !== 1) fail("the second message does not show the chip");
    await shot(page, "5-second");
    await pressAct(page, mine, "read");
    await idle(page, 8000);
    await ctx.close();
  }

  // ---- the third page: Skip code blocks is off, and the code is read
  {
    await seed(url, "A4");
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: MSG, ls: { "aiwb.voice.settings": JSON.stringify({ skipCode: false }) } });
    await page.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbSend, null, { timeout: 30000 });
    if ((await page.evaluate(() => window.__aiwbVoice.settings().skipCode)) !== false) fail("the setting that the page was opened with is not kept");
    await send(page, ASK, { text: ANSWER, parts: 3, pace: 100 });
    const mine = msgOf(page, "user", "secretcode"), done = msgOf(page, "assistant", "All done now");
    await done.waitFor({ state: "attached", timeout: 20000 });
    await until(async () => (await byTid(page, "msg", { role: "assistant", streaming: true }).count()) === 0, 30000);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    for (const [who, loc, code, words] of [["the person's message", mine, ["npm run secretcode"], ["Please read the docs"]], ["the model's reply", done, ["codeSecret", "readTheFile"], ["check the first item"]]]) {
      await knob("voice.reset();");
      await pressAct(page, loc, "read");
      await until(async () => (await state(page)).reading.key !== null, 8000);
      await until(async () => (await tts()).length >= 3, 20000);
      const all = (await tts()).map((e) => e.text).join(" ");
      for (const c of code) if (!all.includes(c)) fail(`with Skip code blocks off, ${who}'s code is not read: "${c}" is not in ${JSON.stringify(all)}`);
      for (const w of words) if (!all.includes(w)) fail(`with Skip code blocks off, ${who}'s words lose "${w}"`);
      if (/[*`#\[\]]|https?:|example\.com/.test(all)) fail(`with Skip code blocks off, ${who}'s text has a mark or a link: ${JSON.stringify(all)}`);
      await pressAct(page, loc, "read");
      await idle(page, 8000);
    }
    await ctx.close();
  }
  note("Read aloud in the bar and the menu of both messages (and of an archived chat's), none on a reply being written; the texts sent have no mark, link, URL, image or code (code read with Skip code blocks off); the chip and the control stop it and cancel the open request; another message's Read aloud stops the first and none of its later sentences is asked for; the first sound before the stand-in ends the sentence; no key: the popover on the message and no request");
}, { viewports, page: false, allowConsole: [/the mock failed this read|tree/i] });
