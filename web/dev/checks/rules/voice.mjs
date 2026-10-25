// R1's recipes of voice (rules.mjs says what a recipe is): goal 3.7.2 (Dictate's line, the speech bar, Set up voice), 3.7.3 (Auto-send is one setting,
// in Settings › Voice, and in no bar, card or board), 3.4 (the docked orb and the voice card on a board), 6.2 (a selection goes to a chat only in speech
// mode). One seed, UXV1 (`web/dev/mock-ui.js`): the chat "Plain" (a started chat) and the editable board "Sketch" (`b_ui`) with the chats "Layout notes"
// and "Colours". The stand-in voice service is the test host's (`/voice`, `voice.script` in the mock) and the page's microphone the checks' (`mic.mjs`);
// the key is put in through the checks' seam `window.__aiwbVoice` (as UX.V1-voice and VC.3 do). Never ElevenLabs. Each recipe restarts the mock
// (`fresh`): a spoken turn is a sent message, and the next recipe reads the seed as written.
import { callsOf, mockEval, until } from "../../shot.mjs";
import { editHere } from "../boarddraw.mjs";
import { useMic } from "../mic.mjs";
import { back, byTid, press, tidSel } from "../sel.mjs";
import { stackNames } from "../voicephone.mjs";

const J = JSON.stringify;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const KEY = "sk_test_R1CANARY12";
const PLAIN = "c_UXV1_plain", BOARD = "b_ui", B1 = "c_UXV1_b1", B2 = "c_UXV1_b2";
const ANSWER = "Here is the plan. First we draw the boxes. Then we connect them with arrows. That is all.";
const MSG = /\/chats\/([^/]+)\/(?:branches\/[^/]+\/)?messages(?:\?|$)/;
const CANVAS = { canvas: true };
const settings = (s) => ({ "aiwb.voice.settings": J(s) });
const RESET = "delete flags.send; delete flags.reply; voice.reset(); return 1;";
const SENT = (calls) => calls.filter((c) => c.method === "POST" && MSG.test(c.path));
const bodyText = (c) => (c.body && typeof c.body === "object" ? c.body.text : c.body);

const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const attr = (loc, a) => loc.first().getAttribute(a).catch(() => null);
const sess = (page) => page.evaluate(() => window.__aiwbVoice.state().session);
const phaseIs = (page, ph, ms = 20000) => until(async () => (await sess(page)).phase === ph, ms);
const script = (h, steps) => mockEval(`voice.script(${J(steps)}); return 1;`, h.url);
const reply = (h, text, parts = 8, pace = 1200) => mockEval(`flags.reply = { text: ${J(text)}, parts: ${parts}, pace: ${pace} }; return 1;`, h.url);
const rect = (loc) => loc.first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const meets = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;

/** The checks' microphone and a key in the page (the voice is then ready), and the page's calls from now on. */
async function voiceOn(page, h) {
  await useMic(page, h.note);
  await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
  page.__calls = callsOf(page);
}
/** The state word of the speech bar, waited for. */
const wordIs = (page, word, ms = 40000) => until(async () => (await textOf(byTid(page, "speech-state"))) === word, ms);
/** Nothing in the speech bar, the dictate line or the card says Stop (the walker's `stop` rule reads the controls; these are the texts). */
async function noAuto(page, h, where) {
  if (await byTid(page, "speech-autosend").count() || await byTid(page, "pill-autosend").count()) h.fail(`${where}: an Auto-send switch is drawn (goal 3.7.3: it is only in Settings › Voice)`);
}

// ---- the board: one selected shape, as UX.V1-voice picks it (a click on the rectangle's top edge: an unfilled shape is picked by its stroke)
async function selectRect(page) {
  const v = await page.evaluate(() => window.__aiwbView()), cv = await byTid(page, "board-canvas").first().boundingBox();
  await page.mouse.click(cv.x + (160 + v.scrollX) * v.zoom, cv.y + (80 + v.scrollY) * v.zoom);
  await sleep(300);
}
/** Where the selected rectangle lies on the page. */
async function rectBox(page) {
  const v = await page.evaluate(() => window.__aiwbView()), cv = await byTid(page, "board-canvas").first().boundingBox();
  const x = cv.x + (80 + v.scrollX) * v.zoom, y = cv.y + (80 + v.scrollY) * v.zoom;
  return { x, y, w: 160 * v.zoom, h: 90 * v.zoom, right: x + 160 * v.zoom, bottom: y + 90 * v.zoom };
}
/** The Chats button and the sheet; its row of `chat` opens that chat full screen (B1's `chats-row`). */
async function openChatFromSheet(page, chat) {
  await press(page, byTid(page, "board-chats").first());
  await byTid(page, "chats-sheet").first().waitFor({ state: "visible", timeout: 15000 });
  await sleep(500); // (the sheet rises)
  await press(page, byTid(page, "chats-row", { chat }).first());
  await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: 15000 });
}
const closeSheet = async (page) => {
  await page.keyboard.press("Escape");
  await byTid(page, "chats-sheet").first().waitFor({ state: "hidden", timeout: 5000 }).catch(async () => { await page.mouse.click(20, 80); await sleep(400); });
};
/** The card's reasons to be over the canvas (goal 3.4, bd-05a): app chrome above the bottom row, session only. */
const CARD = { rule: "canvas", match: /voice-card/, why: "goal 3.4: the voice card is app chrome raised above the bottom row while a session runs, and goes away when it ends" };

const BOARD_RECIPE = { seed: ["UXV1"], fresh: true, sel: { board: BOARD, chat: null }, wait: tidSel("board-canvas"), prepare: (h) => h.mockEval(RESET) };

export const recipes = [
  // =============== Dictate: the listening line in the box (goal 3.7.2, mockup 06c)
  { id: "voice.dictate", goal: "3.7.2 · 06 Voice in the composer (Dictate)", seed: ["UXV1"], fresh: true, state: "UXV1.plain", wait: tidSel("composer"),
    prepare: (h) => h.mockEval(RESET),
    steps: [
      { name: "listening", ready: tidSel("dictate-guess"),
        go: async (page, h) => {
          await voiceOn(page, h);
          const mic = byTid(page, "voice-dictate").locator("[aria-label]");
          page.__rest = await fillOf(page);
          if (await attr(mic, "aria-label") === "End dictation") h.fail("the mic says \"End dictation\" before dictation started");
          await press(page, byTid(page, "composer-input"));
          await page.keyboard.type("my draft");
          await script(h, [{ after: 3, committed: "turn the lights" }, { after: 6, partial: "on in the hall" }]);
          await press(page, byTid(page, "voice-dictate"));
        },
        check: async (page, h) => {
          const line = byTid(page, "dictate-line"), box = byTid(page, "composer-box");
          const lt = await textOf(line);
          if (!lt.includes("Listening…") || !lt.includes("Tap the mic to end")) h.fail(`the line says ${J(lt)}, not "Listening…" and "Tap the mic to end"`);
          const L = await rect(line), B = await rect(box);
          if (L.x < B.x - 1 || L.right > B.right + 1 || L.y < B.y - 1 || L.bottom > B.bottom + 1) h.fail("the listening line is not inside the composer's box");
          if (!await line.locator("[data-testid*=level], [data-testid*=bar], [data-testid*=wave]").count() && !(await line.evaluate((e) => e.children.length > 1))) h.fail("the listening line shows no level");
          const now = await fillOf(page);
          if (!now || now === page.__rest) h.fail(`the mic is not drawn with the accent while it listens (fill ${J(now)}, at rest ${J(page.__rest)})`);
          if (await attr(byTid(page, "voice-dictate").locator("[aria-label]"), "aria-label") !== "End dictation") h.fail("the mic's label is not \"End dictation\"");
          if (await byTid(page, "send").count() !== 1) h.fail("Send is not the primary while dictating");
          if (await byTid(page, "voice-speech").count()) h.fail("Talk is drawn beside Send while dictating");
          const inBox = (await textOf(byTid(page, "composer-input"))).replace(/ /g, " ");
          if (inBox.includes("on in the hall")) h.fail("the live guess is in the box's text");
          if (!inBox.includes("my draft") || !inBox.includes("turn the lights")) h.fail(`the box holds ${J(inBox)}, not the draft and the finished words`);
          await noAuto(page, h, "the listening line");
        } },
      { name: "ended", ready: tidSel("composer-input"),
        go: async (page, h) => {
          await press(page, byTid(page, "voice-dictate"));
          if (!await phaseIs(page, "idle", 10000)) h.fail("the mic did not end dictation");
          await until(async () => (await byTid(page, "dictate-line").count()) === 0, 5000);
        },
        check: async (page, h) => {
          if (await byTid(page, "dictate-line").count()) h.fail("the listening line stays after dictation ended");
          if (!(await textOf(byTid(page, "composer-input"))).includes("turn the lights")) h.fail("the finished words left the box when dictation ended");
          // (Talk is drawn beside the mic only with an empty box: the finished words are in it, so Send is the primary)
        } },
    ] },

  // =============== The speech bar, Auto-send off: Listening, Muted, End keeps the words (3.7.2, mockup 06d, 06s)
  { id: "voice.speech-bar", goal: "3.7.2 · 06 Voice in the composer (the speech bar: Listening, Muted, End)", seed: ["UXV1"], fresh: true, state: "UXV1.plain", wait: tidSel("composer"),
    ls: settings({ autoSend: false }), prepare: (h) => h.mockEval(RESET),
    steps: [
      { name: "listening", ready: tidSel("speech-bar"),
        go: async (page, h) => {
          await voiceOn(page, h);
          await script(h, [{ after: 3, committed: "what is the plan" }, { after: 6, partial: "for the board" }]);
          await press(page, byTid(page, "voice-speech"));
          if (!await phaseIs(page, "listening")) h.fail("speech mode did not start listening");
          if (!await until(async () => /for the board/.test(await textOf(byTid(page, "speech-bar"))), 20000)) h.fail("the heard words never reached the bar");
        },
        check: async (page, h) => {
          const bar = byTid(page, "speech-bar");
          if (await textOf(byTid(page, "speech-state")) !== "Listening") h.fail(`the state word is ${J(await textOf(byTid(page, "speech-state")))}, not "Listening"`);
          for (const id of ["speech-send", "speech-mute", "speech-end"]) if (!await byTid(page, id).count()) h.fail(`the bar has no ${id}`);
          for (const id of ["speech-cancel", "speech-interrupt"]) if (await byTid(page, id).count()) h.fail(`the bar has ${id} while it only listens`);
          if (await textOf(byTid(page, "speech-end")) !== "✕ End" && !/^\S?\s*End$/.test(await textOf(byTid(page, "speech-end")))) h.fail(`End says ${J(await textOf(byTid(page, "speech-end")))}`);
          if (/Auto-send/i.test(await textOf(bar))) h.fail("the bar says \"Auto-send\" (goal 3.7.3)");
          await noAuto(page, h, "the speech bar");
        } },
      { name: "muted", ready: tidSel("speech-bar"),
        go: async (page, h) => {
          await press(page, byTid(page, "speech-mute"));
          if (!await wordIs(page, "Muted", 5000)) h.fail(`Mute: the state word is ${J(await textOf(byTid(page, "speech-state")))}, not "Muted"`);
        },
        check: async (page, h) => { await noAuto(page, h, "the muted bar"); } },
      { name: "end-keeps-words", ready: tidSel("composer-input"),
        go: async (page, h) => {
          await press(page, byTid(page, "speech-mute")); // (unmuted)
          await press(page, byTid(page, "speech-end"));
          if (!await phaseIs(page, "idle", 10000)) h.fail("End did not end speech mode");
          await until(async () => (await byTid(page, "speech-bar").count()) === 0, 5000);
          await sleep(400);
        },
        check: async (page, h) => {
          if (await byTid(page, "speech-bar").count()) h.fail("the bar stays after End");
          const left = (await textOf(byTid(page, "composer-input"))).replace(/ /g, " ");
          if (!left.includes("what is the plan")) h.fail(`End left ${J(left)} in the box, not the heard words as a draft`);
          if (SENT(page.__calls).length) h.fail("End sent the words (they are the draft, not a message)");
        } },
    ] },

  // =============== The speech bar with Auto-send on (the setting in Settings › Voice): the countdown, Thinking…, Speaking
  { id: "voice.speech-bar-send", goal: "3.7.2 · 06 Voice in the composer (the speech bar: Sending in N s, Thinking…, Speaking)", seed: ["UXV1"], fresh: true, state: "UXV1.plain", wait: tidSel("composer"),
    ls: settings({ autoSend: true, pauseMs: 6000 }), prepare: (h) => h.mockEval(RESET),
    steps: [
      { name: "sending-in", ready: tidSel("speech-cancel"),
        go: async (page, h) => {
          await voiceOn(page, h);
          await script(h, [{ after: 3, partial: "what is" }, { after: 6, committed: "what is the plan" }]);
          await reply(h, ANSWER);
          await press(page, byTid(page, "voice-speech"));
          if (!await until(async () => (await byTid(page, "speech-countdown").count()) > 0, 30000)) h.fail("no countdown after the words");
        },
        check: async (page, h) => {
          const w = await textOf(byTid(page, "speech-state"));
          if (!/^Sending in \d+(\.\d)? s$/.test(w)) h.fail(`the countdown's word is ${J(w)}, not "Sending in N s"`);
          if (await textOf(byTid(page, "speech-cancel")) !== "Cancel") h.fail(`the countdown's button says ${J(await textOf(byTid(page, "speech-cancel")))}, not "Cancel"`);
          if (await byTid(page, "speech-interrupt").count()) h.fail("Interrupt is drawn during the countdown");
          if (/Auto-send/i.test(await textOf(byTid(page, "speech-bar")))) h.fail("the bar says \"Auto-send\" (goal 3.7.3)");
          await noAuto(page, h, "the countdown");
        } },
      { name: "thinking", ready: tidSel("speech-bar"),
        go: async (page, h) => { if (!await wordIs(page, "Thinking…")) h.fail(`the state word never became "Thinking…" (${J(await textOf(byTid(page, "speech-state")))})`); },
        check: async (page, h) => {
          if (await byTid(page, "speech-interrupt").count() || await byTid(page, "speech-cancel").count()) h.fail("Thinking… has an action (it has none)");
          const posts = SENT(page.__calls);
          if (posts.length !== 1) h.fail(`${posts.length} messages were sent when the countdown ended, not 1`);
          else if (bodyText(posts[0]) !== "what is the plan") h.fail(`the spoken turn is ${J(bodyText(posts[0]))}, not the words alone`);
        } },
      { name: "speaking", ready: tidSel("speech-interrupt"),
        go: async (page, h) => { if (!await wordIs(page, "Speaking")) h.fail(`the state word never became "Speaking" (${J(await textOf(byTid(page, "speech-state")))})`); },
        check: async (page, h) => {
          if (await textOf(byTid(page, "speech-interrupt")) !== "Interrupt") h.fail(`Interrupt says ${J(await textOf(byTid(page, "speech-interrupt")))}`);
          await noAuto(page, h, "the speaking bar");
        } },
      { name: "ended", ready: tidSel("composer-input"),
        go: async (page, h) => {
          await press(page, byTid(page, "speech-end"));
          if (!await phaseIs(page, "idle", 10000)) h.fail("End did not end speech mode");
          await sleep(400);
        } },
    ] },

  // =============== Set up voice (no key): Talk and Dictate open the sheet; Open Settings › Voice and back (3.7.2, mockup 06a)
  { id: "voice.setup", goal: "3.7.2 · 06 Voice in the composer (Set up voice)", seed: ["UXV1"], fresh: true, state: "UXV1.plain", wait: tidSel("composer"),
    prepare: (h) => h.mockEval(RESET),
    steps: [
      { name: "dictate-sheet", ready: tidSel("setup-voice"),
        go: async (page) => { await press(page, byTid(page, "voice-dictate")); },
        check: async (page, h) => sheetChecks(page, h) },
      { name: "talk-sheet", ready: tidSel("setup-voice"),
        go: async (page, h) => {
          await press(page, byTid(page, "voice-problem-dismiss"));
          if (!await until(async () => (await byTid(page, "setup-voice").count()) === 0, 5000)) h.fail("Not now did not close the sheet");
          await press(page, byTid(page, "voice-speech"));
        },
        check: async (page, h) => sheetChecks(page, h) },
      // (no key yet: Settings › Voice says "Speech mode and the advanced options appear once a key is saved", so Auto-send, one of them, is not said here;
      // the settings group reads the screen with a key, with `autosend: true`)
      { name: "settings-voice", ready: tidSel("vs-screen"),
        go: async (page) => { await press(page, byTid(page, "voice-problem-act")); },
        check: async (page, h) => {
          if (!(await stackNames(page)).includes("voice-settings")) h.fail(`Open Settings › Voice did not push voice-settings (${J(await stackNames(page))})`);
          const word = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="nav-back"]')].pop(); return b ? b.innerText.trim() : null; });
          if (word !== "Settings") h.fail(`the voice screen's back says ${J(word)}, not "Settings"`);
          if (await byTid(page, "setup-voice").count()) h.fail("the Set up voice sheet stays over Settings");
        } },
      { name: "back-in-settings", ready: tidSel("settings-row"),
        go: async (page) => { await press(page, byTid(page, "nav-back").last()); },
        check: async (page, h) => { if ((await stackNames(page)).at(-1) !== "settings") h.fail(`Back from the voice screen did not land on Settings (${J(await stackNames(page))})`); } },
      { name: "back-in-the-chat", ready: tidSel("composer"),
        go: async (page) => { await press(page, byTid(page, "nav-back").last()); },
        check: async (page, h) => {
          if (!/^chat/.test((await stackNames(page)).at(-1) ?? "")) h.fail(`a second Back did not return to the chat (${J(await stackNames(page))})`);
          if (await byTid(page, "setup-voice").count()) h.fail("the sheet is open again in the chat");
        } },
    ] },

  // =============== The board: the docked orb at rest, then a session's voice card (3.4, mockups bd-05a, bd-05b)
  { id: "voice.card", goal: "3.4 · 05 Talking to the board (the docked orb, the voice card)", ...BOARD_RECIPE,
    ls: settings({ autoSend: false, pauseMs: 600 }),
    steps: [
      { name: "orb-at-rest", rules: CANVAS, ready: tidSel("voice-orb"),
        go: async (page, h) => { await voiceOn(page, h); await editHere(page); },
        check: async (page, h) => {
          if (await byTid(page, "board-orb-slot").locator(tidSel("voice-orb")).count() !== 1) h.fail("the orb is not in board-orb-slot");
          if (await byTid(page, "voice-card").count()) h.fail("a voice card is drawn at rest");
          const lab = await attr(byTid(page, "voice-orb"), "aria-label");
          if (lab !== "Talk") h.fail(`the orb's label is ${J(lab)}, not "Talk"`);
          const o = await rect(byTid(page, "voice-orb"));
          if (o.w < 43.5 || o.h < 43.5) h.fail(`the orb is ${Math.round(o.w)} × ${Math.round(o.h)}, under 44`);
        } },
      { name: "card-listening", rules: CANVAS, allow: [CARD], ready: tidSel("voice-card"),
        go: async (page, h) => {
          await selectRect(page);
          await script(h, [{ after: 3, partial: "make it" }, { after: 6, committed: "make it blue" }]);
          await reply(h, "Done. Anything else?", 2, 800);
          await press(page, byTid(page, "voice-orb"));
          await byTid(page, "voice-card").first().waitFor({ state: "visible", timeout: 15000 });
          if (!await until(async () => /make it blue/.test(await textOf(byTid(page, "voice-card-words"))), 20000)) h.fail("the words never reached the card");
        },
        check: async (page, h) => {
          const card = byTid(page, "voice-card"), t = await textOf(card);
          if (!t.includes("To:")) h.fail(`the card does not say "To:" (${J(t)})`);
          if (!/With 1 selected shape(?!s)/.test(t)) h.fail(`the card does not say "With 1 selected shape" (${J(t)})`);
          if (await attr(byTid(page, "voice-orb"), "data-badge") !== "1") h.fail(`the orb's badge is ${J(await attr(byTid(page, "voice-orb"), "data-badge"))}, not 1`);
          if (/Auto-send/i.test(t)) h.fail("the card says \"Auto-send\" (goal 3.7.3)");
          await noAuto(page, h, "the voice card");
          // (the card leaves the bar, the tools and the shape in sight, goal 3.4)
          const C = await rect(card);
          if (meets(C, await rect(byTid(page, "board-bar")))) h.fail("the voice card covers the board's bar");
          const tools = page.locator(".App-toolbar, .layer-ui__wrapper__top-right");
          for (let i = 0; i < await tools.count(); i++) { const r = await tools.nth(i).evaluate((e) => { const b = e.getBoundingClientRect(); return b.width > 1 && b.height > 1 ? { x: b.x, y: b.y, right: b.right, bottom: b.bottom } : null; }); if (r && meets(C, r)) h.fail(`the voice card covers Excalidraw's tools (${await tools.nth(i).evaluate((e) => e.className)} at ${Math.round(r.x)},${Math.round(r.y)} to ${Math.round(r.right)},${Math.round(r.bottom)}; the card at ${Math.round(C.y)})`); }
          if (meets(C, await rectBox(page))) h.fail("the voice card covers the selected shape");
          const x = byTid(page, "voice-card-selection-x");
          if (await x.count()) { const q = await rect(x); if (q.w < 31 || q.h < 31) h.fail(`the selection's × is ${Math.round(q.w)} × ${Math.round(q.h)} before its hit slop`); }
        } },
      { name: "to-sheet", rules: CANVAS, allow: [CARD, { rule: "canvas", match: /overlay|sheet/, why: "goal 3.1.4: a sheet and its backdrop are raised over the screen on purpose and go away" }], ready: tidSel("chats-sheet"),
        go: async (page) => { await press(page, byTid(page, "voice-card-to")); await sleep(500); },
        check: async (page, h) => {
          const sheet = byTid(page, "chats-sheet");
          const t = await textOf(sheet);
          for (const w of ["Layout notes", "Colours", "New chat"]) if (!t.includes(w)) h.fail(`the Chats sheet reached by "To:" does not list ${J(w)} (${J(t.slice(0, 200))})`);
          if (!/Voice/.test(t)) h.fail("the Chats sheet does not mark the chat voice talks to with \"Voice\"");
          await closeSheet(page);
        } },
      { name: "another-chat", ready: tidSel("composer"),
        go: async (page, h) => {
          await openChatFromSheet(page, B2).catch((e) => h.fail(`a row of the Chats sheet did not open its chat: ${e.message.split("\n")[0]}`));
        },
        check: async (page, h) => {
          const name = await textOf(byTid(page, "chat-head-name"));
          if (!name.includes("Colours")) h.fail(`the row "Colours" opened ${J(name)}`);
          if (!await back(page)) h.fail("no Back from the chat to the board");
          if (!await byTid(page, "board-bar").first().isVisible().catch(() => false)) await sleep(500);
        } },
      { name: "card-speaking", rules: CANVAS, allow: [CARD], ready: tidSel("voice-card-interrupt"),
        go: async (page, h) => {
          await byTid(page, "voice-card").first().waitFor({ state: "visible", timeout: 15000 });
          await press(page, byTid(page, "voice-card-send"));
          if (!await until(async () => (await attr(byTid(page, "voice-card"), "data-phase")) === "speaking", 40000)) h.fail(`the card never spoke (phase ${J(await attr(byTid(page, "voice-card"), "data-phase"))})`);
        },
        check: async (page, h) => {
          if (!await byTid(page, "voice-card-open").count()) h.fail("no Open chat while the reply is spoken");
          if (await textOf(byTid(page, "voice-card-interrupt")) !== "Interrupt") h.fail(`Interrupt says ${J(await textOf(byTid(page, "voice-card-interrupt")))}`);
          await noAuto(page, h, "the speaking card");
        } },
      { name: "interrupted", rules: CANVAS, allow: [CARD], ready: tidSel("voice-card"),
        go: async (page, h) => {
          await press(page, byTid(page, "voice-card-interrupt"));
          if (!await until(async () => (await attr(byTid(page, "voice-card"), "data-phase")) !== "speaking", 10000)) h.fail("Interrupt did not cut the spoken reply");
        },
        check: async (page, h) => {
          if (await byTid(page, "voice-card-interrupt").count()) h.fail("Interrupt is still drawn after it cut the reply");
          await noAuto(page, h, "the card after Interrupt");
        } },
      { name: "ended-by-the-orb", rules: CANVAS, ready: tidSel("voice-orb"),
        go: async (page, h) => {
          await press(page, byTid(page, "voice-orb")); // (the orb ends a session that listens)
          if (!await until(async () => (await byTid(page, "voice-card").count()) === 0, 10000)) h.fail("the orb did not end the session (the card stays)");
          await sleep(400);
        } },
    ] },

  // =============== The selection goes to a chat only in speech mode, and only to the chat voice is set to (goal 6.2, 3.4)
  { id: "voice.speech-selection", goal: "3.4 · a selection goes to the voice chat only in speech mode", ...BOARD_RECIPE,
    ls: settings({ autoSend: false, pauseMs: 600 }),
    steps: [
      { name: "selected-outside-speech", rules: CANVAS, ready: tidSel("voice-orb"),
        go: async (page, h) => {
          await voiceOn(page, h);
          page.__before = await mockEval(`return Object.fromEntries(["${B1}", "${B2}"].map((id) => [id, (items[id] ?? []).length]));`, h.url);
          await editHere(page);
          await selectRect(page);
          await sleep(600);
        },
        check: async (page, h) => {
          if (SENT(page.__calls).length) h.fail("selecting a shape sent a message");
          const now = await mockEval(`return Object.fromEntries(["${B1}", "${B2}"].map((id) => [id, (items[id] ?? []).length]));`, h.url);
          if (J(now) !== J(page.__before)) h.fail(`the board's chats changed with a selection alone (${J(page.__before)} → ${J(now)})`);
          const tagged = await mockEval(`return Object.values(chats).filter((c) => /<selection/.test(JSON.stringify(c.draft ?? ""))).map((c) => c.id);`, h.url);
          if (tagged.length) h.fail(`a selection was attached to the draft of ${tagged.join(", ")} outside speech mode`);
          if (await attr(byTid(page, "voice-orb"), "data-badge") !== null) h.fail("the orb has a badge at rest (it counts only what goes with a spoken turn)");
        } },
      { name: "typed-chat-no-selection", ready: tidSel("composer"),
        go: async (page) => { await openChatFromSheet(page, B1); },
        check: async (page, h) => {
          if (await byTid(page, "ctx-chip", { kind: "selection" }).count()) h.fail("the board's chat shows a selection chip with a shape selected outside speech mode");
          const box = (await textOf(byTid(page, "composer-input"))).replace(/ /g, " ");
          if (/<selection/.test(box)) h.fail(`the chat's box holds a selection tag: ${J(box)}`);
          await press(page, byTid(page, "composer-input"));
          await page.keyboard.type("a typed note");
          await press(page, byTid(page, "send"));
          if (!await until(() => SENT(page.__calls).length === 1, 20000)) h.fail("the typed message was not sent");
          else if (/<selection/.test(bodyText(SENT(page.__calls)[0]) ?? "")) h.fail(`a typed message carries a selection: ${J(bodyText(SENT(page.__calls)[0]))}`);
          await back(page);
        } },
      { name: "speech-mode-selected", rules: CANVAS, allow: [CARD], ready: tidSel("voice-card"),
        go: async (page, h) => {
          await byTid(page, "board-bar").first().waitFor({ state: "visible", timeout: 15000 });
          await selectRect(page);
          await script(h, [{ after: 3, partial: "make it" }, { after: 6, committed: "make it blue" }]);
          await reply(h, "Done. Anything else?", 2, 800);
          await press(page, byTid(page, "voice-orb"));
          await byTid(page, "voice-card").first().waitFor({ state: "visible", timeout: 15000 });
          if (!await until(async () => /make it blue/.test(await textOf(byTid(page, "voice-card-words"))), 20000)) h.fail("the words never reached the card");
        },
        check: async (page, h) => {
          if (await attr(byTid(page, "voice-orb"), "data-badge") !== "1") h.fail(`in speech mode the orb's badge is ${J(await attr(byTid(page, "voice-orb"), "data-badge"))}, not 1`);
          const hint = await byTid(page, "voice-orb").first().evaluate((e) => e.getAttribute("aria-description") ?? e.getAttribute("title") ?? (e.getAttribute("aria-describedby") && document.getElementById(e.getAttribute("aria-describedby"))?.textContent) ?? "");
          if (hint && !/1 selected shape go with what you say/.test(hint)) h.fail(`the orb's hint says ${J(hint)}, not "1 selected shape go with what you say"`);
          if (!/With 1 selected shape/.test(await textOf(byTid(page, "voice-card")))) h.fail("the card does not say \"With 1 selected shape\"");
        } },
      { name: "sent-to-the-voice-chat", rules: CANVAS, allow: [CARD], ready: tidSel("voice-card"),
        go: async (page, h) => {
          page.__voiceChat = (await textOf(byTid(page, "voice-card-to"))).replace(/\s*[⌄˅v]$/, "");
          page.__sentBefore = SENT(page.__calls).length;
          await press(page, byTid(page, "voice-card-send"));
          if (!await until(() => SENT(page.__calls).length === page.__sentBefore + 1, 20000)) h.fail("Send sent no message");
        },
        check: async (page, h) => {
          const posts = SENT(page.__calls);
          const post = posts[posts.length - 1];
          if (!post) return;
          const id = MSG.exec(post.path)?.[1];
          const name = await mockEval(`return chats[${J(id)}]?.name ?? null;`, h.url);
          if (!page.__voiceChat.includes(String(name))) h.fail(`the spoken turn went to ${J(name)}, not the chat the card says (${J(page.__voiceChat)})`);
          const text = bodyText(post);
          if (!/^<selection ids="[^"]+" label="[^"]*">[^<]*<\/selection> make it blue$/.test(text)) h.fail(`the spoken turn is ${J(text)}, not the selection's tag and the words`);
          const others = posts.filter((p) => p !== post && /<selection/.test(bodyText(p) ?? ""));
          if (others.length) h.fail("another message carries a selection");
          const tagged = await mockEval(`return Object.values(chats).filter((c) => c.id !== ${J(id)} && /<selection/.test(JSON.stringify(c.draft ?? ""))).map((c) => c.id);`, h.url);
          if (tagged.length) h.fail(`a chat other than the voice chat holds a selection: ${tagged.join(", ")}`);
        } },
    ] },
];

/** The Set up voice sheet (mockup 06a): P1's head, no Cancel row, Open Settings › Voice the primary, Not now a full-width text button. */
async function sheetChecks(page, h) {
  const sheet = byTid(page, "setup-voice"), t = await textOf(sheet);
  for (const w of ["Set up voice", "ElevenLabs", "Open Settings › Voice", "Not now"]) if (!t.includes(w)) h.fail(`the sheet lacks ${J(w)} (it says ${J(t.slice(0, 200))})`);
  if (await sheet.locator("input, textarea").count()) h.fail("the sheet has a key field (only Settings has one)");
  if (await sheet.getByText(/^Cancel$/).count()) h.fail("the sheet has a Cancel (Not now is the close)");
  if (await byTid(page, "voice-problem", { kind: "no_key" }).count() !== 1) h.fail("no voice-problem of kind no_key");
  const act = await rect(byTid(page, "voice-problem-act")), no = await rect(byTid(page, "voice-problem-dismiss")), s = await rect(byTid(page, "sheet-body"));
  if (act.y > no.y) h.fail("Open Settings › Voice is not above Not now");
  if (no.w < s.w * 0.8) h.fail(`Not now is ${Math.round(no.w)} pt wide in a ${Math.round(s.w)} pt sheet, not a full-width button`);
  if (act.h < 49) h.fail(`Open Settings › Voice is ${Math.round(act.h)} pt tall, not the 50 pt primary`);
}

/** The first drawn background of the mic button (what the accent fill is read from), "" when it has none. */
function fillOf(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="voice-dictate"]');
    if (!root) return "";
    for (let e = root.querySelector("[aria-label]") ?? root; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (!/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(c)) return c;
      if (e === root) break;
    }
    return "";
  });
}
