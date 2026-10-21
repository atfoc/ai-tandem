// VC.2 (new, voice-chats P16): the popover of every voice problem, on the mock with the stand-in voice service mounted at /voice (dev/voicestandin.mjs),
// at the desktop and the phone. Goal 3.8, 4.7, 6.4; architecture VC-30. Each control that can start voice (Dictate, Speech mode, Read aloud, the board's
// orb) is pressed with no key and then with each failure the stand-in can make; what must hold after each is the same.
//   no key        each of the four shows "Voice needs your ElevenLabs key. It stays on this device." with **Open Settings** and **Not now**, hung from the
//                 control, and starts nothing: no request to the voice service, no getUserMedia call, no session. Not now closes it; Open Settings lands on
//                 Settings > Voice (the dialog, its key section, `settingsOpen`)
//   the failures  a rejected key (401) "ElevenLabs did not accept this key." with Open Settings; no credits (402) and a rate limit (429) "Your ElevenLabs
//                 plan has no credits left." with Open ElevenLabs (the account page, https://elevenlabs.io/app/subscription: the check holds `window.open`
//                 and nothing is opened); a blocked microphone "The app can't hear you. Turn on the microphone in system settings." (the web build cannot
//                 open system settings: Not now alone); offline "Can't reach ElevenLabs." with Try again, which tries the same control again and listens
//   the chat      after each, the chat still sends text: the message goes by the ordinary POST and is in the thread; no session is left over, and the
//                 popover is gone
// The words are the goal's table (3.8), written out here and not read from app/src/voice/words.ts, so that a change of a sentence fails this check.
// The microphone is mic.mjs's where a microphone is needed (Try again). OUT=/tmp/x keeps a screenshot of the page in each state there.
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { useMic } from "./mic.mjs";
import { openBoard, openChat, press, byTid } from "./sel.mjs";
import { pressAct } from "./fork.mjs";

export const viewports = ["desktop", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_VC2CANARY5";
const CHAT = "c_A4_turns", BOARD = "b_ui", BOARD_CHAT = "c_A2_sketch";
const MSG = /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages(\?|$)/;
const J = JSON.stringify;

const WORDS = {
  no_key: { sentence: "Voice needs your ElevenLabs key. It stays on this device.", action: "Open Settings" },
  key_rejected: { sentence: "ElevenLabs did not accept this key.", action: "Open Settings" },
  no_credits: { sentence: "Your ElevenLabs plan has no credits left.", action: "Open ElevenLabs" },
  mic_blocked: { sentence: "The app can't hear you. Turn on the microphone in system settings.", action: null }, // (the web build has no system settings to open)
  offline: { sentence: "Can't reach ElevenLabs.", action: "Try again" },
};
const ACCOUNT = "https://elevenlabs.io/app/subscription";

await check("VC.2 the voice problems: no key, a rejected key, no credits, a rate limit, a blocked microphone, offline, on every control", async ({ url, viewport, layout, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const log = () => mockEval("return voice.log();", url);
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.2-${viewport}-${name}.png`) }); } };
  const box = (p) => byTid(p, "composer-input").first();
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const posts = (calls, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && MSG.test(c.path));
  const bodyText = (c) => (c.body && typeof c.body === "object" ? c.body.text : c.body);
  let serial = 0;

  /** Counts the page's calls to getUserMedia, and holds window.open (the link of Open ElevenLabs) so that nothing is opened. */
  const instrument = (p) => p.evaluate(() => {
    window.__gum = 0;
    const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return g(...a); };
    window.__opened = [];
    window.open = (u) => { window.__opened.push(String(u)); return null; };
  });

  // ---- the four controls
  /** A control of the composer: in the row, or in the open "more" popup when the row has no room. Pressed. */
  const pressTool = async (p, row, more) => {
    // (a page just opened is still measuring its toolbar: the pair is drawn in the row until its width is kept, then placed. Wait for a place that stays.)
    let last = "";
    for (let i = 0; i < 40; i++) {
      const at = await p.evaluate(() => { const t = document.querySelector('[data-testid="composer-tools"]'); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; });
      if (at && at === last) break;
      last = at;
      await sleep(150);
    }
    if (await byTid(p, row).count()) { await press(p, byTid(p, row)); return; }
    await press(p, byTid(p, "more-chip"));
    if (!await until(() => byTid(p, more).count(), 5000)) throw new Error(`${row} is neither in the row nor in the "more" popup`);
    await press(p, byTid(p, more));
  };
  const controls = {
    dictate: { name: "Dictate", press: (p) => pressTool(p, "voice-dictate", "more-dictate") },
    speech: { name: "Speech mode", press: (p) => pressTool(p, "voice-speech", "more-speech") },
    read: { name: "Read aloud", press: async (p) => { await pressAct(p, byTid(p, "msg", { role: "assistant" }).last(), "read"); } },
    orb: { name: "the orb", press: async (p) => { await press(p, byTid(p, "pill-orb")); } },
  };

  /** Waits for the popover, and reads it. */
  const popover = async (p) => {
    const pop = byTid(p, "voice-problem");
    if (!await until(() => pop.count(), 15000)) return null;
    return { kind: await pop.first().getAttribute("data-kind"), text: await textOf(byTid(p, "voice-problem-text")), buttons: (await pop.first().getByRole("button").allTextContents()).map((s) => s.trim()) };
  };
  /** The popover is `kind`, with its sentence and its action (and Not now), and it is dismissed or acted on afterwards by `then`. */
  const expect = async (p, what, kind) => {
    const got = await popover(p);
    const w = WORDS[kind];
    if (!got) { fail(`${what}: no popover`); return false; }
    if (got.kind !== kind) fail(`${what}: the popover is "${got.kind}" (${J(got.text)}), not "${kind}"`);
    if (got.text !== w.sentence) fail(`${what}: the popover says ${J(got.text)}, not ${J(w.sentence)}`);
    const want = w.action ? ["Not now", w.action] : ["Not now"];
    if (got.buttons.join() !== want.join()) fail(`${what}: the popover's buttons are ${J(got.buttons)}, not ${J(want)}`);
    return got.kind === kind;
  };
  const dismiss = async (p, what) => {
    await press(p, byTid(p, "voice-problem-dismiss"));
    if (!await gone(byTid(p, "voice-problem"))) fail(`${what}: Not now leaves the popover`);
  };
  /** Nothing is left running, and the voice service was asked for nothing when `nothing` says so. */
  const quiet = async (p, what, { nothing = false } = {}) => {
    if (!await until(async () => (await sess(p)).phase === "idle", 8000)) fail(`${what}: a session is left over: ${J(await sess(p))}`);
    if (nothing) {
      const l = await log();
      if (l.length) fail(`${what}: the voice service was asked for ${J(l.map((e) => e.kind))}`);
      if (await p.evaluate(() => window.__gum)) fail(`${what}: getUserMedia was called`);
    }
  };
  /** The settings page opens on Voice; closes it. */
  const settingsLands = async (p, what) => {
    const dlg = byTid(p, "settings-dialog");
    if (!await until(() => dlg.first().isVisible().catch(() => false), 10000)) { fail(`${what}: Open Settings opened no Settings page`); return; }
    if (!await until(() => byTid(p, "vs-key-section").first().isVisible().catch(() => false), 5000)) fail(`${what}: Settings opened, but not on the voice key`);
    if (!/Voice/.test(await textOf(dlg)) || !(await p.evaluate(() => window.__aiwbVoice.state().settingsOpen))) fail(`${what}: the page that opened is not Settings > Voice`);
    await press(p, byTid(p, "vs-close"));
    if (!await gone(dlg)) fail(`${what}: Settings stays open after Close`);
  };
  /** The chat still sends text: a message typed after the problem goes by the ordinary POST and is in the thread. `to`: the chat's id. */
  const sends = async (p, what, calls, to = CHAT) => {
    const text = `still text ${++serial}`;
    const from = calls.length;
    // (a popover that closes gives the focus back to the control it hung from, a moment after it is gone: the box is pressed until it holds the focus)
    await sleep(400);
    for (let i = 0; i < 5; i++) {
      await press(p, box(p));
      if (await until(() => box(p).evaluate((e) => e.contains(document.activeElement)), 1500)) break;
    }
    await p.keyboard.type(text);
    // (the mock's agent takes a moment to answer the message before, and Send waits for it)
    if (!await until(async () => !(await byTid(p, "send").first().isDisabled()), 40000)) { fail(`${what}: Send stays off after the problem (${J(await byTid(p, "send").first().evaluate((e) => e.outerHTML.slice(0, 300)))}; the box ${J(await textOf(box(p)))})`); return; }
    await press(p, byTid(p, "send").first());
    const sent = await until(() => posts(calls, from).find((c) => bodyText(c) === text), 15000);
    if (!sent) fail(`${what}: the typed message was not sent after the problem`);
    else if (!sent.path.includes(`/chats/${to}/`)) fail(`${what}: the message went to ${sent.path}`);
    if (!await until(async () => (await byTid(p, "msg", { role: "user" }).filter({ hasText: text }).count()) > 0, 15000)) fail(`${what}: the typed message is not in the thread`);
    // (the turn runs to its end, and the server's clearing of the draft reaches the box, before anything else is typed: a late one would empty the next text)
    await until(async () => !(await byTid(p, "stop").count()), 40000);
    await sleep(1500);
  };
  /** The board's chat is open for a moment to send text, and the board is back after. */
  const sendsViaChat = async (p, what, calls) => {
    await openChat(p, BOARD_CHAT);
    await box(p).waitFor({ state: "visible", timeout: 15000 });
    await sends(p, what, calls, BOARD_CHAT);
    await openBoard(p, BOARD);
    await byTid(p, "pill-orb").first().waitFor({ state: "visible", timeout: 15000 });
  };

  /** Presses a control and expects a problem. `then`: "dismiss" (Not now), "settings" (Open Settings lands on Voice), "link" (Open ElevenLabs
   *  opens the account page), "retry" (Try again), "none" (leave it). Answers whether the popover was as expected. */
  const problem = async (p, key, kind, { calls, what, then = "dismiss", via }) => {
    const name = `${what} / ${kind}`;
    await controls[key].press(p);
    const ok = await expect(p, name, kind);
    await shot(p, `${key}-${kind}`);
    if (ok && then === "settings") { await press(p, byTid(p, "voice-problem-act")); await settingsLands(p, name); }
    else if (ok && then === "link") {
      await press(p, byTid(p, "voice-problem-act"));
      const opened = await p.evaluate(() => window.__opened);
      if (opened.join() !== ACCOUNT) fail(`${name}: Open ElevenLabs opened ${J(opened)}, not ${ACCOUNT}`);
      await p.evaluate(() => { window.__opened = []; });
    } else if (ok && then === "dismiss") await dismiss(p, name);
    else if (!ok) await byTid(p, "voice-problem-dismiss").first().click({ timeout: 2000 }).catch(() => {});
    if (!await gone(byTid(p, "voice-problem"), 5000)) await dismiss(p, name);
    if (then !== "retry") {
      await quiet(p, name, { nothing: kind === "no_key" });
      await (via ?? sends)(p, name, calls);
    }
    return ok;
  };

  // ---- the chat: a conversation with replies, on the composer's page
  await seed(url, "A2", "A4");
  {
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="msg"]' });
    await page.waitForFunction(() => !!window.__aiwbVoice, null, { timeout: 30000 });
    await byTid(page, "send").first().waitFor({ state: "visible", timeout: 15000 });
    await instrument(page);
    await mockEval("voice.reset();", url);
    const calls = callsOf(page);
    const msg = byTid(page, "msg", { role: "assistant" });
    if (!await until(async () => (await msg.count()) > 0, 10000)) fail("the chat has no reply to read");

    // ---- no key: each control, Not now, then Open Settings
    for (const key of ["dictate", "speech", "read"]) {
      await problem(page, key, "no_key", { calls, what: controls[key].name, then: "dismiss" });
      await problem(page, key, "no_key", { calls, what: controls[key].name, then: "settings" });
    }
    await shot(page, "chat-nokey");

    // ---- with a key: each failure
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    await useMic(page, note);
    const say = async (f, run) => { await mockEval(`voice.reset(); voice.fail(${J(f)}); return 1;`, url); try { await run(); } finally { await mockEval("voice.fail(null); return 1;", url); } };

    await say("key_rejected", async () => {
      await problem(page, "dictate", "key_rejected", { calls, what: "Dictate", then: "settings" });
      await problem(page, "read", "key_rejected", { calls, what: "Read aloud", then: "dismiss" });
    });
    await say("no_credits", async () => {
      await problem(page, "speech", "no_credits", { calls, what: "Speech mode", then: "link" });
      await problem(page, "read", "no_credits", { calls, what: "Read aloud", then: "link" });
    });
    await say("rate_limited", async () => {
      await problem(page, "dictate", "no_credits", { calls, what: "Dictate (rate limited)", then: "link" });
    });
    await say("offline", async () => {
      await problem(page, "speech", "offline", { calls, what: "Speech mode", then: "dismiss" });
      await problem(page, "read", "offline", { calls, what: "Read aloud", then: "dismiss" });
    });

    // Try again: the same control, once the service is back, listens
    {
      await mockEval("voice.reset(); voice.fail('offline'); return 1;", url);
      await controls.dictate.press(page);
      if (await expect(page, "Dictate / offline (to try again)", "offline")) {
        await mockEval("voice.fail(null); return 1;", url);
        await press(page, byTid(page, "voice-problem-act"));
        if (!await gone(byTid(page, "voice-problem"), 5000)) fail("Try again leaves the popover");
        if (!await until(async () => (await sess(page)).phase === "listening", 20000)) fail(`Try again did not start listening: the session is ${J(await sess(page))}, the problem ${J(await page.evaluate(() => window.__aiwbVoice.state().problem))}`);
        else if ((await sess(page)).owner?.kind !== "dictation") fail(`Try again started ${J((await sess(page)).owner)}, not the dictation that failed`);
        await controls.dictate.press(page); // (a second press stops)
        await until(async () => (await sess(page)).phase === "idle", 15000);
      }
      await sends(page, "after Try again", calls);
    }

    // a blocked microphone: the popover says so, with no system settings to open here
    await page.evaluate(() => window.__aiwbVoice.denyMic(true));
    await mockEval("voice.reset(); return 1;", url);
    await problem(page, "dictate", "mic_blocked", { calls, what: "Dictate" });
    await problem(page, "speech", "mic_blocked", { calls, what: "Speech mode" });
    await page.evaluate(() => window.__aiwbVoice.denyMic(false));
    if ((await log()).some((e) => e.kind === "stt")) fail("a socket to the voice service was opened with the microphone blocked");
    await ctx.close();
  }

  // ---- the board: the orb
  {
    await sleep(1000); // (the page before saves its draft as it closes)
    await seed(url, "A2");
    const { page, ctx } = await open({ sel: { board: BOARD, chat: null }, wait: '[data-testid="board-canvas"]' });
    await page.waitForFunction(() => !!window.__aiwbVoice, null, { timeout: 30000 });
    await byTid(page, "pill-orb").first().waitFor({ state: "visible", timeout: 30000 });
    await instrument(page);
    await mockEval("voice.reset();", url);
    const calls = callsOf(page);
    const via = (p, what, c) => sendsViaChat(p, what, c);

    await problem(page, "orb", "no_key", { calls, what: "the orb", then: "dismiss", via });
    await problem(page, "orb", "no_key", { calls, what: "the orb", then: "settings", via });
    await shot(page, "board-nokey");

    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    await useMic(page, note);
    const say = async (f, run) => { await mockEval(`voice.reset(); voice.fail(${J(f)}); return 1;`, url); try { await run(); } finally { await mockEval("voice.fail(null); return 1;", url); } };
    await say("key_rejected", () => problem(page, "orb", "key_rejected", { calls, what: "the orb", then: "settings", via }));
    await say("no_credits", () => problem(page, "orb", "no_credits", { calls, what: "the orb", then: "link", via }));
    await say("rate_limited", () => problem(page, "orb", "no_credits", { calls, what: "the orb (rate limited)", then: "link", via }));
    await page.evaluate(() => window.__aiwbVoice.denyMic(true));
    await mockEval("voice.reset(); return 1;", url);
    await problem(page, "orb", "mic_blocked", { calls, what: "the orb", via });
    await page.evaluate(() => window.__aiwbVoice.denyMic(false));
    await say("offline", () => problem(page, "orb", "offline", { calls, what: "the orb", then: "dismiss", via }));

    // Try again from the orb listens
    await mockEval("voice.reset(); voice.fail('offline'); return 1;", url);
    await controls.orb.press(page);
    if (await expect(page, "the orb / offline (to try again)", "offline")) {
      await mockEval("voice.fail(null); return 1;", url);
      await press(page, byTid(page, "voice-problem-act"));
      if (!await until(async () => (await sess(page)).phase === "listening" && (await sess(page)).owner?.kind === "pill", 20000)) fail(`Try again on the orb did not start the pill: the session is ${J(await sess(page))}`);
      await controls.orb.press(page); // (a press on a listening orb ends it)
      await until(async () => (await sess(page)).phase === "idle", 15000);
    }
    await via(page, "after Try again on the orb", calls);
    if ((await log()).some((e) => e.kind === "tts")) fail("a problem led to a TTS request");
    await ctx.close();
  }
  note("no key, a rejected key, no credits, a rate limit, a blocked microphone and offline each showed their sentence and action; the chat sent text after each");
}, { viewports, page: false, allowConsole: [/status of 40[0-9]/, /status of 429/] });
