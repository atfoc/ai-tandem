// VC.8 (new, voice-devices D10): the microphone and the speaker that voice uses, on the mock with the stand-in voice service mounted at /voice
// (dev/voicestandin.mjs) and the stand-in devices of devices.mjs (two microphones, "Desk Mic" at 300 Hz and "Stand-in Headset" at 700 Hz; two speakers,
// "Desk Speakers", public, and "Stand-in Headphones", private; they can be plugged in and out while the page runs), at the desktop, the tablet and
// the phone. Voice-devices goal 6.1 to 6.4 and 4.7; architecture §12.2, VD-8 to VD-16. The stand-in devices take the place of the browser's own
// (no fake microphone is needed, mic.mjs is not used): the microphone is an oscillator at the device's frequency, so what the stand-in voice service
// hears (`toneHz`, `toneHzLast` of an `stt` entry of its log) says which microphone the audio came from; a speaker is the sink an AudioContext was
// given (`__aiwbDevices.sinks()`), and every `setSinkId` call is on record.
//   choosing 6.1   nothing chosen: the page lists no device and opens nothing before Settings opens (a session lists once at its start, and is not
//                  counted); Dictation, Speech mode and Read aloud use the system default for both (the first microphone's tone, no `setSinkId`) with no
//                  notice. Before the microphone is allowed both pickers hold System default alone and the card says why; Test microphone asks and the
//                  lists fill, System default first and then the two devices; a pick is the voice setting and is kept over a reload; then Dictation and
//                  Speech mode open the chosen microphone (`opened()`: only it) and the stand-in service hears its tone, Read aloud and Speech mode play
//                  on the chosen sink (and on the other never); the voice pill opens the chosen microphone too. The names and ids of the devices are in
//                  no request of the page (the mock, the socket), no console line and nothing the voice service logged
//   checking 6.2   Test speaker writes its sound to the player with the chosen sink and the stand-in service sees no request; Test microphone's
//                  meter moves (`vs-mic-level` carries a peak), nothing is sent (no socket, no token), and it stops, the microphone released, when
//                  Settings closes; a device plugged in or out while Settings is open changes both pickers
//   missing 6.3    the saved microphone unplugged: Dictation starts on the default and `voice-notice` names the missing device; Settings still shows it,
//                  "(not connected)", and it is still the saved choice; plugged in again, the next Dictation uses it with no notice. The same for the
//                  speaker (Read aloud), for both at once (one notice), and with the saved microphone gone and no microphone at all: the way it ends
//                  today, the mic_blocked popover
//   settings 4.5   Test speaker and Test microphone on a saved device that is not there say so in the devices card (`vs-devices-notice`, the start
//                  sentence, kept after the chime ends, gone on its timer and when Settings closes, never in a chat); the choice stays. 6.6: with no key
//                  saved the card (`vs-devices-nokey`) offers no picker and Settings makes no `enumerateDevices` call; the saved key brings the pickers
//   lost 6.4       a public speaker unplugged while Speech mode speaks: `setSinkId("")` at once, a notice, the session goes on, no sentence is asked
//                  for twice and no mark is played twice, and the device plugged in again in the middle does not move the sound; a microphone
//                  unplugged while Dictation listens: the default is opened, the words in the box stay, a notice, the words that come later arrive, the
//                  stand-in service hears the default's tone from then on (`toneHzLast`) in the same session; with no microphone left the session
//                  ends with the mic_blocked popover; private headphones unplugged while a reply is spoken: the session pauses (the context is
//                  suspended, nothing comes out loud) with its reason and Continue on the speech bar, on the pill's orb and in Read aloud's chip, and
//                  Continue goes on. After each, a typed message still sends and a new session works
// OUT=/tmp/x keeps a screenshot of the page in the states that have a new look there, for a person's look. ONLY=choose,missing runs the scenarios named
// (nothing, choose, check, missing, settingsnotice, nokey, mic, speaker, pause, pill).
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { installDevices } from "./devices.mjs";
import { pressAct } from "./fork.mjs";
import { byTid, openBoard, openChat, press, showList, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const KEY = "sk_test_VC8CANARY1";
const CHAT = "c_plain", BOARD = "b_ui";
const MSG = /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages(\?|$)/;
const ANSWER = "Here is the plan. First we draw the boxes. Then we connect them with arrows. That is all.";
const SLOW = "One is the first sentence. Two is the second sentence. Three is the third sentence. Four is the fourth sentence. Five is the fifth sentence.";
const J = JSON.stringify;
const HEADSET = { id: "mic-headset", name: "Stand-in Headset" };
const SPEAKERS = { id: "out-desk", name: "Desk Speakers" }, PHONES = { id: "out-headphones", name: "Stand-in Headphones" };
const MIC_HEADSET = { kind: "input", id: "mic-headset", label: "Stand-in Headset", hz: 700 };
const MIC_DESK = { kind: "input", id: "mic-desk", label: "Desk Mic", hz: 300 };
const OUT_PHONES = { kind: "output", id: "out-headphones", label: "Stand-in Headphones" };
const OUT_DESK = { kind: "output", id: "out-desk", label: "Desk Speakers" };
const NAMES = ["Desk Mic", "Stand-in Headset", "Desk Speakers", "Stand-in Headphones", "mic-desk", "mic-headset", "out-desk", "out-headphones"];

await check("VC.8 voice devices: choosing, checking, missing at the start, lost during a session", async ({ url, viewport, layout, open, fail, note }) => {
  const wide = layout !== "phone";
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const log = () => mockEval("return voice.log();", url);
  const stt = async () => (await log()).filter((e) => e.kind === "stt");
  const tts = async () => (await log()).filter((e) => e.kind === "tts");
  const knob = (code) => mockEval(code, url);
  const script = (steps) => knob(`voice.script(${J(steps)}); return 1;`);
  const reply = (text, parts = 4, pace = 100) => knob(`flags.reply = { text: ${J(text)}, parts: ${parts}, pace: ${pace} }; return 1;`);
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.8-${viewport}-${name}.png`) }); } };
  const shown = (loc, ms = 15000) => until(() => loc.first().isVisible().catch(() => false), ms);
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const box = (p) => byTid(p, "composer-input").first();
  const text = async (p) => ((await box(p).textContent()) ?? "").replace(/ /g, " ");
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const vstate = (p) => p.evaluate(() => window.__aiwbVoice.state());
  const settings = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const phaseIs = (p, ph, ms = 20000) => until(async () => (await sess(p)).phase === ph, ms);
  const dev = (p, fn, ...args) => p.evaluate(([f, a]) => window.__aiwbDevices[f](...a), [fn, args]);
  const opened = (p) => dev(p, "opened");
  const sinks = (p) => dev(p, "sinks");
  const usedSinks = async (p) => (await sinks(p)).flatMap((s) => s.calls);
  /** The system default, as the stand-in answers it: no id asked for, or the pseudo id. */
  const isDefault = (o) => o.requested === null || o.requested === "default" || o.requested === "communications";
  const near = (hz, want) => typeof hz === "number" && Math.abs(hz - want) < 200; // (the tones are 400 Hz apart; the service counts zero crossings, which is not exact)
  const typeIn = async (p, s) => { await press(p, box(p)); await p.keyboard.type(s); };
  const clearBox = async (p) => { await press(p, box(p)); await p.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a"); await p.keyboard.press("Backspace"); };
  const posts = (calls, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && MSG.test(c.path));
  const msgOf = (p, role, t) => byTid(p, "msg", { role }).filter({ hasText: t }).last();

  /** In the page: every notice the engine showed (its text, once each, in order) and every text of `voice-notice` on screen. */
  const watchNotices = (p) => p.evaluate(() => {
    const seen = (window.__notices = []);
    setInterval(() => {
      const n = window.__aiwbVoice.notice();
      if (n && !seen.includes(n.text)) seen.push(n.text);
      for (const e of document.querySelectorAll('[data-testid="voice-notice"], [data-testid="caption-notice"]')) { const t = e.textContent.replace(/\s+/g, " ").trim(); if (t && !seen.includes(t)) seen.push(t); }
    }, 25);
  });
  const notices = (p) => p.evaluate(() => window.__notices);
  /** What the page sent or showed, as text, to look for the devices' names in: every request (address and body), every socket frame, every console line. */
  const spy = (p) => {
    const hits = [];
    p.on("request", (r) => hits.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`));
    p.on("console", (m) => hits.push(`console ${m.text()}`));
    p.on("websocket", (ws) => {
      ws.on("framesent", (f) => { if (typeof f.payload === "string") hits.push(`ws> ${f.payload.slice(0, 4000)}`); });
      ws.on("framereceived", (f) => { if (typeof f.payload === "string") hits.push(`ws< ${f.payload.slice(0, 4000)}`); });
    });
    return hits;
  };

  /** A page of the app with the stand-in devices in it. `at`: "chat" (the plain chat) or "board" (the board with the pill). `settings`: voice settings
   *  the page starts with (devices chosen). `devices`: installDevices's options. */
  const start = async ({ at = "chat", settings: s = {}, devices = {}, key = true } = {}) => {
    await sleep(600); // (the page of the scenario before saves its draft as it closes)
    await knob("voice.reset(); flags.reply = undefined; return 1;");
    await seed(url, "A2");
    const ls = { "aiwb.voice.settings": J({ autoSend: true, pauseMs: 600, ...s }) };
    const sel = at === "chat" ? { chat: CHAT } : { board: BOARD, chat: null };
    const wait = at === "chat" ? tidSel("send") : tidSel("board-canvas", { board: BOARD });
    const o = await open({ sel, ls, wait });
    const page = o.page;
    await installDevices(o.ctx, devices);
    const hits = spy(page);
    await page.reload();
    await page.waitForSelector(wait, { timeout: 30000 });
    await page.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbDevices && !!window.__aiwbSend, null, { timeout: 30000 });
    await watchNotices(page);
    if (key) await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    if (at === "chat" && await text(page)) await clearBox(page); // (the mock keeps a draft the box saved)
    return { ...o, hits, calls: callsOf(page) };
  };
  const ran = [];
  const scenario = async (name, opts, body) => {
    if (ONLY && !ONLY.includes(name)) return;
    let p = null;
    try {
      p = await start(opts);
      await body(p);
      ran.push(name);
    } catch (e) {
      fail(`${name}: ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
    } finally { await p?.ctx.close().catch(() => {}); }
  };

  /** The Dictate or Speech mode control: in the row, or in the open "more" popup when the row has no room. Presses it. */
  const pressVoice = async (p, which) => {
    let last = "";
    for (let i = 0; i < 40; i++) { // (a page just opened is still measuring its toolbar: wait for a place that stays)
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, `voice-${which}`).count()) { await press(p, byTid(p, `voice-${which}`)); return; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, `more-${which}`).count(), 5000)) throw new Error(`${which} is neither in the row nor in the "more" popup`);
    await press(p, byTid(p, `more-${which}`));
  };
  const toggleDictate = (p) => pressVoice(p, "dictate");
  /** Starts Dictation with the words scripted; waits for it to listen. Answers the index of its entry in the stand-in's log. */
  const dictate = async (p, steps = [{ after: 3, committed: "hello there" }]) => {
    await script(steps);
    const n = (await stt()).length;
    await toggleDictate(p);
    if (!await phaseIs(p, "listening")) throw new Error(`Dictation did not start listening: ${J(await sess(p))}, the problem ${J((await vstate(p)).problem)}`);
    return n;
  };
  const stopDictate = async (p) => { await toggleDictate(p); if (!await phaseIs(p, "idle", 10000)) throw new Error("Dictate again did not stop the session"); };
  /** Starts Speech mode (Auto-send on, the pause short) and waits for it to listen. */
  const speech = async (p, steps = [{ after: 3, committed: "what is the plan" }]) => {
    await script(steps);
    const n = (await stt()).length;
    await pressVoice(p, "speech");
    if (!await phaseIs(p, "listening")) throw new Error(`Speech mode did not start listening: ${J(await sess(p))}, the problem ${J((await vstate(p)).problem)}`);
    return n;
  };
  const endSpeech = async (p) => { await press(p, byTid(p, "speech-end")); if (!await phaseIs(p, "idle", 10000)) throw new Error("End did not end the session"); await gone(byTid(p, "speech-bar")); };
  /** The tone the stand-in service heard in the session `n` of its log (waits for one to be heard). */
  const toneOf = async (n, key = "toneHz") => { await until(async () => (await stt())[n]?.[key] != null, 20000); return (await stt())[n]?.[key] ?? null; };
  /** A message the assistant wrote, to read aloud. */
  const writeReply = async (p, t = ANSWER, parts = 3, pace = 100) => {
    await reply(t, parts, pace);
    await p.evaluate(([c, q]) => { void window.__aiwbSend(c, q); }, [CHAT, "tell me"]);
    const last = t.split(". ").at(-1).replace(/\.$/, "");
    const done = msgOf(p, "assistant", last);
    await done.waitFor({ state: "attached", timeout: 30000 });
    await until(async () => (await byTid(p, "msg", { role: "assistant", streaming: true }).count()) === 0, 30000);
    return done;
  };
  const readAloud = async (p, msg) => { await pressAct(p, msg, "read"); };
  const reading = (p) => until(async () => (await vstate(p)).reading.key !== null, 10000);
  const stopReading = async (p) => {
    if (await byTid(p, "voice-reading").count()) await press(p, byTid(p, "voice-reading").first());
    await until(async () => (await vstate(p)).reading.key === null && !(await byTid(p, "voice-reading").count()), 10000);
  };
  const readingIdle = (p, ms = 60000) => until(async () => (await vstate(p)).reading.key === null && !(await byTid(p, "voice-reading").count()), ms);
  /** After a loss: a typed message still sends and a new session works (goal 6.4). */
  const stillWorks = async (p, calls, what) => {
    if ((await sess(p)).phase !== "idle") throw new Error(`${what}: a session is still on`);
    if (await box(p).count() === 0 || !await shown(box(p), 5000)) { fail(`${what}: the box is not back`); return; }
    await press(p, box(p));
    await p.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await p.keyboard.type(`typed after ${what}`);
    const from = calls.length;
    await press(p, byTid(p, "send").first());
    if (!await until(() => posts(calls, from)[0], 15000)) fail(`${what}: a typed message was not sent`);
    const n = await dictate(p, [{ after: 3, committed: "and again" }]).catch((e) => { fail(`${what}: a new session does not start: ${e.message}`); return null; });
    if (n !== null) {
      if (!await until(async () => (await text(p)).includes("and again"), 20000)) fail(`${what}: a new Dictation brought no words: the box shows ${J(await text(p))}`);
      await stopDictate(p);
    }
  };

  /** Settings: the sidebar's gear (the phone's list first). Closing brings the chat back (the phone left it). */
  const openSettings = async (p) => {
    await showList(p);
    await press(p, byTid(p, "settings-btn").first());
    if (!await shown(byTid(p, "settings-dialog"))) throw new Error("the Settings button opened no dialog");
  };
  const closeSettings = async (p, chat = true) => {
    await press(p, byTid(p, "vs-close"));
    if (!await gone(byTid(p, "settings-dialog"))) fail("Close left Settings open");
    if (chat) await openChat(p, CHAT);
  };
  const menuTexts = async (p, picker) => {
    await press(p, byTid(p, picker));
    await shown(byTid(p, "menu-item"));
    const items = (await byTid(p, "menu-item").allTextContents()).map((x) => x.replace(/✓/g, "").trim());
    await p.keyboard.press("Escape");
    await gone(byTid(p, "menu"));
    return items;
  };
  const pickShown = async (p, picker) => (await textOf(byTid(p, picker))).replace(/▾/g, "").trim();
  const pick = async (p, picker, label) => {
    await press(p, byTid(p, picker));
    const item = byTid(p, "menu-item").filter({ hasText: label }).first();
    if (!await shown(item)) throw new Error(`${picker}: no menu item "${label}"`);
    await press(p, item);
    await gone(byTid(p, "menu"));
  };

  // ---- 6.1: nothing chosen is the system default, with no notice and no listing
  await scenario("nothing", { settings: {} }, async (p) => {
    const { page, calls } = p;
    const c0 = await dev(page, "calls");
    if (c0.enumerateDevices !== 0 || c0.getUserMedia !== 0 || c0.setSinkId !== 0) fail(`a page that never used voice made device calls on load: ${J(c0)}`);
    await typeIn(page, "just typing");
    const from = calls.length;
    await press(page, byTid(page, "send").first());
    if (!await until(() => posts(calls, from)[0], 15000)) fail("a typed message was not sent");
    await sleep(1000);
    const c1 = await dev(page, "calls");
    if (c1.enumerateDevices !== 0 || c1.getUserMedia !== 0 || c1.setSinkId !== 0) fail(`typing and sending made device calls: ${J(c1)}`);
    if ((await settings(page)).mic !== null || (await settings(page)).speaker !== null) fail(`nothing was chosen and the settings hold ${J([(await settings(page)).mic, (await settings(page)).speaker])}`);
    // Dictation on the default: the first microphone's tone, no notice
    const n = await dictate(page);
    const o1 = (await opened(page)).at(-1);
    if (!o1 || !isDefault(o1) || o1.deviceId !== "mic-desk") fail(`with nothing chosen Dictation opened ${J(o1)}, not the system default (the first microphone)`);
    if (!near(await toneOf(n), 300)) fail(`with nothing chosen the stand-in service heard ${await toneOf(n)} Hz, not the default microphone's 300`);
    if (!await until(async () => (await text(page)).includes("hello there"), 20000)) fail(`Dictation's words never reached the box: ${J(await text(page))}`);
    await stopDictate(page);
    // Speech mode and Read aloud on the default
    const s = await speech(page);
    if (!near(await toneOf(s), 300)) fail(`Speech mode with nothing chosen: the stand-in service heard ${await toneOf(s)} Hz, not 300`);
    await reply(ANSWER, 4, 100);
    if (!await until(async () => (await tts()).length >= 4, 40000)) fail(`only ${(await tts()).length} of the reply's sentences were spoken in Speech mode`);
    await phaseIs(page, "listening", 40000);
    await endSpeech(page);
    const done = msgOf(page, "assistant", "That is all");
    if (!await until(async () => (await done.count()) > 0, 20000)) fail("the spoken turn's reply is not in the thread");
    else {
      await knob("voice.reset(); return 1;");
      await readAloud(page, done);
      await reading(page);
      if (!await until(async () => (await tts()).length >= 1, 20000)) fail("Read aloud asked the voice service for nothing");
      await readingIdle(page);
    }
    const used = await dev(page, "calls");
    if (used.setSinkId !== 0) fail(`with no speaker chosen the page called setSinkId ${used.setSinkId} time(s): ${J(await usedSinks(page))}`);
    if ((await opened(page)).some((x) => !isDefault(x))) fail(`a microphone was asked for by id with none chosen: ${J(await opened(page))}`);
    const seen = await notices(page);
    if (seen.length) fail(`with nothing chosen a notice was shown: ${J(seen)}`);
    // (a session lists once at its start, so the count after sessions is not asserted) Settings lists when it opens
    const before = (await dev(page, "calls")).enumerateDevices;
    await openSettings(page);
    if (!await until(async () => (await dev(page, "calls")).enumerateDevices > before, 10000)) fail("opening Settings listed no device");
    await closeSettings(page, false);
  });

  // ---- 6.1, 6.2: the pickers, the choice kept, used by every way of using voice; the names go nowhere
  await scenario("choose", {}, async (p) => {
    const { page, calls, hits } = p;
    await openSettings(page);
    const c0 = await dev(page, "calls");
    if (c0.getUserMedia !== 0) fail("opening Settings asked for the microphone");
    // before the permission: System default alone, the note says why
    for (const id of ["vs-mic", "vs-speaker"]) {
      if ((await pickShown(page, id)) !== "System default") fail(`before the permission ${id} shows "${await pickShown(page, id)}"`);
      const items = await menuTexts(page, id);
      if (items.length !== 1 || !/^System default/.test(items[0])) fail(`before the permission ${id} lists ${J(items)}`);
    }
    if ((await textOf(byTid(page, "vs-devices-note"))) !== "Allow the microphone to see your other devices.") fail(`the note before the permission says "${await textOf(byTid(page, "vs-devices-note"))}"`);
    if ((await dev(page, "granted")) !== false) fail("the stand-in was granted before the tap");
    // Test microphone asks, and the lists fill: System default first, then the two devices of each kind
    await press(page, byTid(page, "vs-mic-test"));
    if (!await shown(byTid(page, "vs-mic-level"))) fail("Test microphone drew no meter");
    await until(async () => (await menuTexts(page, "vs-mic")).length === 3, 15000);
    const mics = await menuTexts(page, "vs-mic"), outs = await menuTexts(page, "vs-speaker");
    if (!/^System default/.test(mics[0] ?? "") || mics.slice(1).join() !== "Desk Mic,Stand-in Headset") fail(`the microphones listed are ${J(mics)}, not System default, Desk Mic, Stand-in Headset`);
    if (!/^System default/.test(outs[0] ?? "") || outs.slice(1).join() !== "Desk Speakers,Stand-in Headphones") fail(`the speakers listed are ${J(outs)}, not System default, Desk Speakers, Stand-in Headphones`);
    if (await byTid(page, "vs-devices-note").count()) fail("the note stays after the microphone was allowed");
    // 6.2: the meter moves with the microphone and nothing is sent
    if (!await until(async () => Number(await byTid(page, "vs-mic-level").getAttribute("data-peak")) > 0, 15000)) fail("the meter never moved while the test ran");
    await shot(page, "1-testing");
    const sent = (await log()).filter((e) => e.kind === "stt" || e.kind === "token" || e.kind === "tts");
    if (sent.length) fail(`Test microphone made a request of the voice service: ${J(sent.map((e) => e.kind))}`);
    await press(page, byTid(page, "vs-mic-test"));
    if (!await gone(byTid(page, "vs-mic-level"))) fail("the meter stays after Stop test");
    // the lists follow a device plugged in or out while Settings is open
    await dev(page, "plug", { kind: "input", id: "mic-usb", label: "USB Mic", hz: 500 });
    await dev(page, "plug", { kind: "output", id: "out-usb", label: "USB Speakers" });
    if (!await until(async () => (await menuTexts(page, "vs-mic")).includes("USB Mic") && (await menuTexts(page, "vs-speaker")).includes("USB Speakers"), 15000)) fail("a microphone and a speaker plugged in while Settings is open are not listed");
    await dev(page, "unplug", "mic-usb");
    await dev(page, "unplug", "out-usb");
    if (!await until(async () => (await menuTexts(page, "vs-mic")).length === 3 && (await menuTexts(page, "vs-speaker")).length === 3, 15000)) fail("a microphone and a speaker unplugged while Settings is open are still listed");
    // the picks
    await pick(page, "vs-mic", "Stand-in Headset");
    await pick(page, "vs-speaker", "Stand-in Headphones");
    await until(async () => (await settings(page)).mic?.id === "mic-headset" && (await settings(page)).speaker?.id === "out-headphones");
    const s1 = await settings(page);
    if (J(s1.mic) !== J(HEADSET) || J(s1.speaker) !== J(PHONES)) fail(`the picks are kept as ${J([s1.mic, s1.speaker])}`);
    // Test speaker: with the chosen sink, no request of the voice service (a key is set, and its voices came, so a request would be a choice)
    if (!await shown(byTid(page, "vs-voice-row"), 15000)) fail("the voices did not come with the key set");
    await knob("voice.reset(); return 1;");
    const w0 = await page.evaluate(() => window.__aiwbVoice.player().writes);
    await press(page, byTid(page, "vs-speaker-test"));
    if (!await until(async () => (await page.evaluate(() => window.__aiwbVoice.player().writes)) > w0, 15000)) fail("Test speaker wrote no sound to the player");
    if (!(await sinks(page)).some((x) => x.sinkId === "out-headphones")) fail(`Test speaker did not play on the speaker picked: ${J(await sinks(page))}`);
    await until(async () => (await byTid(page, "vs-speaker-test").getAttribute("data-playing")) === "false", 15000);
    if ((await log()).length) fail(`Test speaker made a request of the voice service: ${J((await log()).map((e) => e.kind))}`);
    await closeSettings(page);
    // the app restarted: the picks are still the settings, and Settings shows them
    await page.reload();
    await page.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbDevices && !!window.__aiwbSend, null, { timeout: 30000 });
    await page.waitForSelector(tidSel("send"), { timeout: 30000 });
    await watchNotices(page);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    const s2 = await settings(page);
    if (J(s2.mic) !== J(HEADSET) || J(s2.speaker) !== J(PHONES)) fail(`after a restart the picks are ${J([s2.mic, s2.speaker])}`);
    await openSettings(page);
    if (!await until(async () => (await pickShown(page, "vs-mic")) === "Stand-in Headset" && (await pickShown(page, "vs-speaker")) === "Stand-in Headphones", 15000)) fail(`after a restart Settings shows "${await pickShown(page, "vs-mic")}" and "${await pickShown(page, "vs-speaker")}"`);
    await closeSettings(page);
    // Dictation: the chosen microphone, and not the other
    const n = await dictate(page);
    const o1 = await opened(page);
    if (o1.length !== 1 || o1[0].deviceId !== "mic-headset" || o1[0].requested !== "mic-headset") fail(`Dictation opened ${J(o1)}, not the Stand-in Headset alone`);
    if (!near(await toneOf(n), 700)) fail(`the stand-in service heard ${await toneOf(n)} Hz from Dictation, not the chosen microphone's 700`);
    if (!await until(async () => (await text(page)).includes("hello there"), 20000)) fail(`Dictation's words never reached the box: ${J(await text(page))}`);
    await stopDictate(page);
    // Speech mode: the microphone, and its reply on the chosen sink
    const s = await speech(page);
    if (!near(await toneOf(s), 700)) fail(`Speech mode: the stand-in service heard ${await toneOf(s)} Hz, not 700`);
    await reply(ANSWER, 4, 100);
    if (!await until(async () => (await tts()).length >= 4, 40000)) fail(`only ${(await tts()).length} of the reply's sentences were spoken in Speech mode`);
    await phaseIs(page, "listening", 40000);
    if (!(await sinks(page)).some((x) => x.sinkId === "out-headphones")) fail(`Speech mode's reply did not play on the speaker chosen: ${J(await sinks(page))}`);
    await endSpeech(page);
    // Read aloud: the same sink
    const done = msgOf(page, "assistant", "That is all");
    if (!await until(async () => (await done.count()) > 0, 20000)) fail("the spoken turn's reply is not in the thread");
    else {
      await knob("voice.reset(); return 1;");
      const w1 = await page.evaluate(() => window.__aiwbVoice.player().writes);
      await readAloud(page, done);
      await until(async () => (await page.evaluate(() => window.__aiwbVoice.player().writes)) > w1, 20000);
      if (!(await sinks(page)).some((x) => x.sinkId === "out-headphones" && x.calls.at(-1) === "out-headphones")) fail(`Read aloud did not play on the speaker chosen: ${J(await sinks(page))}`);
      await readingIdle(page);
    }
    if ((await usedSinks(page)).some((x) => x === "out-desk")) fail(`the other speaker was used: ${J(await usedSinks(page))}`);
    if ((await opened(page)).some((x) => x.deviceId !== "mic-headset")) fail(`the other microphone was opened: ${J(await opened(page))}`);
    if (J(await notices(page)) !== "[]") fail(`devices that are there brought a notice: ${J(await notices(page))}`);
    // the voice pill on a board: the same microphone
    await openSettings(page).then(() => closeSettings(page, false));
    await openBoard(page, BOARD);
    const orb = byTid(page, "pill-orb");
    if (!await shown(orb)) fail("the board shows no pill");
    else {
      await script([{ after: 3, partial: "draw" }, { after: 6, committed: "draw a red box" }]);
      const k = (await stt()).length;
      await reply("Sure. I drew it.", 3, 100);
      await press(page, orb);
      if (!await phaseIs(page, "listening", 20000)) fail(`the pill did not listen: ${J(await sess(page))}`);
      else {
        if (!near(await toneOf(k), 700)) fail(`the pill: the stand-in service heard ${await toneOf(k)} Hz, not the chosen microphone's 700`);
        if ((await opened(page)).at(-1)?.deviceId !== "mic-headset") fail(`the pill opened ${J((await opened(page)).at(-1))}, not the Stand-in Headset`);
      }
      for (let i = 0; i < 4 && (await sess(page)).phase !== "idle"; i++) { await press(page, orb); await sleep(300); }
    }
    // 4.7, 6.1: the devices' names and ids are in no request, no socket frame, no console line, and not in what the voice service logged
    const found = NAMES.filter((nm) => hits.some((h) => h.includes(nm)));
    if (found.length) fail(`device names reached ${J(found.map((nm) => [nm, hits.find((h) => h.includes(nm)).slice(0, 160)]))}`);
    const logged = J(await log());
    for (const nm of NAMES) if (logged.includes(nm)) fail(`"${nm}" is in the voice service's log`);
    if (calls.some((c) => NAMES.some((nm) => J(c).includes(nm)))) fail(`a name is in a call to the aiwb server: ${J(calls.filter((c) => NAMES.some((nm) => J(c).includes(nm))))}`);
  });

  /** In the page: every change of the sentence the speech bar says it speaks, in order (20 ms apart at the most). */
  const watchSaid = (p) => p.evaluate(() => {
    const said = (window.__said = []);
    setInterval(() => { const t = document.querySelector('[data-testid="speech-spoken"]')?.textContent; if (t && said[said.length - 1] !== t) said.push(t); }, 20);
  });
  const saidNow = (p) => p.evaluate(() => window.__said);
  /** The sinks of the page's contexts that were ever given `id`: the player's context. */
  const playerSink = async (p, id) => (await sinks(p)).find((x) => x.calls.includes(id)) ?? null;
  const LOST_MIC = (name) => `“${name}” was disconnected. Listening with the system microphone.`;
  const LOST_SPEAKER = (name) => `“${name}” was disconnected. Speaking through the system speaker.`;
  const PAUSED = (name) => `“${name}” was disconnected. Paused so nothing is played out loud.`;
  const sentences = (t) => t.match(/[^.]+\./g).map((x) => x.trim());
  /** A reply spoken slowly (3 s a sentence): Speech mode listens, hears the words, and the reply is on its way. Waits for the bar to speak. */
  const speakSlowly = async (p) => {
    await knob("voice.pace({ chunkMs: 300, chunks: 10 }); return 1;");
    await reply(SLOW, 4, 400);
    await watchSaid(p);
    await speech(p, [{ after: 3, committed: "tell me a lot" }]);
    if (!await until(async () => (await byTid(p, "speech-wave").getAttribute("data-phase")) === "speaking", 40000)) throw new Error(`the reply was never spoken: the bar is ${J(await byTid(p, "speech-wave").getAttribute("data-phase"))}`);
    if (!await shown(byTid(p, "speech-spoken"), 10000)) throw new Error("the bar shows no sentence while the model speaks");
  };
  const once = (list) => new Set(list).size === list.length;

  // ---- 6.3: a saved device that is not there at the start
  await scenario("missing", { settings: { mic: HEADSET, speaker: PHONES }, devices: { granted: true } }, async (p) => {
    const { page, calls } = p;
    // the microphone
    await dev(page, "unplug", "mic-headset");
    const n = await dictate(page);
    const o1 = (await opened(page)).at(-1);
    if (!o1 || !isDefault(o1) || o1.deviceId !== "mic-desk" || !o1.live) fail(`with the saved microphone gone Dictation opened ${J(o1)}, not the system default`);
    if (!near(await toneOf(n), 300)) fail(`with the saved microphone gone the stand-in service heard ${await toneOf(n)} Hz, not the default's 300`);
    const want = "“Stand-in Headset” isn't connected. Using the system microphone.";
    if (!await shown(byTid(page, "voice-notice"), 5000)) fail("no notice on the composer while Dictation runs on the default");
    else if ((await textOf(byTid(page, "voice-notice"))) !== want) fail(`the notice says "${await textOf(byTid(page, "voice-notice"))}", not "${want}"`);
    await shot(page, "2-notice-start");
    if (J(await notices(page)) !== J([want])) fail(`the notices of the start are ${J(await notices(page))}, one was wanted`);
    await stopDictate(page);
    await openSettings(page);
    if (!await until(async () => (await pickShown(page, "vs-mic")) === "Stand-in Headset (not connected)", 15000)) fail(`Settings shows the missing microphone as "${await pickShown(page, "vs-mic")}"`);
    if (J((await settings(page)).mic) !== J(HEADSET)) fail(`the saved microphone is ${J((await settings(page)).mic)} after a session without it`);
    await closeSettings(page);
    // back: the next session uses it, and says nothing
    await dev(page, "plug", MIC_HEADSET);
    const m = await dictate(page);
    const o2 = (await opened(page)).at(-1);
    if (o2?.deviceId !== "mic-headset" || !near(await toneOf(m), 700)) fail(`with the microphone back Dictation opened ${J(o2)} and the stand-in service heard ${await toneOf(m)} Hz`);
    if ((await notices(page)).length !== 1) fail(`the microphone back brought a notice: ${J(await notices(page))}`);
    await stopDictate(page);
    // the speaker
    const done = await writeReply(page);
    await dev(page, "unplug", "out-headphones");
    await knob("voice.reset(); return 1;");
    await readAloud(page, done);
    await reading(page);
    const wantS = "“Stand-in Headphones” isn't connected. Using the system speaker.";
    if (!await until(async () => (await notices(page)).includes(wantS), 10000)) fail(`Read aloud with the saved speaker gone showed ${J(await notices(page))}, not "${wantS}"`);
    if (!await shown(byTid(page, "voice-notice"), 5000) || (await textOf(byTid(page, "voice-notice"))) !== wantS) fail(`the composer's notice is "${await textOf(byTid(page, "voice-notice"))}"`);
    if ((await usedSinks(page)).includes("out-headphones")) fail(`Read aloud was sent to the missing speaker: ${J(await usedSinks(page))}`);
    await readingIdle(page);
    if (J((await settings(page)).speaker) !== J(PHONES)) fail(`the saved speaker is ${J((await settings(page)).speaker)} after a reading without it`);
    await dev(page, "plug", OUT_PHONES);
    const count = (await notices(page)).length;
    await knob("voice.reset(); return 1;");
    await readAloud(page, done);
    if (!await until(async () => (await sinks(page)).some((x) => x.sinkId === "out-headphones"), 15000)) fail(`with the speaker back Read aloud did not play on it: ${J(await sinks(page))}`);
    if ((await notices(page)).length !== count) fail(`the speaker back brought a notice: ${J(await notices(page))}`);
    await stopReading(page);
    // both at once: one notice
    await dev(page, "unplug", "mic-headset");
    await dev(page, "unplug", "out-headphones");
    const before = (await notices(page)).length;
    await speech(page, [{ after: 3, partial: "hmm" }]);
    const wantB = "“Stand-in Headset” and “Stand-in Headphones” aren't connected. Using the system's own.";
    await until(async () => (await notices(page)).length > before, 10000);
    if (J((await notices(page)).slice(before)) !== J([wantB])) fail(`both missing at one start: the notices are ${J((await notices(page)).slice(before))}, not the one "${wantB}"`);
    await endSpeech(page);
    // the default too: no microphone at all ends the way it ends today
    await dev(page, "unplug", "mic-desk");
    await clearBox(page);
    await typeIn(page, "keep me");
    await toggleDictate(page);
    const pop = byTid(page, "voice-problem", { kind: "mic_blocked" });
    if (!await until(() => pop.count(), 10000)) fail("with the saved microphone and the default both gone Dictation shows no mic_blocked popover");
    else {
      if (!(await textOf(pop)).includes("can't hear you")) fail(`the popover says "${await textOf(pop)}"`);
      await press(page, byTid(page, "voice-problem-dismiss"));
    }
    if ((await sess(page)).phase !== "idle") fail(`the session is ${J(await sess(page))}, not over`);
    if ((await text(page)) !== "keep me") fail(`the box is ${J(await text(page))}, not as it was`);
    await dev(page, "plug", MIC_DESK);
    await dev(page, "plug", MIC_HEADSET);
    await dev(page, "plug", OUT_PHONES);
    await clearBox(page);
    await stillWorks(page, calls, "the missing devices");
  });

  // ---- 4.5: Settings announces a fallback too (a Test speaker or Test microphone on a saved device that is not there)
  await scenario("settingsnotice", { settings: { mic: HEADSET, speaker: PHONES }, devices: { granted: true } }, async (p) => {
    const { page } = p;
    await dev(page, "unplug", "out-headphones");
    await dev(page, "unplug", "mic-headset");
    await openSettings(page);
    if (!await shown(byTid(page, "vs-speaker-test"))) fail("the devices card has no Test speaker");
    if (await byTid(page, "vs-devices-notice").count()) fail("the devices card shows a notice before any test");
    const wantS = "“Stand-in Headphones” isn't connected. Using the system speaker.";
    await press(page, byTid(page, "vs-speaker-test"));
    if (!await shown(byTid(page, "vs-devices-notice"), 5000)) fail("Test speaker on a speaker that is not there announced nothing in Settings");
    else if ((await textOf(byTid(page, "vs-devices-notice"))) !== wantS) fail(`the devices card says "${await textOf(byTid(page, "vs-devices-notice"))}", not "${wantS}"`);
    await shot(page, "3-settings-notice");
    if (!await until(async () => (await byTid(page, "vs-speaker-test").getAttribute("data-playing")) === "false", 15000)) fail("Test speaker never ended");
    if (!await byTid(page, "vs-devices-notice").count()) fail("the notice went with the chime; it should stay on its timer");
    if ((await usedSinks(page)).includes("out-headphones")) fail(`Test speaker was sent to the missing speaker: ${J(await usedSinks(page))}`);
    if ((await sinks(page)).length === 0) fail("Test speaker played nowhere");
    if (await byTid(page, "voice-notice").count()) fail("a chat's notice line shows the Settings notice");
    if (!await gone(byTid(page, "vs-devices-notice"), 15000)) fail("the notice of the devices card does not go away by itself");
    if (J((await settings(page)).speaker) !== J(PHONES)) fail(`the saved speaker is ${J((await settings(page)).speaker)} after Test speaker without it`);
    // Test microphone
    const wantM = "“Stand-in Headset” isn't connected. Using the system microphone.";
    await press(page, byTid(page, "vs-mic-test"));
    if (!await shown(byTid(page, "vs-mic-level"))) fail("Test microphone drew no meter on the default");
    if (!await shown(byTid(page, "vs-devices-notice"), 5000)) fail("Test microphone on a microphone that is not there announced nothing in Settings");
    else if ((await textOf(byTid(page, "vs-devices-notice"))) !== wantM) fail(`the devices card says "${await textOf(byTid(page, "vs-devices-notice"))}", not "${wantM}"`);
    if (!(await opened(page)).some((o) => o.live && o.deviceId === "mic-desk")) fail(`Test microphone opened ${J(await opened(page))}, not the default`);
    if (J((await settings(page)).mic) !== J(HEADSET)) fail(`the saved microphone is ${J((await settings(page)).mic)} after Test microphone without it`);
    // closing Settings takes it away, and it is not there when Settings opens again
    await closeSettings(page, false);
    if (await page.evaluate(() => window.__aiwbVoice.notice()) !== null) fail("the notice of Settings stays after Settings closed");
    await openSettings(page);
    if (await byTid(page, "vs-devices-notice").count()) fail("the notice of the last opening shows when Settings opens again");
    await closeSettings(page, false);
  });

  // ---- 6.6: before a key is saved voice is not set up: Settings lists no device, then lists when the key is saved
  await scenario("nokey", { settings: {}, key: false }, async (p) => {
    const { page } = p;
    await openSettings(page);
    const want = "Add your key to choose a microphone and a speaker.";
    if (!await shown(byTid(page, "vs-devices-nokey"))) fail("with no key the devices card does not say that a key is needed");
    else if ((await textOf(byTid(page, "vs-devices-nokey"))) !== want) fail(`with no key the devices card says "${await textOf(byTid(page, "vs-devices-nokey"))}", not "${want}"`);
    if ((await textOf(byTid(page, "vs-devices-section").locator('[role="heading"]'))) !== "Microphone and speaker") fail("the card without a key has no title");
    await sleep(1500);
    const c = await dev(page, "calls");
    if (c.enumerateDevices !== 0 || c.getUserMedia !== 0 || c.setSinkId !== 0) fail(`Settings listed or opened devices with no key saved: ${J(c)}`);
    for (const id of ["vs-mic", "vs-speaker", "vs-mic-test", "vs-speaker-test"]) if (await byTid(page, id).count()) fail(`${id} is offered with no key saved`);
    await shot(page, "4-devices-nokey");
    // the key saved: the card shows and lists
    await byTid(page, "vs-key").fill(KEY);
    await press(page, byTid(page, "vs-key-save"));
    if (!await shown(byTid(page, "vs-mic"))) fail("the pickers did not come after the key was saved");
    if (await byTid(page, "vs-devices-nokey").count()) fail("the no-key line stays after the key was saved");
    if (!await until(async () => (await dev(page, "calls")).enumerateDevices > 0, 10000)) fail("the card lists no device once the key is saved");
    await closeSettings(page, false);
  });

  // ---- 6.4: the microphone lost while listening
  await scenario("mic", { settings: { mic: HEADSET }, devices: { granted: true } }, async (p) => {
    const { page, calls } = p;
    const n = await dictate(page, [{ after: 3, committed: "first words" }, { after: 30, committed: "later words" }]);
    if (!await until(async () => (await text(page)).includes("first words"), 20000)) { fail(`no words came before the loss: ${J(await text(page))}`); return; }
    if ((await opened(page)).at(-1)?.deviceId !== "mic-headset") fail(`Dictation began on ${J((await opened(page)).at(-1))}, not the Stand-in Headset`);
    await dev(page, "unplug", "mic-headset");
    if (!await until(async () => { const o = (await opened(page)).at(-1); return o?.deviceId === "mic-desk" && o.live; }, 15000)) fail(`the microphone lost, listening did not move to the default: ${J(await opened(page))}`);
    else if (!isDefault((await opened(page)).at(-1))) fail(`listening moved to ${J((await opened(page)).at(-1))}, not the system default`);
    if (!await until(async () => (await notices(page)).includes(LOST_MIC("Stand-in Headset")), 10000)) fail(`no notice for the microphone lost: ${J(await notices(page))}`);
    else if (!await shown(byTid(page, "voice-notice"), 3000) || (await textOf(byTid(page, "voice-notice"))) !== LOST_MIC("Stand-in Headset")) fail(`the composer's notice is "${await textOf(byTid(page, "voice-notice"))}"`);
    await shot(page, "3-notice-mic-lost");
    if ((await sess(page)).phase !== "listening") fail(`the session is ${J((await sess(page)).phase)} after the loss, not listening`);
    if (!(await text(page)).includes("first words")) fail(`the words already heard are gone: the box shows ${J(await text(page))}`);
    // the microphone back in the middle of the session does not move listening
    const openedBefore = (await opened(page)).length;
    await dev(page, "plug", MIC_HEADSET);
    await sleep(1200);
    if ((await opened(page)).length !== openedBefore || (await opened(page)).at(-1)?.deviceId !== "mic-desk") fail(`the microphone plugged in again moved listening: ${J(await opened(page))}`);
    if (!await until(async () => (await text(page)).includes("later words"), 30000)) fail(`the words said after the loss never came: the box shows ${J(await text(page))}`);
    if (!near(await toneOf(n, "toneHzLast"), 300)) fail(`after the loss the stand-in service hears ${await toneOf(n, "toneHzLast")} Hz, not the default's 300`);
    const e = (await stt())[n];
    if ((await stt()).length !== n + 1 || e.closeCode !== null) fail(`the loss opened or closed a session of the voice service (${(await stt()).length - n} sessions, closeCode ${e.closeCode})`);
    if (e.problems?.length) fail(`the client broke the protocol: ${J(e.problems)}`);
    await stopDictate(page);
    await stillWorks(page, calls, "the microphone lost");
    if ((await opened(page)).at(-1)?.deviceId !== "mic-headset") fail(`the next session does not use the microphone that came back: ${J((await opened(page)).at(-1))}`);
  });
  // ... and when it cannot be reopened: the end of today's microphone problem
  await scenario("mic", { settings: { mic: HEADSET }, devices: { granted: true } }, async (p) => {
    const { page } = p;
    await dev(page, "unplug", "mic-desk");
    await dictate(page, [{ after: 3, committed: "kept words" }]);
    if (!await until(async () => (await text(page)).includes("kept words"), 20000)) fail(`no words came before the loss: ${J(await text(page))}`);
    await dev(page, "unplug", "mic-headset");
    if (!await until(() => byTid(page, "voice-problem", { kind: "mic_blocked" }).count(), 15000)) fail(`the last microphone lost ends no session with the mic_blocked popover: ${J(await sess(page))}`);
    else await press(page, byTid(page, "voice-problem-dismiss"));
    if (!await phaseIs(page, "idle", 10000)) fail(`the session is ${J(await sess(page))}, not over`);
    if (!(await text(page)).includes("kept words")) fail(`the words already heard are gone: ${J(await text(page))}`);
  });

  // ---- 6.4: a public speaker lost while a reply is spoken
  await scenario("speaker", { settings: { speaker: SPEAKERS }, devices: { granted: true } }, async (p) => {
    const { page, calls } = p;
    await speakSlowly(page);
    if (!await playerSink(page, "out-desk")) fail(`the reply is not on the chosen speaker: ${J(await sinks(page))}`);
    await dev(page, "unplug", "out-desk");
    if (!await until(async () => (await notices(page)).includes(LOST_SPEAKER("Desk Speakers")), 10000)) fail(`no notice for the speaker lost: ${J(await notices(page))}`);
    else if (!await shown(byTid(page, "voice-notice"), 3000)) fail("the notice is not shown on the composer's line");
    await shot(page, "4-notice-speaker-lost");
    if (!await until(async () => (await playerSink(page, "out-desk"))?.calls.at(-1) === "", 10000)) fail(`the sound was not moved to the system default: ${J(await sinks(page))}`);
    if ((await sess(page)).paused) fail(`a public speaker lost paused the session: ${J((await sess(page)).paused)}`);
    if ((await playerSink(page, "out-desk"))?.state === "suspended") fail("the sound is held after a public speaker was lost");
    // the device back in the middle of the session does not move the sound
    await dev(page, "plug", OUT_DESK);
    await sleep(1200);
    const sink = await playerSink(page, "out-desk");
    if (sink?.calls.at(-1) !== "" || sink?.sinkId !== "") fail(`the speaker plugged in again moved the sound: ${J(sink)}`);
    if (!await phaseIs(page, "listening", 90000)) fail(`the session did not go on to listen after the reply: ${J(await sess(page))}`);
    const spoken = (await tts()).map((e) => e.text);
    if (J(spoken) !== J(sentences(SLOW))) fail(`the sentences asked for are ${J(spoken)}, not the reply's, each once and in order`);
    const said = await saidNow(page);
    if (!once(said) || said.length !== sentences(SLOW).length) fail(`the bar said ${J(said)}: a sentence twice, or one missing`);
    const marks = (await page.evaluate(() => window.__aiwbVoice.player())).marks;
    if (marks !== sentences(SLOW).length) fail(`the player was given ${marks} marks for ${sentences(SLOW).length} sentences`);
    await endSpeech(page);
    await stillWorks(page, calls, "the speaker lost");
    // the next session uses the device that came back
    await speech(page, [{ after: 3, partial: "hm" }]);
    if (!await until(async () => (await sinks(page)).some((x) => x.calls.at(-1) === "out-desk"), 15000)) fail(`the next session does not use the speaker that came back: ${J(await sinks(page))}`);
    await endSpeech(page);
  });

  // ---- 6.4: private headphones lost while a reply is spoken: the pause, on the speech bar and in Read aloud
  await scenario("pause", { settings: { speaker: PHONES }, devices: { granted: true } }, async (p) => {
    const { page, calls } = p;
    await speakSlowly(page);
    const held = await playerSink(page, "out-headphones");
    if (!held) { fail(`the reply is not on the chosen headphones: ${J(await sinks(page))}`); return; }
    await dev(page, "unplug", "out-headphones");
    if (!await until(async () => (await sess(page)).paused != null, 10000)) { fail(`headphones lost while the reply is spoken did not pause the session: ${J(await sess(page))}`); return; }
    if ((await sess(page)).paused.device !== "Stand-in Headphones") fail(`the pause names ${J((await sess(page)).paused)}`);
    const wantP = PAUSED("Stand-in Headphones");
    if (!await shown(byTid(page, "speech-paused"), 5000)) fail("the speech bar shows no pause line");
    else if ((await textOf(byTid(page, "speech-paused"))) !== wantP) fail(`the pause line says "${await textOf(byTid(page, "speech-paused"))}", not "${wantP}"`);
    if (!await shown(byTid(page, "speech-continue"), 5000)) fail("the speech bar shows no Continue");
    await shot(page, "5-speech-paused");
    if ((await notices(page)).some((x) => x !== wantP)) fail(`the pause came with a notice besides its own line: ${J(await notices(page))}`);
    // nothing comes out loud while it lasts: the context is suspended and the bar says the same sentence
    const at = (await textOf(byTid(page, "speech-spoken"))) || J(await saidNow(page));
    for (let i = 0; i < 6; i++) {
      await sleep(300);
      const s = await playerSink(page, "out-headphones");
      if (s?.state !== "suspended") { fail(`during the pause the player's context is ${s?.state}, not suspended`); break; }
    }
    if (((await textOf(byTid(page, "speech-spoken"))) || J(await saidNow(page))) !== at) fail("the bar moved on to another sentence during the pause");
    // (the speaker keeps fetching into the held queue, VD-12, so the writes go on; what must not is the sound, and the requests ahead of the spoken sentence: two at most)
    if ((await tts()).length > 3) fail(`${(await tts()).length} sentences were asked for during the pause (one spoken, two ahead at most)`);
    if (await byTid(page, "speech-send").count() && !(await byTid(page, "speech-send").first().isDisabled())) note("Send stands enabled during the pause (not asserted)");
    // the headphones back in the pause: not used, Continue goes on out loud on the default
    await dev(page, "plug", OUT_PHONES);
    await sleep(800);
    if ((await playerSink(page, "out-headphones"))?.state !== "suspended") fail("the headphones plugged in again released the pause");
    await press(page, byTid(page, "speech-continue"));
    if (!await until(async () => (await sess(page)).paused == null, 5000)) fail("Continue left the session paused");
    if (!await until(async () => (await playerSink(page, "out-headphones"))?.state === "running", 10000)) fail(`after Continue the context is ${(await playerSink(page, "out-headphones"))?.state}, not running`);
    const sinkNow = await playerSink(page, "out-headphones");
    if (sinkNow?.calls.at(-1) !== "") fail(`Continue played on ${J(sinkNow?.calls.at(-1))}, not the system default`);
    if (!await phaseIs(page, "listening", 90000)) fail(`the session did not go on after Continue: ${J(await sess(page))}`);
    const spoken = (await tts()).map((e) => e.text);
    if (J(spoken) !== J(sentences(SLOW))) fail(`the sentences asked for are ${J(spoken)}, not the reply's, each once and in order`);
    const said = await saidNow(page);
    if (!once(said)) fail(`the bar said a sentence twice: ${J(said)}`);
    await endSpeech(page);
    await stillWorks(page, calls, "the pause");
    // Read aloud: Continue reading, and the pause sentence on the composer's line
    const done = await writeReply(page, SLOW, 4, 100);
    await knob("voice.reset(); voice.pace({ chunkMs: 300, chunks: 10 }); return 1;");
    await readAloud(page, done);
    await reading(page);
    if (!await until(async () => (await tts()).length >= 1 && !!(await playerSink(page, "out-headphones")), 20000)) { fail("Read aloud did not start on the headphones"); return; }
    await dev(page, "unplug", "out-headphones");
    if (!await until(async () => (await vstate(page)).reading.paused === true, 10000)) { fail(`headphones lost while a message is read did not pause the reading: ${J((await vstate(page)).reading)}`); return; }
    const cont = byTid(page, "voice-reading-continue");
    if (!await shown(cont, 5000)) fail("Read aloud's pause offers no Continue reading");
    else if ((await textOf(cont)) !== "Continue reading") fail(`the continue control says "${await textOf(cont)}"`);
    if (!await byTid(page, "voice-reading").count()) fail("Stop reading is gone during the pause");
    if (!await shown(byTid(page, "voice-notice"), 5000) || (await textOf(byTid(page, "voice-notice"))) !== wantP) fail(`the composer's line says "${await textOf(byTid(page, "voice-notice"))}", not the pause sentence`);
    await shot(page, "6-reading-paused");
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      if ((await playerSink(page, "out-headphones"))?.state !== "suspended") { fail("during the paused reading the context is not suspended"); break; }
    }
    const asked = (await tts()).length;
    await press(page, cont);
    if (!await until(async () => (await vstate(page)).reading.paused === false, 5000)) fail("Continue reading left the reading paused");
    if (!await until(async () => (await playerSink(page, "out-headphones"))?.state === "running", 10000)) fail("after Continue reading the context does not run");
    if (!await readingIdle(page, 90000)) fail("the reading did not go on to its end after Continue reading");
    const all = (await tts()).map((e) => e.text);
    if (!once(all) || all.length < asked) fail(`Read aloud asked for ${J(all)}: a sentence twice`);
    await stillWorks(page, calls, "the paused reading");
  });

  // ---- 6.4 on the board's pill: a private output lost pauses the orb, a public one gives a caption
  const pillTurn = async (page, orb) => {
    await script([{ after: 3, partial: "draw" }, { after: 6, committed: "draw a red box" }]);
    await knob("voice.pace({ chunkMs: 300, chunks: 10 }); return 1;");
    await reply(SLOW, 4, 400);
    await press(page, orb);
    if (!await until(async () => (await byTid(page, "pill-orb").getAttribute("data-state")) === "speaking", 60000)) throw new Error(`the pill never spoke: the orb is ${await byTid(page, "pill-orb").getAttribute("data-state")}`);
  };
  const endPill = async (page) => { for (let i = 0; i < 5 && (await sess(page)).phase !== "idle"; i++) { await press(page, byTid(page, "pill-orb")); await sleep(400); } return phaseIs(page, "idle", 8000); };
  await scenario("pill", { at: "board", settings: { speaker: PHONES }, devices: { granted: true } }, async (p) => {
    const { page, calls } = p;
    const orb = byTid(page, "pill-orb");
    await orb.first().waitFor({ state: "visible", timeout: 15000 });
    await pillTurn(page, orb);
    await dev(page, "unplug", "out-headphones");
    if (!await until(async () => (await orb.getAttribute("data-state")) === "paused", 10000)) { fail(`headphones lost while the pill speaks: the orb is ${await orb.getAttribute("data-state")}, not paused`); return; }
    if (!await shown(byTid(page, "pill-continue"), 5000)) fail("the paused pill shows no Continue");
    const wantP = PAUSED("Stand-in Headphones");
    if (!(await textOf(byTid(page, "pill-words"))).includes(wantP)) fail(`the pill's words line says "${await textOf(byTid(page, "pill-words"))}", not the pause sentence`);
    await shot(page, "7-pill-paused");
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      if ((await playerSink(page, "out-headphones"))?.state !== "suspended") { fail("during the pill's pause the context is not suspended"); break; }
    }
    await press(page, byTid(page, "pill-continue"));
    if (!await until(async () => (await orb.getAttribute("data-state")) !== "paused", 5000)) fail("Continue left the orb paused");
    if (!await until(async () => (await playerSink(page, "out-headphones"))?.state === "running", 10000)) fail("after Continue the pill's context does not run");
    if (!await endPill(page)) fail(`the pill did not end: ${J(await sess(page))}`);
    // the orb itself continues, too
    await dev(page, "plug", OUT_PHONES);
    await pillTurn(page, orb);
    await dev(page, "unplug", "out-headphones");
    if (!await until(async () => (await orb.getAttribute("data-state")) === "paused", 10000)) fail("the second loss did not pause the orb");
    else {
      await press(page, orb);
      if (!await until(async () => (await orb.getAttribute("data-state")) !== "paused", 5000)) fail("a tap on the paused orb did not continue");
    }
    await endPill(page);
    // the pill still sends: a turn is an ordinary message
    const from = calls.length;
    await script([{ after: 3, committed: "one more" }]);
    await reply("Done. Thanks.", 2, 100);
    await press(page, orb);
    if (!await until(() => posts(calls, from)[0], 30000)) fail("after the pause the pill sent no turn");
    await endPill(page);
  });
  await scenario("pill", { at: "board", settings: { speaker: SPEAKERS }, devices: { granted: true } }, async (p) => {
    const { page } = p;
    const orb = byTid(page, "pill-orb");
    await orb.first().waitFor({ state: "visible", timeout: 15000 });
    await pillTurn(page, orb);
    await dev(page, "unplug", "out-desk");
    if (!await until(async () => (await notices(page)).includes(LOST_SPEAKER("Desk Speakers")), 10000)) fail(`no notice for the pill's speaker lost: ${J(await notices(page))}`);
    else if (!await shown(byTid(page, "caption-notice"), 3000)) fail("the notice is not a caption above the pill");
    if ((await orb.getAttribute("data-state")) === "paused") fail("a public speaker lost paused the pill");
    if (!await until(async () => (await playerSink(page, "out-desk"))?.calls.at(-1) === "", 10000)) fail(`the pill's sound was not moved to the default: ${J(await sinks(page))}`);
    await shot(page, "8-pill-notice");
    await endPill(page);
  });

  note(`scenarios run: ${ran.join(", ")}`);
}, { viewports, page: false });
