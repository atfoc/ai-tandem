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
//   (voice devices D9 added what this check does not drive, VC.8 does: the orb's `paused` state, `pill-continue` in the listening bar, and the board's
//   `caption-notice`)
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
// The phone (package V1; goal 4.9, 6.4) has no pill: the board's bottom row holds the docked orb (`voice-orb` in `board-orb-slot`, the same states and taps),
// and while a session runs one voice card (`voice-card`, data-phase listening | waiting | countdown | thinking | speaking | paused) with "To:" and the chat's
// chip (`voice-card-to`, which opens the board's Chats sheet), the live wave, the words heard, the selection chip, Cancel and Send, and Open chat / Interrupt
// for the reply. It has no Auto-send switch (Settings has it), no ↑ badge, no captions, no collapse, no "+ New chat" (the Chats sheet's `chats-new` makes one
// and opens it), no list of chats in a chip (the Chats sheet) and no hold Space. Each part of the pill's proof that the phone draws differently is proved
// below on the card and the sheet; a part the phone has not is left to the wide halves, which are as they were.
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
  const ORB = wide ? "pill-orb" : "voice-orb";
  const orbState = (p) => attr(byTid(p, ORB), "data-state");
  const cardPhase = (p) => attr(byTid(p, "voice-card"), "data-phase");
  const pillSize = (p) => attr(byTid(p, "pill"), "data-size");
  const inState = (p, s, ms = 15000) => until(async () => (await orbState(p)) === s, ms);
  const settings = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const sessionOf = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const log = () => mockEval("return voice.log();", url);
  const script = (words = SAID) => mockEval(`voice.script([{ after: 3, partial: ${JSON.stringify(words.split(" ").slice(0, 2).join(" "))} }, { after: 6, committed: ${JSON.stringify(words)} }]); return 1;`, url);
  const reply = (text = "Sure. I drew it. Anything else?", pace = 300, parts = 6) => mockEval(`flags.reply = { text: ${JSON.stringify(text)}, parts: ${parts}, pace: ${pace} }; return 1;`, url);
  const J = JSON.stringify;
  /** Presses the orb until the session is over (a speaking orb is interrupted by the first press, a listening one ended by the next). */
  const endTurn = async (p) => { for (let i = 0; i < 4 && await orbState(p) !== "idle"; i++) { await press(p, byTid(p, ORB)); await sleep(300); } return inState(p, "idle", 8000); };
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
    if (!await shown(byTid(page, ORB))) throw new Error(wide ? "the board shows no pill" : "the board shows no orb");
    return { ctx, page, calls };
  };

  /** The phone's Chats sheet closed by its backdrop (pressed again until it is gone: a sheet that has just risen takes the first press for a drag). */
  const closeSheet = (p) => until(async () => {
    if (!await byTid(p, "chats-sheet").count()) return true;
    await press(p, byTid(p, "overlay-backdrop").last(), { position: { x: 4, y: 4 } }).catch(() => {});
    await sleep(300);
    return !await byTid(p, "chats-sheet").count();
  }, 8000);

  await seed(url, "A2");
  await mockEval(`boards.${EMPTY} = { id: ${JSON.stringify(EMPTY)}, name: "Empty", group: boards.${BOARD}.group, created: new Date().toISOString() }; scenes.${EMPTY} = JSON.parse(JSON.stringify(scenes.${BOARD})); return 1;`, url);

  await mockEval(`boards.b_vc6_arch = { id: "b_vc6_arch", name: "Old board", group: boards.${BOARD}.group, created: new Date().toISOString(), archived: true, archiveOp: "op_vc6b" }; scenes.b_vc6_arch = JSON.parse(JSON.stringify(scenes.${BOARD})); return 1;`, url);
  await mockEval(`const a = JSON.parse(JSON.stringify(chats.${CHAT})); a.id = "c_vc6_old"; a.name = "Old sketch chat"; a.archived = true; a.archiveOp = "op_vc6"; chats.c_vc6_old = a; return 1;`, url);
  /** Records the orb's states from now on (every 20 ms, each change once), in window.__orbStates. */
  const record = (p) => p.evaluate((orb) => {
    window.__orbStates = [];
    clearInterval(window.__orbTimer);
    window.__orbTimer = setInterval(() => { const s = document.querySelector(`[data-testid="${orb}"]`)?.getAttribute("data-state") ?? "none"; const l = window.__orbStates; if (l[l.length - 1] !== s) l.push(s); }, 20);
  }, ORB);
  const recorded = (p) => p.evaluate(() => window.__orbStates);

  // ---- the shell
  {
    const { ctx, page } = await start({ key: false });
    if (!wide) {
      // the phone: at rest nothing but the docked orb (52 pt, in the bottom row's slot, inside the window); no pill, no card
      const dock = byTid(page, "board-orb-slot").locator(tidSel("voice-orb")), disc = await dock.first().boundingBox().catch(() => null), win = page.viewportSize();
      if (!await dock.count()) fail("the board's orb slot holds no voice-orb");
      if (await byTid(page, "pill").count()) fail("the phone draws the pill");
      if (await byTid(page, "voice-card").count()) fail("the phone draws the voice card at rest");
      if (await orbState(page) !== "idle") fail(`the orb starts ${await orbState(page)}, not idle`);
      if (!disc || disc.width < 44 || disc.height < 44) fail(`the orb is ${disc && Math.round(disc.width)}x${disc && Math.round(disc.height)} pt, under 44`);
      else if (disc.x < 0 || disc.x + disc.width > win.width + 1 || disc.y + disc.height > win.height + 1) fail(`the orb is not inside the window: ${JSON.stringify(disc)} in ${win.width}x${win.height}`);
      if (await byTid(page, "voice-orb-badge").count()) fail("the idle orb has a badge");
      await shot(page, "1-idle");
      await ctx.close();
    } else {
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
  }

  // ---- no key: the orb shows the problem popover and nothing else happens
  {
    const { ctx, page } = await start({ key: false });
    await press(page, byTid(page, ORB));
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
    if (!wide && await byTid(page, "voice-card").count()) fail("the no-key problem opened the voice card");
    if ((await log()).some((e) => e.kind === "stt")) fail("a socket to the voice service was opened with no key");
    await ctx.close();
  }

  // ---- a turn with Auto-send: listening, countdown, Cancel, the ↑ badge, thinking, speaking, interrupt
  if (wide) {
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

  // ---- the phone's turn with Auto-send: listening, countdown, Cancel (the words wait), Send, thinking, speaking, Interrupt, on the card
  if (!wide) {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { pauseMs: 3000 } });
    await script();
    await reply("I drew the red box for you. It sits on the left of the board. Tell me if you want more.", 300);
    await record(page);
    await press(page, byTid(page, ORB));
    if (!await inState(page, "listening")) fail(`the orb is ${await orbState(page)} after a tap, not listening`);
    if (!await shown(byTid(page, "voice-card"))) fail("the voice card did not come up when the orb was tapped");
    if (!await until(async () => (await cardPhase(page)) === "listening", 5000)) fail(`the card is ${await cardPhase(page)} while listening`);
    if (!await shown(byTid(page, "voice-card-wave"))) fail("the card has no waveform while listening");
    if (!await shown(byTid(page, "voice-orb-ring"))) fail("the listening orb has no ring");
    const to = byTid(page, "voice-card-to");
    if (await attr(to, "data-chat") !== CHAT || !(await textOf(to)).includes("On the sketch")) fail(`the card says To: "${await textOf(to)}" (chat ${await attr(to, "data-chat")}), not the board's chat ${CHAT}`);
    for (const id of ["voice-card-cancel", "voice-card-send"]) if (!await byTid(page, id).count()) fail(`the listening card has no ${id}`);
    for (const id of ["pill", "pill-chip", "pill-new", "pill-autosend", "pill-collapse"]) if (await byTid(page, id).count()) fail(`the phone draws ${id}, a part of the wide pill`);
    if (await byTid(page, "chat-head").count()) fail("the chat view opened for a spoken turn");
    await shot(page, "3-listening", false);
    if (!await until(async () => (await textOf(byTid(page, "voice-card-words"))).includes(SAID))) fail(`the card shows "${await textOf(byTid(page, "voice-card-words"))}", not the words said`);
    if (!await inState(page, "countdown")) fail("Auto-send showed no countdown");
    else {
      if (!await until(async () => (await cardPhase(page)) === "countdown", 3000)) fail(`the card is ${await cardPhase(page)} in the countdown`);
      const frac = () => attr(byTid(page, "voice-card-countdown"), "data-frac").then(Number);
      const a = await frac(); await sleep(500); const b = await frac();
      if (!(b > a)) fail(`the line does not fill: ${a} then ${b}`);
      if (!/^Sending in \d s$/.test(await textOf(byTid(page, "voice-card-state")))) fail(`the countdown reads "${await textOf(byTid(page, "voice-card-state"))}"`);
      await shot(page, "4-countdown", false);
      await press(page, byTid(page, "voice-card-cancel"));
      if (!await inState(page, "waiting")) fail(`Cancel leaves the orb ${await orbState(page)}, not waiting`);
      if (await byTid(page, "voice-card-countdown").count()) fail("the countdown stays after Cancel");
      if (!(await textOf(byTid(page, "voice-card-words"))).includes(SAID)) fail("Cancel does not keep the words");
      if (await byTid(page, "voice-card-send").first().isDisabled()) fail("Send is off while words wait");
      await sleep(1500);
      if (messages(calls).length) fail("a turn was sent after Cancel");
      if (await orbState(page) !== "waiting" || await cardPhase(page) !== "waiting") fail("the card left waiting by itself after Cancel");
      await shot(page, "5-waiting");
      await press(page, byTid(page, "voice-card-send"));
      if (!await until(() => messages(calls).length === 1)) fail("Send sent no message");
      else {
        const m = messages(calls)[0];
        if (!m.path.includes(CHAT)) fail(`the turn went to ${m.path}, not to chat ${CHAT}`);
        if (m.body?.text !== SAID) fail(`the message says ${J(m.body?.text)}, not ${J(SAID)}`);
      }
    }
    if (!await until(async () => (await recorded(page)).includes("speaking"), 30000)) fail(`the orb was ${J(await recorded(page))}: it never spoke`);
    else {
      const seen = (await recorded(page)).join(",");
      if (!/thinking.*speaking/.test(seen)) fail(`the orb went ${seen}: thinking did not come before speaking`);
      if (!await until(async () => (await cardPhase(page)) === "speaking", 5000)) fail(`the card is ${await cardPhase(page)} while the reply is spoken`);
      if (!await shown(byTid(page, "voice-card-words"), 8000)) fail("the sentence being spoken is not on the card");
      else {
        const said = await textOf(byTid(page, "voice-card-words"));
        if (!"I drew the red box for you. It sits on the left of the board. Tell me if you want more.".includes(said) || said.length < 8) fail(`the card's spoken line reads "${said}", not a sentence of the reply`);
      }
      for (const id of ["voice-card-open", "voice-card-interrupt"]) if (!await byTid(page, id).count()) fail(`the speaking card has no ${id}`);
      await shot(page, "6-speaking", false);
      await press(page, byTid(page, "voice-card-interrupt"));
      if (!await until(async () => (await orbState(page)) !== "speaking")) fail("Interrupt does not cut the reply");
      else {
        const tts = async () => (await log()).filter((e) => e.kind === "tts").length;
        const w0 = await page.evaluate(() => window.__aiwbVoice.player().writes), n0 = await tts();
        await sleep(1200);
        if ((await page.evaluate(() => window.__aiwbVoice.player().writes)) !== w0) fail("sound was still written to the player after Interrupt");
        if (await tts() !== n0) fail("a sentence was asked for after Interrupt");
        if (await orbState(page) !== "listening") fail(`after Interrupt the orb is ${await orbState(page)}, not listening again`);
      }
    }
    if (await byTid(page, "chat-head").count()) fail("the chat view opened for a spoken turn");
    await press(page, byTid(page, ORB));
    if (!await inState(page, "idle") || !await gone(byTid(page, "voice-card"))) fail("a tap on the listening orb does not end the session and take the card away");
    await ctx.close();
  }

  // ---- the pill is the canvas's: a chat alone and an archived board have none
  {
    const plain = await open({ sel: { chat: "c_plain" }, wait: tidSel("chat-head") });
    await sleep(500);
    if (await byTid(plain.page, "pill").count() || await byTid(plain.page, "voice-orb").count() || await byTid(plain.page, "voice-card").count()) fail("a chat with no board shows the pill, the orb or the card");
    await plain.ctx.close();
    const old = await open({ sel: { board: "b_vc6_arch", chat: null }, wait: tidSel("board-canvas", { board: "b_vc6_arch" }) });
    await sleep(500);
    if (await byTid(old.page, "pill").count() || await byTid(old.page, "voice-orb").count() || await byTid(old.page, "voice-card").count()) fail("an archived board shows the pill, the orb or the card");
    await old.ctx.close();
  }

  // ---- Auto-send is one setting: the pill's toggle, the speech bar's and Settings' (the speech bar's is P13b's: the seam and Settings stand for it)
  if (!wide) {
    // the phone's card has no switch (Settings › Voice has it; UX.S3 proves it): it is on by default and the card only shows what it does
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page } = await start();
    await press(page, byTid(page, ORB));
    if (!await until(async () => (await cardPhase(page)) === "listening")) fail("the card did not come up");
    if (await byTid(page, "pill-autosend").count() || await byTid(page, "voice-card").locator('[role="switch"]').count()) fail("the phone's card has an Auto-send switch");
    if ((await settings(page)).autoSend !== true) fail("Auto-send is not on by default");
    await press(page, byTid(page, ORB));
    await inState(page, "idle");
    await ctx.close();
  } else {
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
    await press(page, byTid(page, ORB));
    if (!await inState(page, "waiting")) fail(`Tap to send: the orb is ${await orbState(page)}, not waiting`);
    if (wide && !await shown(byTid(page, "pill-badge"))) fail("Tap to send shows no ↑ badge");
    if (!wide && (await cardPhase(page) !== "waiting" || !(await textOf(byTid(page, "voice-card-words"))).includes("move it left"))) fail(`Tap to send: the card is ${await cardPhase(page)} and says "${await textOf(byTid(page, "voice-card-words"))}", not waiting with the words`);
    await sleep(1500);
    if (messages(calls).length) fail("Tap to send sent the turn by itself");
    const send = byTid(page, wide ? "pill-send" : "voice-card-send");
    if (await send.isDisabled()) fail("Send is off while words wait");
    await press(page, send);
    if (!await until(() => messages(calls).length === 1)) fail("Send sent no message");
    else if (messages(calls)[0].body?.text !== "move it left") fail(`Send sent ${JSON.stringify(messages(calls)[0].body?.text)}`);
    await press(page, byTid(page, ORB)).catch(() => {});
    await ctx.close();
  }

  // ---- collapsed to the orb alone: still shows its ring and its badge; kept over a reload (the phone's orb is docked and has no collapse)
  if (wide) {
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
    await press(page, byTid(page, ORB));
    if (!await shown(byTid(page, "voice-problem"))) fail("a blocked microphone shows no popover on the orb");
    else {
      if (await attr(byTid(page, "voice-problem"), "data-kind") !== "mic_blocked") fail("the popover is not the blocked-microphone one");
      await shot(page, "10-micblocked");
      await press(page, byTid(page, "voice-problem-dismiss"));
    }
    if (await orbState(page) !== "idle" || (wide ? await pillSize(page) !== "compact" : await byTid(page, "voice-card").count())) fail("the pill is not idle and compact (the phone: the card gone) after the problem");
    await ctx.close();
  }

  // ---- the phone: "To:" opens the board's Chats sheet, which lists the board's chats (the sidebar's) and marks the one voice talks to
  if (!wide) {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page } = await start();
    if (await byTid(page, "voice-card-to").count()) fail("the chat's chip is drawn at rest");
    await press(page, byTid(page, ORB));
    const to = byTid(page, "voice-card-to");
    if (!await shown(to)) fail("the card has no To: chip");
    else {
      if ((await textOf(to)) !== "On the sketch") fail(`the chip names "${await textOf(to)}", not the board's chat`);
      await press(page, to);
      if (!await shown(byTid(page, "chats-sheet"))) fail("To: opens no Chats sheet");
      else {
        await sleep(500); // (the sheet rises)
        const rows = byTid(page, "chats-row");
        const ids = await rows.evaluateAll((es) => es.map((e) => e.dataset.chat));
        const want = await mockEval(`return Object.values(chats).filter((c) => c.board === ${J(BOARD)} && !c.archived).map((c) => c.id);`, url);
        if (ids.slice().sort().join() !== want.slice().sort().join()) fail(`the sheet lists ${ids.join()}, the board has ${want.join()}`);
        if (ids.includes("c_vc6_old")) fail("the sheet lists an archived chat");
        if (await attr(byTid(page, "chats-row", { chat: CHAT }), "data-voice") !== "1") fail("the sheet does not mark the chat voice talks to");
        if (!await byTid(page, "chats-new").count()) fail("the sheet has no New chat on this board");
        await shot(page, "11-sheet");
        await closeSheet(page);
      }
    }
    await press(page, byTid(page, ORB));
    await inState(page, "idle");
    await ctx.close();
  }

  // ---- the chip lists the sidebar's chats, with Show all for the archived ones
  if (wide) {
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
    /** The chat the next turn goes to: the chip's. The phone's chip is on the card, which only a session draws: one is started and ended for the look. */
    const chipChat = async () => {
      if (wide) return attr(byTid(page, "pill-chip"), "data-chat");
      await press(page, byTid(page, ORB));
      const to = byTid(page, "voice-card-to");
      const chat = (await shown(to)) ? await attr(to, "data-chat") : null;
      await shot(page, "13-to");
      await press(page, byTid(page, "voice-card-cancel")).catch(() => {});
      await inState(page, "idle", 8000);
      return chat;
    };
    /** The phone's Chats sheet: opened by the bar's button, the chats it lists read, closed. */
    const sheetChats = async () => {
      await press(page, byTid(page, "board-chats"));
      await byTid(page, "chats-sheet").waitFor({ state: "visible", timeout: 15000 });
      await sleep(500);
      const ids = await byTid(page, "chats-row").evaluateAll((es) => es.map((e) => e.dataset.chat));
      await closeSheet(page);
      return ids;
    };
    /** The phone's "New chat on this board" (the sheet's first row): makes a chat and opens it over the board; back to the board. */
    const newOnPhone = async () => {
      await press(page, byTid(page, "board-chats"));
      await byTid(page, "chats-new").waitFor({ state: "visible", timeout: 15000 });
      await sleep(500);
      await press(page, byTid(page, "chats-new"));
      const opened = await shown(byTid(page, "chat-head"));
      if (!opened) fail("the sheet's New chat on this board did not open the chat");
      await back(page);
      await shown(byTid(page, ORB));
    };
    const made = () => calls.filter((c) => c.method === "POST" && /^\/api\/chats(\?|$)/.test(c.path));
    /** The chats under the board's row of the sidebar. On the phone the sidebar is the screen before: go back to it and return. */
    const sidebar = async () => {
      if (!wide) { await back(page); }
      const rows = await byTid(page, "side-board", { board: EMPTY }).locator(tidSel("side-row", { kind: "chat" })).evaluateAll((es) => es.map((e) => e.dataset.key));
      if (!wide) { await openBoard(page, EMPTY); await shown(byTid(page, "pill-orb")); }
      return rows;
    };
    const same = (a, b) => [...a].sort().join() === [...b].sort().join();
    if (wide ? await textOf(byTid(page, "pill-chip-name")) !== "No chat yet" || await chipChat() !== "" : await chipChat() !== "") fail(`a board with no chat shows the chip "${wide ? await textOf(byTid(page, "pill-chip-name")) : ""}" (chat ${J(await chipChat())})`);
    await shot(page, "13-nochat");
    await script();
    await reply("Done. The box is red now. Anything else?", 300);
    await press(page, byTid(page, ORB));
    if (!await until(() => messages(calls).length === 1, 30000)) fail("the first spoken turn on an empty board sent no message");
    const first = (await boardChats())[0];
    if ((await boardChats()).length !== 1 || made().length !== 1) fail(`the first turn made ${(await boardChats()).length} chats by ${made().length} calls, not one`);
    else {
      if (!messages(calls)[0].path.includes(first)) fail(`the first turn went to ${messages(calls)[0].path}, not to the chat it made (${first})`);
      if (wide && !await until(async () => (await chipChat()) === first)) fail("the chip does not name the chat the first turn made");
      if (await byTid(page, "chat-head").count()) fail("the chat view opened for the chat the first turn made");
      await endTurn(page);
      if (wide ? !same(await sidebar(), [first]) : !same(await sheetChats(), [first])) fail(`the chat the first turn made is not under the board's row in the sidebar${wide ? "" : " nor in the board's Chats sheet"}`);
      if (!wide && await chipChat() !== first) fail(`the card's To: does not name the chat the first turn made (${J(await chipChat())})`);
    }

    // + New chat: a fresh chat, the target at once, shown in the sidebar; no message, no chat view
    // (the phone has no + New chat in the pill: the Chats sheet's New chat on this board makes the chat and opens it, and the card's To: is that chat)
    const before = await boardChats();
    if (wide) await press(page, byTid(page, "pill-new")); else await newOnPhone();
    if (!await until(async () => (await boardChats()).length === before.length + 1)) fail("+ New chat made no chat");
    const second = (await boardChats()).find((id) => !before.includes(id));
    if (second && !await until(async () => (await chipChat()) === second)) fail("the chat + New chat made is not the target at once");
    if (messages(calls).length !== 1) fail("+ New chat sent a message");
    if (wide && await byTid(page, "chat-head").count()) fail("+ New chat opened the chat view");
    if (wide ? !same(await sidebar(), await boardChats()) : !same(await sheetChats(), await boardChats())) fail("the chat + New chat made is not under the board's row in the sidebar (the phone: in the Chats sheet)");

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
      await newOnPhone();
    }

    // the chip lists them as the sidebar does, and a pick is the new target
    const ids = await boardChats();
    if (wide) await press(page, byTid(page, "pill-chip"));
    else { await press(page, byTid(page, ORB)); await press(page, byTid(page, "voice-card-to")); } // (To: opens the Chats sheet from the card)
    if (!await shown(byTid(page, wide ? "pill-chat" : "chats-row"))) fail(wide ? "the chip opens no list" : "To: opens no list of chats");
    else {
      if (!wide) await sleep(500);
      const listed = await byTid(page, wide ? "pill-chat" : "chats-row").evaluateAll((es) => es.map((e) => e.dataset.chat));
      if (!same(listed, ids)) fail(`the chip lists ${listed.join()}, the board has ${ids.join()}`);
      await shot(page, "14-chip-chats");
      const now = wide ? await chipChat() : await attr(byTid(page, "chats-row", { voice: "1" }), "data-chat");
      const other = ids.find((id) => id !== now) ?? first;
      await press(page, byTid(page, wide ? "pill-chat" : "chats-row", { chat: other }));
      if (!wide) { // (a row of the sheet opens that chat over the board: back to the board, where the card's To: is the chat picked)
        if (!await shown(byTid(page, "chat-head"))) fail("a row of the sheet opened no chat");
        await back(page);
        await shown(byTid(page, ORB));
        await endTurn(page); // (a session the card started is over or still on: idle either way)
      }
      if (!await until(async () => (await chipChat()) === other)) fail("a pick in the chip is not the new target");
      if (await page.evaluate((b) => JSON.parse(localStorage.getItem("aiwb.lastChat") ?? "{}")[b], EMPTY) !== other) fail("a pick in the chip is not the board's last chat");
      await script("one more thing");
      await reply("Yes. Tell me. I am listening.", 300);
      await press(page, byTid(page, ORB));
      if (!await until(() => messages(calls).length === 2, 30000)) fail("the turn after a pick sent no message");
      else if (!messages(calls)[1].path.includes(other)) fail(`the turn went to ${messages(calls)[1].path}, not to the picked chat ${other}`);
      await press(page, byTid(page, ORB)).catch(() => {});
    }
    await ctx.close();
  }

  // ---- the selection chip: "n selected" over the pill, its tag in front of the spoken words, × leaves it out of one turn
  {
    await mockEval("voice.reset(); return 1;", url);
    const { ctx, page, calls } = await start({ settings: { autoSend: false } });
    // (the phone: the selection chip is the card's, drawn only in a session, with a count on the orb's badge; at rest neither is drawn)
    const chip = byTid(page, wide ? "pill-selection" : "voice-card-selection");
    if (await chip.count() || await byTid(page, "voice-orb-badge").count()) fail("the pill has a selection chip with nothing selected");
    await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
    await act(page, "select");
    if (!wide && (await byTid(page, "voice-orb-badge").count() || await byTid(page, "voice-card").count())) fail("the phone's orb or card shows the selection with no session");
    if (!wide) await press(page, byTid(page, ORB)); // (a session, for the card's chip)
    if (!await shown(chip)) fail("three shapes are selected on the board and the pill has no selection chip");
    else {
      if (await attr(chip, "data-count") !== "3" || !/^(With )?3 selected/.test(await textOf(chip))) fail(`the selection chip reads "${await textOf(chip)}", not "3 selected"`);
      if (!wide && await attr(byTid(page, "voice-orb-badge"), "data-count") !== "3") fail(`the orb's badge counts ${await attr(byTid(page, "voice-orb-badge"), "data-count")}, not 3`);
      await shot(page, "18-selection");
      if (!wide) { await press(page, byTid(page, "voice-card-cancel")); await inState(page, "idle", 8000); }
      const tag = /^<selection ids="[^"]+" label="[^"]*">[^<]*<\/selection> /;
      const speak = async (words, n, { leave = false } = {}) => {
        await mockEval("voice.reset(); return 1;", url);
        await script(words);
        await reply("Done. Anything else?", 300);
        await press(page, byTid(page, ORB));
        if (!await inState(page, "waiting")) return fail(`selection: the orb is ${await orbState(page)} after "${words}", not waiting`);
        if (!wide && !leave && !await shown(chip)) return fail(`selection: the card has no selection chip in the turn "${words}"`);
        if (!wide && leave) { // (× on the card, in the session: this turn goes without the selection)
          await press(page, byTid(page, "voice-card-selection-x"));
          if (!await until(async () => !(await chip.count()))) return fail("× does not take the chip away");
        }
        await press(page, byTid(page, wide ? "pill-send" : "voice-card-send"));
        if (!await until(() => messages(calls).length === n, 20000)) return fail(`selection: "${words}" sent no message`);
        return messages(calls)[n - 1].body?.text;
      };
      const one = await speak("make them blue", 1);
      if (typeof one === "string" && !(tag.test(one) && one.replace(tag, "") === "make them blue")) fail(`the spoken turn is ${J(one)}, not the selection's tag and the words`);
      if (typeof one === "string" && tag.test(one) && !/\bdraw|rect|3|element|shape/i.test(one.slice(0, 400))) note("the tag's text does not name the shapes");
      await endTurn(page);
      if (wide && !await shown(chip)) fail("the selection chip is gone after a turn that carried it");
      // × leaves the selection out of this turn
      if (wide) {
        await press(page, byTid(page, "pill-selection-remove"));
        if (!await until(async () => !(await chip.count()))) fail("× does not take the chip away");
      }
      const two = await speak("never mind", 2, { leave: true });
      if (typeof two === "string" && two !== "never mind") fail(`the turn sent after × is ${J(two)}, not the words alone`);
      await endTurn(page);
      if (wide ? !await shown(chip) : false) fail("the selection chip did not come back for the next turn");
      if (!wide) { // (the next session's card has it again)
        await press(page, byTid(page, ORB));
        if (!await shown(chip)) fail("the selection chip did not come back for the next turn");
        await press(page, byTid(page, "voice-card-cancel")).catch(() => {});
        await inState(page, "idle", 8000);
      }
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
    await press(page, byTid(page, ORB));
    if (!await inState(page, "listening")) fail("Thinking: the orb did not listen");
    if (!await until(async () => wide ? (await pillSize(page)) === "listening" : (await cardPhase(page)) === "listening")) fail("Thinking: no listening bar (the phone: no listening card)");
    if (await byTid(page, "caption-said").count()) fail("the listening bar has a caption of the words it shows itself");
    if (!await inState(page, "thinking", 30000)) fail(`Thinking: the orb is ${await orbState(page)} after the turn, not thinking`);
    else {
      const t0 = Date.now();
      if (wide && await pillSize(page) !== "compact") fail(`Thinking: the pill is ${await pillSize(page)}, not the compact pill`);
      if (wide && (!await shown(byTid(page, "caption-said"), 5000) || !(await textOf(byTid(page, "caption-said"))).includes(SAID))) fail(`Thinking: the caption reads "${await textOf(byTid(page, "caption-said"))}", not the words sent`);
      // (the phone has no caption: the card says the agent is thinking, and in which chat, and offers Open chat)
      if (!wide) {
        if (!await until(async () => (await cardPhase(page)) === "thinking", 5000)) fail(`Thinking: the card is ${await cardPhase(page)}, not thinking`);
        else {
          if (!/thinking…$/.test(await textOf(byTid(page, "voice-card-state")))) fail(`Thinking: the card says "${await textOf(byTid(page, "voice-card-state"))}"`);
          if (!(await textOf(byTid(page, "voice-card-in"))).includes("On the sketch")) fail(`Thinking: the card names the chat "${await textOf(byTid(page, "voice-card-in"))}"`);
          if (!await byTid(page, "voice-card-open").count()) fail("Thinking: the card has no Open chat");
        }
      }
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
      // still there after 4 s: the words are kept until the reply starts (the phone: the thinking card stays)
      await sleep(Math.max(0, 4800 - (Date.now() - t0)));
      if (!wide && await orbState(page) === "thinking" && await cardPhase(page) !== "thinking") fail(`Thinking: the card went to ${await cardPhase(page)} before the reply started`);
      if (wide && await orbState(page) === "thinking") {
        const c = byTid(page, "caption-said");
        if (!await c.count() || await attr(c, "data-fading") === "true") fail("Thinking: the caption of the words faded before the reply started");
      }
    }
    if (!await inState(page, "speaking", 40000)) fail("Thinking: the reply was never spoken");
    else if (!wide) {
      if (!await until(async () => (await cardPhase(page)) === "speaking", 5000)) fail(`Thinking ended with the card ${await cardPhase(page)}, not speaking`);
      else if (!await shown(byTid(page, "voice-card-words"), 5000) || !/^I drew the red box\.|^It sits on the left\.|^Tell me if you want more\./.test(await textOf(byTid(page, "voice-card-words")))) fail(`the card's spoken line reads "${await textOf(byTid(page, "voice-card-words"))}"`);
      await shot(page, "17-spoken", false);
    } else {
      if (!await until(async () => !(await byTid(page, "caption-said").count()), 4000)) fail("the words of the turn are still a caption when the reply starts");
      if (!await shown(byTid(page, "caption-spoken"), 5000)) fail("Thinking ended with no caption of the sentence spoken");
      else if (!/^I drew the red box\.|^It sits on the left\.|^Tell me if you want more\./.test(await textOf(byTid(page, "caption-spoken")))) fail(`the spoken caption reads "${await textOf(byTid(page, "caption-spoken"))}"`);
      await shot(page, "17-spoken", false);
    }
    // the reply ends, the session listens again; the last sentence stays a while and then fades
    if (await until(async () => (await orbState(page)) === "listening", 40000)) {
      if (wide && !await byTid(page, "caption-spoken").count()) fail("the last sentence went the moment the reply ended: it stays for 4 s");
      if (wide && !await until(async () => !(await byTid(page, "caption-spoken").count()), 10000)) fail("the spoken caption never faded");
      if (!wide && await cardPhase(page) !== "listening") fail(`the card is ${await cardPhase(page)} when the session listens again`);
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
  if (!wide) note("phone: the docked orb alone at rest (none on a chat alone or an archived board); no key: the problem popover; a turn on the card (listening, countdown, Cancel keeps the words, Send, thinking, speaking, Interrupt); Tap to send; the mic blocked; To: opens the Chats sheet that lists the board's chats and marks the voice one; the first turn on an empty board makes a chat (in the sheet), New chat on this board is the next target, a pick in the sheet is the next target; the selection chip and the orb's badge only in a session, × leaves it out of one turn; Thinking with the agent's edit on the board");
}, { viewports, page: false });
