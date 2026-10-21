// VC.6 (voice-chats P15a, P15b): the board's voice pill on the mock with the stand-in voice service, at the desktop, the tablet and the phone.
// Goal 3.6, 4.5, 4.6, 4.7, 6.5; architecture VC-28 and VC-29.
//   the shell      a board that is not archived has the pill over its canvas, bottom centre and inside the window; a chat alone, and an archived board, have none
//   no key         the orb shows the problem popover ("Voice needs your ElevenLabs key"), hung from the orb, and the microphone is not asked for
//   orb states     idle, listening (a ring that follows the voice, the live waveform and the words), countdown (the ring fills, the seconds,
//                  Cancel), waiting (the ↑ badge), thinking and speaking are reached by a scripted turn and read from `pill-orb`'s data-state
//   sizes          compact (chip, + New chat, orb) → the listening bar while the person listens or words wait → collapsed to the orb alone
//                  (kept in the kv port), which still shows its ring or its ↑ badge
//   Auto-send      the pill's toggle is the voice setting: changed in the pill it is changed in Settings, and back
//   cancel, send   Cancel keeps the words and sends nothing; Send and the ↑ badge send them as an ordinary message to the target chat
//   the target     with no chat on the board the first spoken turn makes one (under the board's row in the sidebar, the chat view not opened);
//                  with chats the target is the chat used last; + New chat and the sidebar's + each make a chat that becomes the target at
//                  once; the chip lists the sidebar's chats, with Show all for the archived ones; a pick is the new target
//   the popover    a microphone that is blocked shows its sentence on the orb and the pill is idle again
//   captions       (P15b) `caption-said` carries the words of the turn where the bar does not (the collapsed orb; the compact pill from the send until the
//                  reply starts, however long the agent takes) and `caption-spoken` the sentence being spoken, which stays after the reply ends and fades
//                  4 s later; the listening bar shows the words itself and has no caption of them
//   Thinking       (P15b) while the turn is on its way the orb is `thinking` and an agent's edit (the mock's `rpc` knob, an `apply`) shows on the board:
//                  its outline (`flash`) is drawn and the shape reaches the stored scene; the reply's first sentence ends the Thinking state
//   speaking       (P15b) the spoken sentence is the caption, and a tap on the orb stops it: nothing more is written to the player or asked of the voice service
//   the selection  (P15b) `pill-selection` reads "3 selected" with the board's selection (this window the board's writer), the spoken turn's text is the
//                  selection's tag and then the words, × leaves it out of that turn (the text is the words alone) and it is back for the next one
//   hold Space     (P15b, desktop and tablet: a keyboard) a tap of Space is a tap on the orb (listens, a second tap ends); holding it listens while it is down
//                  (`pill` data-held), keeps Auto-send's countdown from sending, and the release sends the turn; a release with no words shuts the microphone
//                  and sends nothing; Space does nothing while the focus is in a text box or in the board's canvas (there it pans)
// OUT=/tmp/x keeps a screenshot of the pill in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { act, back, byTid, hover, openBoard, press, tidSel } from "./sel.mjs";
import { editHere } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_VC6CANARY1";
const BOARD = "b_ui", CHAT = "c_A2_sketch", EMPTY = "b_vc6";
const SAID = "draw a red box";

await check("VC.6 the board's voice pill: states, sizes, the target chat, + New chat, Auto-send", async ({ url, viewport, layout, touch, open, fail, note }) => {
  const wide = layout !== "phone";
  const shot = async (p, name, still = true) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); if (still) await atRest(p, 6).catch(() => {}); // (a ring that fills and a spinner never rest)
    await p.screenshot({ path: path.join(OUT, `VC.6-${viewport}-${name}.png`) }); } };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const shown = (loc, ms = 15000) => until(() => loc.first().isVisible().catch(() => false), ms);
  const gone = (loc) => until(async () => (await loc.count()) === 0);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const attr = (loc, a) => loc.first().getAttribute(a).catch(() => null);
  const orbState = (p) => attr(byTid(p, "pill-orb"), "data-state");
  const pillSize = (p) => attr(byTid(p, "pill"), "data-size");
  const inState = (p, s, ms = 15000) => until(async () => (await orbState(p)) === s, ms);
  const settings = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const sessionOf = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const log = () => mockEval("return voice.log();", url);
  const script = (words = SAID) => mockEval(`voice.script([{ after: 3, partial: ${JSON.stringify(words.split(" ").slice(0, 2).join(" "))} }, { after: 6, committed: ${JSON.stringify(words)} }]); return 1;`, url);
  const reply = (text = "Sure. I drew it. Anything else?", pace = 300, parts = 6) => mockEval(`flags.reply = { text: ${JSON.stringify(text)}, parts: ${parts}, pace: ${pace} }; return 1;`, url);
  const J = JSON.stringify;
  /** Presses the orb until the session is over (a speaking orb is interrupted by the first press, a listening one ended by the next). */
  const endTurn = async (p) => { for (let i = 0; i < 4 && await orbState(p) !== "idle"; i++) { await press(p, byTid(p, "pill-orb")); await sleep(300); } return inState(p, "idle", 8000); };
  const lsSettings = (o) => JSON.stringify({ autoSend: true, pauseMs: 600, ...o });
  const messages = (calls) => calls.filter((c) => c.method === "POST" && /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages/.test(c.path));
  /** A microphone that is a tone from the page's own audio context: the pill's states do not depend on real capture (VC.3 and VC.4 prove it), and
   *  Chromium's fake device does not answer getUserMedia on every machine (it hangs on the 153 of the one this was written on). */
  const toneMic = (p) => p.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext(), o = ac.createOscillator(), g = ac.createGain(), d = ac.createMediaStreamDestination();
      g.gain.value = 0.3; o.connect(g); g.connect(d); o.start(); await ac.resume();
      return d.stream;
    };
  });
  /** The page, with a key and the board open (the chat view not). */
  const start = async (o = {}) => {
    const { ctx, page } = await open({ sel: { board: o.board ?? BOARD, chat: null }, ls: { "aiwb.voice.settings": lsSettings(o.settings), ...o.ls }, wait: tidSel("board-canvas", { board: o.board ?? BOARD }) });
    const calls = callsOf(page);
    await toneMic(page);
    if (o.key !== false) await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    if (!await shown(byTid(page, "pill-orb"))) throw new Error("the board shows no pill");
    return { ctx, page, calls };
  };

  await seed(url, "A2");
  await mockEval(`boards.${EMPTY} = { id: ${JSON.stringify(EMPTY)}, name: "Empty", group: boards.${BOARD}.group, created: new Date().toISOString() }; scenes.${EMPTY} = JSON.parse(JSON.stringify(scenes.${BOARD})); return 1;`, url);

  await mockEval(`boards.b_vc6_arch = { id: "b_vc6_arch", name: "Old board", group: boards.${BOARD}.group, created: new Date().toISOString(), archived: true, archiveOp: "op_vc6b" }; scenes.b_vc6_arch = JSON.parse(JSON.stringify(scenes.${BOARD})); return 1;`, url);
  await mockEval(`const a = JSON.parse(JSON.stringify(chats.${CHAT})); a.id = "c_vc6_old"; a.name = "Old sketch chat"; a.archived = true; a.archiveOp = "op_vc6"; chats.c_vc6_old = a; return 1;`, url);
  /** Records the orb's states from now on (every 20 ms, each change once), in window.__orbStates. */
  const record = (p) => p.evaluate(() => {
    window.__orbStates = [];
    clearInterval(window.__orbTimer);
    window.__orbTimer = setInterval(() => { const s = document.querySelector('[data-testid="pill-orb"]')?.getAttribute("data-state") ?? "none"; const l = window.__orbStates; if (l[l.length - 1] !== s) l.push(s); }, 20);
  });
  const recorded = (p) => p.evaluate(() => window.__orbStates);

  // ---- the shell
  {
    const { ctx, page } = await start({ key: false });
    const pill = byTid(page, "pill").first(), orb = byTid(page, "pill-orb").first();
    if (await pillSize(page) !== "compact" || await orbState(page) !== "idle") fail(`the pill starts ${await pillSize(page)} / ${await orbState(page)}, not compact / idle`);
    for (const id of ["pill-chip", "pill-new", "pill-collapse"]) if (!await byTid(page, id).count()) fail(`the compact pill has no ${id}`);
    const box = await pill.boundingBox(), win = page.viewportSize();
    if (!box || box.x < 0 || box.x + box.width > win.width + 1 || box.y + box.height > win.height) fail(`the pill is not inside the window: ${JSON.stringify(box)} in ${win.width}x${win.height}`);
    else {
      const mid = box.x + box.width / 2;
      const canvas = await byTid(page, "board-canvas").first().boundingBox();
      const cmid = canvas.x + canvas.width / 2;
      if (Math.abs(mid - cmid) > 2) fail(`the pill is not at the bottom centre of the canvas: its middle is ${Math.round(mid)}, the canvas's ${Math.round(cmid)}`);
      if (box.y < canvas.y + canvas.height / 2) fail("the pill is not in the lower half of the canvas");
    }
    await shot(page, "1-idle");
    await ctx.close();
  }

  // ---- no key: the orb shows the problem popover and nothing else happens
  {
    const { ctx, page } = await start({ key: false });
    await press(page, byTid(page, "pill-orb"));
    if (!await shown(byTid(page, "voice-problem"))) fail("the orb with no key shows no popover");
    else {
      if (await attr(byTid(page, "voice-problem"), "data-kind") !== "no_key") fail("the popover is not the no-key one");
      if (wide) {
        const p = await byTid(page, "voice-problem").first().boundingBox(), o = await byTid(page, "pill-orb").first().boundingBox();
        if (p && o && p.y + p.height > o.y + o.height) fail(`the popover is not above the orb: it ends at ${Math.round(p.y + p.height)}, the orb ends at ${Math.round(o.y + o.height)}`);
      }
      await shot(page, "2-nokey");
      await press(page, byTid(page, "voice-problem-dismiss"));
      if (!await gone(byTid(page, "voice-problem"))) fail("Not now leaves the popover");
    }
    if (await orbState(page) !== "idle") fail("the pill is not idle after the no-key popover");
    if ((await log()).some((e) => e.kind === "stt")) fail("a socket to the voice service was opened with no key");
    await ctx.close();
  }

  // ---- a turn with Auto-send: listening, countdown, Cancel, the ↑ badge, thinking, speaking, interrupt
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { pauseMs: 3000 } });
    await script();
    await reply("I drew the red box for you. It sits on the left of the board. Tell me if you want more.", 300);
    await record(page);
    await press(page, byTid(page, "pill-orb"));
    if (!await inState(page, "listening")) fail(`the orb is ${await orbState(page)} after a tap, not listening`);
    if (!await until(async () => (await pillSize(page)) === "listening")) fail(`the pill is ${await pillSize(page)} while listening, not the listening bar`);
    if (!await shown(byTid(page, "pill-wave"))) fail("the listening bar has no waveform");
    if (!await shown(byTid(page, "pill-ring"))) fail("the listening orb has no ring");
    if (await byTid(page, "pill-chip").count() || await byTid(page, "pill-new").count()) fail("the listening bar still has the chip and + New chat");
    await shot(page, "3-listening", false);
    if (!await until(async () => (await textOf(byTid(page, "pill-words"))).includes(SAID))) fail(`the bar shows "${await textOf(byTid(page, "pill-words"))}", not the words said`);
    if (!await inState(page, "countdown")) fail("Auto-send showed no countdown");
    else {
      const frac = () => attr(byTid(page, "pill-countdown-ring"), "data-frac").then(Number);
      const a = await frac(); await sleep(500); const b = await frac();
      if (!(b > a)) fail(`the ring does not fill: ${a} then ${b}`);
      if (!/^\d\.\d s$/.test(await textOf(byTid(page, "pill-countdown")).then((t) => t.replace(/Cancel/, "").trim()))) fail(`the countdown reads "${await textOf(byTid(page, "pill-countdown"))}"`);
      await shot(page, "4-countdown", false);
      await press(page, byTid(page, "pill-cancel"));
      if (!await inState(page, "waiting")) fail(`Cancel leaves the orb ${await orbState(page)}, not waiting`);
      if (await byTid(page, "pill-countdown").count()) fail("the countdown stays after Cancel");
      if (!(await textOf(byTid(page, "pill-words"))).includes(SAID)) fail("Cancel does not keep the words");
      if (!await shown(byTid(page, "pill-badge"))) fail("the waiting orb has no ↑ badge");
      await sleep(1500);
      if (messages(calls).length) fail("a turn was sent after Cancel");
      if (await orbState(page) !== "waiting") fail("the pill left waiting by itself after Cancel");
      await shot(page, "5-waiting");
      await press(page, byTid(page, "pill-badge"));
      if (!await until(() => messages(calls).length === 1)) fail("the ↑ badge sent no message");
      else {
        const m = messages(calls)[0];
        if (!m.path.includes(CHAT)) fail(`the turn went to ${m.path}, not to chat ${CHAT}`);
        if (m.body?.text !== SAID) fail(`the message says ${JSON.stringify(m.body?.text)}, not ${JSON.stringify(SAID)}`);
      }
    }
    if (!await until(async () => (await recorded(page)).includes("speaking"), 30000)) fail(`the orb was ${JSON.stringify(await recorded(page))}: it never spoke`);
    else {
      const seen = (await recorded(page)).join(",");
      if (!/thinking.*speaking/.test(seen)) fail(`the orb went ${seen}: thinking did not come before speaking`);
      if (!await shown(byTid(page, "caption-spoken"), 8000)) fail("the sentence being spoken is not a caption");
      else {
        const said = await textOf(byTid(page, "caption-spoken"));
        if (!"I drew the red box for you. It sits on the left of the board. Tell me if you want more.".includes(said) || said.length < 8) fail(`the spoken caption reads "${said}", not a sentence of the reply`);
        if (await byTid(page, "caption-said").count()) fail("the words of the turn are still a caption while the reply is spoken");
      }
      await shot(page, "6-speaking", false);
      await press(page, byTid(page, "pill-orb"));
      if (!await until(async () => (await orbState(page)) !== "speaking")) fail("a tap on the speaking orb does not interrupt it");
      else {
        // (what is proved is that nothing more is written to the player and no more sentences are asked for; the player's own stop is counted only while sound is queued)
        const tts = async () => (await log()).filter((e) => e.kind === "tts").length;
        const w0 = await page.evaluate(() => window.__aiwbVoice.player().writes), n0 = await tts();
        await sleep(1200);
        if ((await page.evaluate(() => window.__aiwbVoice.player().writes)) !== w0) fail("sound was still written to the player after the tap interrupted the reply");
        if (await tts() !== n0) fail("a sentence was asked for after the tap interrupted the reply");
        if (await orbState(page) !== "listening") fail(`after the interrupt the orb is ${await orbState(page)}, not listening again`);
      }
    }
    if (await byTid(page, "chat-head").count()) fail("the chat view opened for a spoken turn");
    await press(page, byTid(page, "pill-orb"));
    if (!await inState(page, "idle") || !await until(async () => (await pillSize(page)) === "compact")) fail("a tap on the listening orb does not end the session");
    await ctx.close();
  }

  // ---- the pill is the canvas's: a chat alone and an archived board have none
  {
    const plain = await open({ sel: { chat: "c_plain" }, wait: tidSel("chat-head") });
    await sleep(500);
    if (await byTid(plain.page, "pill").count()) fail("a chat with no board shows the pill");
    await plain.ctx.close();
    const old = await open({ sel: { board: "b_vc6_arch", chat: null }, wait: tidSel("board-canvas", { board: "b_vc6_arch" }) });
    await sleep(500);
    if (await byTid(old.page, "pill").count()) fail("an archived board shows the pill");
    await old.ctx.close();
  }

  // ---- Auto-send is one setting: the pill's toggle, the speech bar's and Settings' (the speech bar's is P13b's: the seam and Settings stand for it)
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page } = await start();
    await press(page, byTid(page, "pill-orb"));
    if (!await until(async () => (await pillSize(page)) === "listening")) fail("the pill did not grow to the listening bar");
    const sw = byTid(page, "pill-autosend");
    if (await attr(sw, "data-on") !== "true" || (await settings(page)).autoSend !== true) fail("Auto-send is not on by default in the pill");
    await press(page, sw);
    if (!await until(async () => (await settings(page)).autoSend === false) || await attr(sw, "data-on") !== "false") fail("the pill's toggle does not change the voice setting");
    if (wide) {
      await press(page, byTid(page, "settings-btn").first());
      if (!await shown(byTid(page, "settings-dialog"))) fail("the foot's Settings button opened no dialog");
      else {
        if (await attr(byTid(page, "vs-autosend-false"), "aria-checked") !== "true") fail("Settings does not show what the pill chose (Tap to send)");
        await press(page, byTid(page, "vs-autosend-true"));
        if (!await until(async () => (await attr(byTid(page, "pill-autosend"), "data-on")) === "true")) fail("Settings' Auto-send does not reach the pill's toggle");
        await press(page, byTid(page, "vs-close"));
        await gone(byTid(page, "settings-dialog"));
        await press(page, byTid(page, "pill-autosend"));
        if (!await until(async () => (await settings(page)).autoSend === false)) fail("the pill's toggle did not go back off");
      }
    }
    await press(page, byTid(page, "pill-orb"));
    await inState(page, "idle");
    await ctx.close();
  }

  // ---- Tap to send: the words wait, the ↑ badge and Send send them
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { autoSend: false } });
    await script("move it left");
    await reply("Done. It is on the left now. Anything else?", 300);
    await press(page, byTid(page, "pill-orb"));
    if (!await inState(page, "waiting")) fail(`Tap to send: the orb is ${await orbState(page)}, not waiting`);
    if (!await shown(byTid(page, "pill-badge"))) fail("Tap to send shows no ↑ badge");
    await sleep(1500);
    if (messages(calls).length) fail("Tap to send sent the turn by itself");
    const send = byTid(page, "pill-send");
    if (await send.isDisabled()) fail("Send is off while words wait");
    await press(page, send);
    if (!await until(() => messages(calls).length === 1)) fail("Send sent no message");
    else if (messages(calls)[0].body?.text !== "move it left") fail(`Send sent ${JSON.stringify(messages(calls)[0].body?.text)}`);
    await press(page, byTid(page, "pill-orb")).catch(() => {});
    await ctx.close();
  }

  // ---- collapsed to the orb alone: still shows its ring and its badge; kept over a reload
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { autoSend: false }, ls: { "aiwb.voice.pill": "orb" } });
    if (await pillSize(page) !== "orb") fail(`the pill was kept as ${await pillSize(page)}, not collapsed`);
    if (await byTid(page, "pill-chip").count() || await byTid(page, "pill-new").count()) fail("the collapsed pill still has the chip and + New chat");
    await shot(page, "7-collapsed");
    await script("hello there");
    await reply("Hello. Good to hear you. What shall we draw?", 300);
    await press(page, byTid(page, "pill-orb"));
    if (!await inState(page, "waiting")) fail(`collapsed: the orb is ${await orbState(page)}, not waiting`);
    if (await pillSize(page) !== "orb" || await byTid(page, "pill-words").count()) fail("the collapsed pill grew while words wait");
    if (!await shown(byTid(page, "pill-badge"))) fail("the collapsed orb shows no ↑ badge while words wait");
    if (!await shown(byTid(page, "caption-said"), 8000) || !(await textOf(byTid(page, "caption-said"))).includes("hello there")) fail(`the collapsed orb, where no bar shows the words, has the caption "${await textOf(byTid(page, "caption-said"))}"`);
    await shot(page, "8-collapsed-badge");
    await press(page, byTid(page, "pill-badge"));
    if (!await until(() => messages(calls).length === 1)) fail("the collapsed orb's ↑ badge sent no message");
    await press(page, byTid(page, "pill-orb")).catch(() => {});
    await inState(page, "idle");
    await ctx.close();

    await mockEval("voice.reset(); return 1;", url);
    const b = await start({ settings: { pauseMs: 3000 }, ls: { "aiwb.voice.pill": "orb" } });
    await script("hello there");
    await press(b.page, byTid(b.page, "pill-orb"));
    if (!await inState(b.page, "listening")) fail("collapsed: the orb does not listen");
    if (!await shown(byTid(b.page, "pill-ring"))) fail("the collapsed listening orb has no ring");
    if (!await inState(b.page, "countdown")) fail("collapsed: Auto-send shows no countdown");
    else {
      if (!await shown(byTid(b.page, "pill-countdown-ring")) || await pillSize(b.page) !== "orb") fail("the collapsed orb does not show the ring that fills");
      await shot(b.page, "9-collapsed-countdown", false);
      await press(b.page, byTid(b.page, "pill-collapse"));
      if (!await until(async () => (await pillSize(b.page)) === "listening")) fail("expanding during the countdown does not bring back the listening bar");
      if (!await shown(byTid(b.page, "pill-cancel"))) fail("the listening bar has no Cancel after it was expanded");
      if (await b.page.evaluate(() => localStorage.getItem("aiwb.voice.pill")) !== "full") fail("the pill's size was not kept as expanded");
      await press(b.page, byTid(b.page, "pill-cancel"));
      await press(b.page, byTid(b.page, "pill-collapse"));
      if (!await until(async () => (await pillSize(b.page)) === "orb") || await b.page.evaluate(() => localStorage.getItem("aiwb.voice.pill")) !== "orb") fail("Collapse does not bring the orb alone, kept in the kv");
    }
    await press(b.page, byTid(b.page, "pill-orb")).catch(() => {});
    await b.ctx.close();
  }

  // ---- a microphone that is blocked: the sentence on the orb, the pill idle again
  {
    const { ctx, page } = await start();
    await page.evaluate(() => window.__aiwbVoice.denyMic(true));
    await press(page, byTid(page, "pill-orb"));
    if (!await shown(byTid(page, "voice-problem"))) fail("a blocked microphone shows no popover on the orb");
    else {
      if (await attr(byTid(page, "voice-problem"), "data-kind") !== "mic_blocked") fail("the popover is not the blocked-microphone one");
      await shot(page, "10-micblocked");
      await press(page, byTid(page, "voice-problem-dismiss"));
    }
    if (await orbState(page) !== "idle" || await pillSize(page) !== "compact") fail("the pill is not idle and compact after the problem");
    await ctx.close();
  }

  // ---- the chip lists the sidebar's chats, with Show all for the archived ones
  {
    const { ctx, page } = await start();
    const chip = byTid(page, "pill-chip");
    if ((await textOf(byTid(page, "pill-chip-name"))) !== "On the sketch") fail(`the chip names "${await textOf(byTid(page, "pill-chip-name"))}", not the board's chat`);
    await press(page, chip);
    if (!await shown(byTid(page, "pill-chat"))) fail("the chip opens no list");
    else {
      const ids = () => byTid(page, "pill-chat").evaluateAll((es) => es.map((e) => e.dataset.chat));
      const side = wide ? await byTid(page, "side-board", { board: BOARD }).locator(tidSel("side-row", { kind: "chat" })).evaluateAll((es) => es.map((e) => e.dataset.key)) : [CHAT];
      if ((await ids()).join() !== side.join()) fail(`the chip lists ${(await ids()).join()}, the sidebar ${side.join()}`);
      await shot(page, "11-chip");
      const all = byTid(page, "pill-chip-all");
      if (!await shown(all) || !/^Show all \(1\)$/.test(await textOf(all))) fail(`Show all reads "${await textOf(all)}"`);
      else {
        await press(page, all);
        if (!await until(async () => (await ids()).includes("c_vc6_old"))) fail("Show all does not list the archived chat");
        else {
          if (await attr(byTid(page, "pill-chat", { chat: "c_vc6_old" }), "aria-disabled") !== "true") fail("an archived chat can be picked as the target");
          await shot(page, "12-chip-all");
        }
        await press(page, byTid(page, "pill-chip-all"));
        if (!await until(async () => !(await ids()).includes("c_vc6_old"))) fail("Show fewer does not take the archived chat away");
      }
      await page.keyboard.press("Escape");
      if (!await gone(byTid(page, "pill-chat"))) await press(page, byTid(page, "overlay-backdrop").last());
    }
    await ctx.close();
  }

  // ---- the target chat: none yet → the first turn makes one; + New chat and the sidebar's + make one each; the last used is the target
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ board: EMPTY, settings: { pauseMs: 600 } });
    const boardChats = () => mockEval(`return Object.values(chats).filter((c) => c.board === ${JSON.stringify(EMPTY)} && !c.archived).map((c) => c.id);`, url);
    const chipChat = () => attr(byTid(page, "pill-chip"), "data-chat");
    const made = () => calls.filter((c) => c.method === "POST" && /^\/api\/chats(\?|$)/.test(c.path));
    /** The chats under the board's row of the sidebar. On the phone the sidebar is the screen before: go back to it and return. */
    const sidebar = async () => {
      if (!wide) { await back(page); }
      const rows = await byTid(page, "side-board", { board: EMPTY }).locator(tidSel("side-row", { kind: "chat" })).evaluateAll((es) => es.map((e) => e.dataset.key));
      if (!wide) { await openBoard(page, EMPTY); await shown(byTid(page, "pill-orb")); }
      return rows;
    };
    const same = (a, b) => [...a].sort().join() === [...b].sort().join();
    if (await textOf(byTid(page, "pill-chip-name")) !== "No chat yet" || await chipChat() !== "") fail(`a board with no chat shows the chip "${await textOf(byTid(page, "pill-chip-name"))}"`);
    await shot(page, "13-nochat");
    await script();
    await reply("Done. The box is red now. Anything else?", 300);
    await press(page, byTid(page, "pill-orb"));
    if (!await until(() => messages(calls).length === 1, 30000)) fail("the first spoken turn on an empty board sent no message");
    const first = (await boardChats())[0];
    if ((await boardChats()).length !== 1 || made().length !== 1) fail(`the first turn made ${(await boardChats()).length} chats by ${made().length} calls, not one`);
    else {
      if (!messages(calls)[0].path.includes(first)) fail(`the first turn went to ${messages(calls)[0].path}, not to the chat it made (${first})`);
      if (!await until(async () => (await chipChat()) === first)) fail("the chip does not name the chat the first turn made");
      if (await byTid(page, "chat-head").count()) fail("the chat view opened for the chat the first turn made");
      await press(page, byTid(page, "pill-orb"));
      await inState(page, "idle");
      if (!same(await sidebar(), [first])) fail("the chat the first turn made is not under the board's row in the sidebar");
    }

    // + New chat: a fresh chat, the target at once, shown in the sidebar; no message, no chat view
    const before = await boardChats();
    await press(page, byTid(page, "pill-new"));
    if (!await until(async () => (await boardChats()).length === before.length + 1)) fail("+ New chat made no chat");
    const second = (await boardChats()).find((id) => !before.includes(id));
    if (second && !await until(async () => (await chipChat()) === second)) fail("the chat + New chat made is not the target at once");
    if (messages(calls).length !== 1) fail("+ New chat sent a message");
    if (await byTid(page, "chat-head").count()) fail("+ New chat opened the chat view");
    if (!same(await sidebar(), await boardChats())) fail("the chat + New chat made is not under the board's row in the sidebar");

    // the sidebar's +: the same action, and it opens the chat as it does today
    if (wide) {
      const row = byTid(page, "side-board", { board: EMPTY }).locator(tidSel("side-row", { kind: "board" })).first();
      await hover(page, row);
      const had = await boardChats();
      await press(page, byTid(page, "side-board", { board: EMPTY }).locator(tidSel("side-add")).first());
      if (!await until(async () => (await boardChats()).length === had.length + 1)) fail("the sidebar's + made no chat");
      const third = (await boardChats()).find((id) => !had.includes(id));
      if (third && !await until(async () => (await chipChat()) === third)) fail("the chat the sidebar's + made is not the target");
      if (!await shown(byTid(page, "chat-head"))) fail("the sidebar's + does not open the chat as before");
    } else {
      await press(page, byTid(page, "pill-new"));
    }

    // the chip lists them as the sidebar does, and a pick is the new target
    const ids = await boardChats();
    await press(page, byTid(page, "pill-chip"));
    if (!await shown(byTid(page, "pill-chat"))) fail("the chip opens no list");
    else {
      const listed = await byTid(page, "pill-chat").evaluateAll((es) => es.map((e) => e.dataset.chat));
      if (!same(listed, ids)) fail(`the chip lists ${listed.join()}, the board has ${ids.join()}`);
      await shot(page, "14-chip-chats");
      const now = await chipChat();
      const other = ids.find((id) => id !== now) ?? first;
      await press(page, byTid(page, "pill-chat", { chat: other }));
      if (!await until(async () => (await chipChat()) === other)) fail("a pick in the chip is not the new target");
      if (await page.evaluate((b) => JSON.parse(localStorage.getItem("aiwb.lastChat") ?? "{}")[b], EMPTY) !== other) fail("a pick in the chip is not the board's last chat");
      await script("one more thing");
      await reply("Yes. Tell me. I am listening.", 300);
      await press(page, byTid(page, "pill-orb"));
      if (!await until(() => messages(calls).length === 2, 30000)) fail("the turn after a pick sent no message");
      else if (!messages(calls)[1].path.includes(other)) fail(`the turn went to ${messages(calls)[1].path}, not to the picked chat ${other}`);
      await press(page, byTid(page, "pill-orb")).catch(() => {});
    }
    await ctx.close();
  }

  // ---- the selection chip: "n selected" over the pill, its tag in front of the spoken words, × leaves it out of one turn
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { autoSend: false } });
    if (await byTid(page, "pill-selection").count()) fail("the pill has a selection chip with nothing selected");
    await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
    await act(page, "select");
    const chip = byTid(page, "pill-selection");
    if (!await shown(chip)) fail("three shapes are selected on the board and the pill has no selection chip");
    else {
      if (await attr(chip, "data-count") !== "3" || !/^3 selected/.test(await textOf(chip))) fail(`the selection chip reads "${await textOf(chip)}", not "3 selected"`);
      await shot(page, "18-selection");
      const tag = /^<selection ids="[^"]+" label="[^"]*">[^<]*<\/selection> /;
      const speak = async (words, n) => {
        await mockEval("voice.reset(); return 1;", url);
        await script(words);
        await reply("Done. Anything else?", 300);
        await press(page, byTid(page, "pill-orb"));
        if (!await inState(page, "waiting")) return fail(`selection: the orb is ${await orbState(page)} after "${words}", not waiting`);
        await press(page, byTid(page, "pill-send"));
        if (!await until(() => messages(calls).length === n, 20000)) return fail(`selection: "${words}" sent no message`);
        return messages(calls)[n - 1].body?.text;
      };
      const one = await speak("make them blue", 1);
      if (typeof one === "string" && !(tag.test(one) && one.replace(tag, "") === "make them blue")) fail(`the spoken turn is ${J(one)}, not the selection's tag and the words`);
      if (typeof one === "string" && tag.test(one) && !/\bdraw|rect|3|element|shape/i.test(one.slice(0, 400))) note("the tag's text does not name the shapes");
      await endTurn(page);
      if (!await shown(chip)) fail("the selection chip is gone after a turn that carried it");
      // × leaves the selection out of this turn
      await press(page, byTid(page, "pill-selection-remove"));
      if (!await until(async () => !(await chip.count()))) fail("× does not take the chip away");
      const two = await speak("never mind", 2);
      if (typeof two === "string" && two !== "never mind") fail(`the turn sent after × is ${J(two)}, not the words alone`);
      await endTurn(page);
      if (!await shown(chip)) fail("the selection chip did not come back for the next turn");
    }
    await ctx.close();
  }

  // ---- Thinking: the words stay as a caption while the agent works, its edits show on the board, and the reply's first sentence takes the caption's place
  {
    await mockEval("voice.reset(); voice.pace({ chunkMs: 250, chunks: 8 }); return 1;", url); // (a sentence is heard for about two seconds)
    const { ctx, page, calls } = await start({ settings: { pauseMs: 600 } });
    await script();
    // (one update of the whole reply after 5.5 s: the turn is "thinking" for longer than a caption's 4 s)
    await reply("I drew the red box. It sits on the left. Tell me if you want more.", 5500, 1);
    await press(page, byTid(page, "pill-orb"));
    if (!await inState(page, "listening")) fail("Thinking: the orb did not listen");
    if (!await until(async () => (await pillSize(page)) === "listening")) fail("Thinking: no listening bar");
    if (await byTid(page, "caption-said").count()) fail("the listening bar has a caption of the words it shows itself");
    if (!await inState(page, "thinking", 30000)) fail(`Thinking: the orb is ${await orbState(page)} after the turn, not thinking`);
    else {
      const t0 = Date.now();
      if (await pillSize(page) !== "compact") fail(`Thinking: the pill is ${await pillSize(page)}, not the compact pill`);
      if (!await shown(byTid(page, "caption-said"), 5000) || !(await textOf(byTid(page, "caption-said"))).includes(SAID)) fail(`Thinking: the caption reads "${await textOf(byTid(page, "caption-said"))}", not the words sent`);
      await shot(page, "15-thinking-said", false);
      // the agent edits the board while the orb is thinking
      const made = await mockEval(`return await rpc(${J({ chat: CHAT, board: BOARD, target: BOARD, name: "apply", args: { create: [{ type: "rectangle", key: "vc6", x: 60, y: 380, width: 150, height: 90, strokeColor: "#00c800", backgroundColor: "transparent" }] } })});`, url);
      if (made.error) fail(`the agent's apply answered ${J(made).slice(0, 200)}`);
      else {
        if (!await until(() => byTid(page, "flash").count(), 10000)) fail("Thinking: the agent's edit drew no outline on the board");
        if (await orbState(page) !== "thinking") fail(`Thinking: the orb is ${await orbState(page)} when the edit shows on the board, not thinking`);
        await shot(page, "16-thinking-edit", false);
        if (!await until(() => mockEval(`return scenes.${BOARD}.scene.elements.some((e) => e.strokeColor === "#00c800");`, url), 15000)) fail("Thinking: the agent's shape did not reach the board's stored scene");
      }
      // still there after 4 s: the words are kept until the reply starts
      await sleep(Math.max(0, 4800 - (Date.now() - t0)));
      if (await orbState(page) === "thinking") {
        const c = byTid(page, "caption-said");
        if (!await c.count() || await attr(c, "data-fading") === "true") fail("Thinking: the caption of the words faded before the reply started");
      }
    }
    if (!await inState(page, "speaking", 40000)) fail("Thinking: the reply was never spoken");
    else {
      if (!await until(async () => !(await byTid(page, "caption-said").count()), 4000)) fail("the words of the turn are still a caption when the reply starts");
      if (!await shown(byTid(page, "caption-spoken"), 5000)) fail("Thinking ended with no caption of the sentence spoken");
      else if (!/^I drew the red box\.|^It sits on the left\.|^Tell me if you want more\./.test(await textOf(byTid(page, "caption-spoken")))) fail(`the spoken caption reads "${await textOf(byTid(page, "caption-spoken"))}"`);
      await shot(page, "17-spoken", false);
    }
    // the reply ends, the session listens again; the last sentence stays a while and then fades
    if (await until(async () => (await orbState(page)) === "listening", 40000)) {
      if (!await byTid(page, "caption-spoken").count()) fail("the last sentence went the moment the reply ended: it stays for 4 s");
      if (!await until(async () => !(await byTid(page, "caption-spoken").count()), 10000)) fail("the spoken caption never faded");
    } else fail(`the pill did not listen again after the reply (${await orbState(page)})`);
    if (messages(calls).length !== 1) fail(`the turn sent ${messages(calls).length} messages`);
    await endTurn(page);
    await ctx.close();
  }

  // ---- hold Space (a keyboard: the desktop and the tablet)
  if (viewport !== "phone") {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { pauseMs: 600 } });
    const held = () => attr(byTid(page, "pill"), "data-held");
    // a tap of Space is a tap on the orb: it listens, and a second tap ends it
    await page.keyboard.press("Space", { delay: 80 });
    if (!await inState(page, "listening")) fail(`a tap of Space left the orb ${await orbState(page)}, not listening`);
    await sleep(1500);
    if (await orbState(page) !== "listening" || await held()) fail(`after a tap of Space the orb is ${await orbState(page)} (held: ${await held()}), not listening on by itself`);
    if (messages(calls).length) fail("a tap of Space sent a message");
    await page.keyboard.press("Space", { delay: 80 });
    if (!await inState(page, "idle")) fail(`a second tap of Space left the orb ${await orbState(page)}, not idle`);

    // a hold: listening while it is down; Auto-send's pause does not send; the release does
    await mockEval("voice.reset(); return 1;", url);
    await script();
    await reply("Done. The box is red. Anything else?", 300);
    await page.keyboard.down("Space");
    if (!await inState(page, "listening")) fail(`Space held left the orb ${await orbState(page)}, not listening`);
    if (!await until(async () => (await held()) === "true")) fail("the pill does not say Space is held");
    await page.keyboard.down("Space"); // (the key repeating)
    if (!await until(async () => (await textOf(byTid(page, "pill-words"))).includes(SAID), 15000)) fail(`Space held: the bar shows "${await textOf(byTid(page, "pill-words"))}", not the words said`);
    await shot(page, "19-hold-space", false);
    await sleep(2200); // (the pause is 600 ms: without the hold the turn would have gone)
    if (messages(calls).length) fail("the turn was sent while Space was still held");
    if (!["listening", "waiting"].includes(await orbState(page))) fail(`Space held past the pause: the orb is ${await orbState(page)}, not listening or waiting`);
    await page.keyboard.up("Space");
    if (!await until(() => messages(calls).length === 1, 15000)) fail("the release of Space sent no message");
    else {
      if (messages(calls)[0].body?.text !== SAID) fail(`the release sent ${J(messages(calls)[0].body?.text)}, not ${J(SAID)}`);
      if (!messages(calls)[0].path.includes(CHAT)) fail(`the turn went to ${messages(calls)[0].path}, not to chat ${CHAT}`);
    }
    if (await held()) fail("the pill still says Space is held after the release");
    await endTurn(page);

    // a hold in which nothing was said: the release shuts the microphone and sends nothing
    await mockEval("voice.reset(); return 1;", url);
    await page.keyboard.down("Space");
    await inState(page, "listening");
    await sleep(500);
    await page.keyboard.up("Space");
    if (!await inState(page, "idle", 10000)) fail(`a hold with no words left the orb ${await orbState(page)} after the release, not idle`);
    if (messages(calls).length !== 1) fail("a hold with no words sent a message");
    const closed = await until(async () => (await log()).some((e) => e.kind === "stt" && e.closeCode != null), 8000);
    if (!closed) fail("a hold with no words left the voice service's socket open");

    // Space goes to a text box that has the focus
    await page.evaluate(() => { const i = document.createElement("input"); i.id = "vc6-box"; document.body.appendChild(i); i.focus(); });
    await page.keyboard.press("Space", { delay: 80 });
    await sleep(500);
    if (await orbState(page) !== "idle") fail(`Space typed in a text box started the pill (${await orbState(page)})`);
    if (await page.evaluate(() => document.getElementById("vc6-box").value) !== " ") fail("the text box did not get its Space");
    await page.evaluate(() => document.getElementById("vc6-box").remove());

    // Space with the focus in the board's canvas is the canvas's (it pans): the pill does not listen
    await page.evaluate(() => { const c = document.querySelector(".excalidraw"); c.setAttribute("tabindex", c.getAttribute("tabindex") ?? "-1"); c.focus(); });
    const sttBefore = (await log()).filter((e) => e.kind === "stt").length;
    await page.keyboard.down("Space");
    await sleep(600);
    await page.keyboard.up("Space");
    await sleep(300);
    if (await orbState(page) !== "idle") fail(`Space held in the board's canvas started the pill (${await orbState(page)})`);
    if ((await log()).filter((e) => e.kind === "stt").length !== sttBefore) fail("Space held in the board's canvas opened a listening socket");
    await page.evaluate(() => document.activeElement?.blur());
    await ctx.close();
  }
}, { viewports, page: false });
