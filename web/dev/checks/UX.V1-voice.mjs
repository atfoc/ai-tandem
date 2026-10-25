// UX.V1-voice (package V1, ux-improvements goal 3.7.1, 3.7.2, 3.4, 4.5, 4.9; plans/ux-improvements/v1-design.md): the blocked composer, voice in the composer
// and the voice card of a board, on the phone, on the mock's section UXV1 (dev/mock-ui.js) with the stand-in voice service (dev/voicestandin.mjs) and
// the checks' microphone (mic.mjs). Phone only (the wide layouts keep their bars, popovers and pill: VC.2 to VC.7 hold those halves). The light theme, then
// the dark one.
//   1 blocked     each state of the composer (offline, gone, archived, archived + offline, legacy with and without a board, no agent, a model too small, a
//                 refused send) is said ONCE on the screen (its sentence counted in the page's text), stands in the place the design gives it (`composer-block`
//                 dataSet `kind`, `place`), the box is read-only (`composer-box` data-readonly) with the draft in it where the design keeps it, there is no
//                 placeholder and no `composer-err` under the box; Servers (`block-servers`) pushes the server's detail; Unarchive gives the box back;
//                 "New chat on this board" opens a new chat on the board; Pick a model opens the model sheet; the refused card's × removes it and leaves the
//                 text in the box; every control ≥ 44 pt and no text under 13 pt (the first line 17 pt)
//   2 dictate     (stand-in voice, key put in as VC.3 does) `dictate-line` with "Listening…" and "Tap the mic to end", the finished words in the box, the guess in
//                 `dictate-guess` and not in the box, `send` the primary while dictating, the mic's label "End dictation"
//   3 speech      speech mode on an empty box: `speech-bar` and its states, `speech-state` Listening, Muted, "Sending in N s" with `speech-cancel`, Thinking…,
//                 Speaking with `speech-interrupt`; no Auto-send in the bar; End leaves the heard words in the box; no voice control is labelled Stop
//   4 set up      with no key Talk opens `setup-voice` ("Set up voice"); Open Settings › Voice pushes `voice-settings` ("‹ Settings"), Back returns to the chat;
//                 Not now closes it
//   5 board       a board the window edits: at rest only `voice-orb` in `board-orb-slot` (no card, nothing of the app over the canvas but the bottom row);
//                 the orb opens `voice-card`; "To:" opens the Chats sheet; a selected shape is "With 1 selected shape" and the orb's badge, × takes it out;
//                 Send carries the selection's tag to the voice chat (and a typed message never does); speaking has Interrupt and Open chat (pushes the chat);
//                 no Auto-send anywhere on the board
// OUT=/tmp/x keeps a screenshot of each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { editHere } from "./boarddraw.mjs";
import { useMic } from "./mic.mjs";
import { act, byTid, press, tidSel } from "./sel.mjs";
import { stackNames } from "./voicephone.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT;
const KEY = "sk_test_V1CANARY1";
const S = "s_uxv1", B = "s_uxv1_bare";
const MSG = /\/chats\/[^/]+\/(branches\/[^/]+\/)?messages(\?|$)/;
const ANSWER = "Here is the plan. First we draw the boxes. Then we connect them with arrows. That is all.";
const DRAFT = "Reply to Dana about the staging rollout";
/** The Set up voice sheet (chunk 3) is in every build since ux-v1-3 merged; V1_SETUP=0 skips it for a build made before. */
const SETUP = process.env.V1_SETUP !== "0";
const here = (id) => `${S}~${id}`;

/** The blocked states (the seed's chats): `said`: the sentences, each counted once on the screen; `drop`: the server that drops once the page has the chat. */
const BLOCKS = [
  { id: "offline", sel: { chat: here("c_UXV1_draft") }, drop: S, kind: "offline", place: "toolbar", said: ["Design Mac is offline since", "Your draft is kept until it's back."], readonly: true, draft: DRAFT, control: "block-servers" },
  { id: "gone", sel: { chat: here("c_UXV1_gone") }, remove: "c_UXV1_gone", kind: "gone", place: "toolbar", said: ["This chat is no longer on Design Mac."], readonly: true },
  { id: "archived", sel: { chat: "c_UXV1_arch" }, kind: "archived", place: "box", said: ["This chat is archived.", "Unarchive it to send a message. It goes back to the list with the others."], control: "unarchive" },
  { id: "archived-off", sel: { chat: here("c_UXV1_arch_remote") }, drop: S, kind: "archived", place: "box", said: ["This chat is archived.", "Design Mac is offline since"] },
  { id: "legacy", sel: { chat: "c_UXV1_legacy" }, kind: "legacy", place: "box", said: ["This chat used the old board connection.", "Start a new chat on this board to go on."] },
  { id: "legacy-board", sel: { board: "b_ui", chat: "c_UXV1_legacy_board" }, kind: "legacy", place: "box", said: ["This chat used the old board connection.", "Start a new chat on this board to go on."], control: "block-newchat" },
  { id: "noagent", sel: { chat: `${B}~c_UXV1_bare` }, kind: "noagent", place: "box", said: ["No agent is installed on Bare box.", "Install Claude Code, Cursor or pi on that computer, then come back."] },
  { id: "toosmall", sel: { chat: here("c_UXV1_small") }, kind: "toosmall", place: "above", said: ["too small a context window"], control: "block-pick-model" },
];

await check("UX.V1 the phone's blocked composer, voice in the composer, the voice card of a board", async ({ url, open, fail, note }) => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const shown = (loc, ms = WAIT) => until(() => loc.first().isVisible().catch(() => false), ms);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const attr = (loc, a) => loc.first().getAttribute(a).catch(() => null);
  const script = (steps) => mockEval(`voice.script(${J(steps)}); return 1;`, url);
  const reply = (t, parts = 8, pace = 1200) => mockEval(`flags.reply = { text: ${J(t)}, parts: ${parts}, pace: ${pace} }; return 1;`, url);
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const phaseIs = (p, ph, ms = 20000) => until(async () => (await sess(p)).phase === ph, ms);
  const posts = (calls) => calls.filter((c) => c.method === "POST" && MSG.test(c.path));
  const bodyText = (c) => (c.body && typeof c.body === "object" ? c.body.text : c.body);
  const page_text = (p) => p.evaluate(() => document.body.innerText);
  const count = (hay, needle) => hay.split(needle).length - 1;
  const lsOf = (theme, settings) => ({ ...(theme === "dark" ? { "aiwb.theme": "dark" } : {}), ...(settings ? { "aiwb.voice.settings": J(settings) } : {}) });
  const shot = async (p, theme, name) => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await atRest(p, 6).catch(() => {});
    await p.screenshot({ path: path.join(OUT, `V1-${theme}-${name}.png`) });
  };
  /** A fresh world and a page on `sel`; the stand-in voice service reset. `key`: a key and a microphone are put in. */
  const session = async (sel, { theme = "light", settings, key = false, wait = tidSel("composer") } = {}) => {
    await mockEval("delete flags.send; delete flags.reply; voice.reset(); return 1;", url);
    await seed(url, "UXV1");
    const o = await open({ sel, wait, ls: lsOf(theme, settings) });
    if (key) {
      await useMic(o.page, note);
      await o.page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    }
    o.calls = callsOf(o.page);
    return o;
  };
  /** Text ≥ 13 px and every control ≥ 44 pt inside the elements `root` names; `first`: the texts whose line is the first (17 px). */
  const sizes = async (p, root, what, first = [], slop = []) => {
    const bad = await p.evaluate(([rootCss, first, slop]) => {
      const out = [];
      const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const roots = [...document.querySelectorAll(rootCss)];
      if (!roots.length) return ["nothing to measure: no element matches"];
      // (`slop` maps a testID to the hitSlop the app gives that control: react-native-web draws none, so the box measured plus the slop on each side is
      // the target, as UX.B2 and UX.T3 count theirs on the web build; the slop itself is the app's own, VoiceCard.tsx)
      for (const el of roots) {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const q = n.parentElement, s = n.textContent.trim();
          if (!s || !q || !seen(q)) continue;
          const px = parseFloat(getComputedStyle(q).fontSize);
          if (px < 13) out.push(`text "${s.slice(0, 30)}" is ${px} px`);
          if (first.some((f) => s.includes(f)) && px < 17) out.push(`the first line "${s.slice(0, 30)}" is ${px} px, under 17`);
        }
        for (const b of el.querySelectorAll('[role="button"],[role="switch"],button')) {
          if (!seen(b) || b.closest('[aria-hidden="true"]')) continue;
          const r = b.getBoundingClientRect(), pad = 2 * (slop[b.getAttribute("data-testid")] ?? 0);
          const w = r.width + pad >= 43.5, h = r.height + pad >= 43.5;
          if (!w || !h) out.push(`${b.getAttribute("role") ?? "button"} "${(b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30)}" [${b.getAttribute("data-testid") ?? ""}] is ${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}`);
        }
      }
      return out;
    }, [root, first, slop]);
    if (bad.length) fail(`sizes, ${what}: ${[...new Set(bad)].slice(0, 6).join("; ")}`);
  };
  const noStop = async (p, what) => {
    const bad = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="speech-"],[data-testid^="voice-"],[data-testid^="dictate-"],[data-testid="composer-dictate"],[data-testid="composer-talk"]')]
      .map((e) => ({ id: e.dataset.testid, text: `${e.getAttribute("aria-label") ?? ""} ${e.textContent ?? ""}`.trim() })).filter((e) => /\bstop\b/i.test(e.text)));
    if (bad.length) fail(`${what}: voice controls say "Stop": ${J(bad)} (only the agent's Stop is Stop)`);
  };

  for (const theme of ["light", "dark"]) {
    const tag = theme;
    // ================= 1: the blocked states
    for (const b of BLOCKS) {
      const { page, ctx } = await session(b.sel, { theme, wait: "" });
      try {
        await page.waitForSelector(tidSel("composer-box"), { timeout: WAIT }).catch(() => page.waitForSelector(tidSel("composer-block"), { timeout: WAIT }));
        if (b.drop) {
          await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: WAIT });
          await sleep(800);
          await mockEval(`setServerState(${J(b.drop)}, "unreachable", { detail: "connection refused" });`, url);
        }
        if (b.remove) { await sleep(800); await mockEval(`onServer(${J(S)}, () => { delete chats.${b.remove}; delete items.${b.remove}; send({ type: "chat_removed", id: ${J(b.remove)} }); });`, url); }
        const block = byTid(page, "composer-block", { kind: b.kind, place: b.place });
        if (!await shown(block)) { fail(`${tag} ${b.id}: no composer-block of kind ${b.kind} in the ${b.place} place`); await ctx.close(); continue; }
        await sleep(400);
        const what = `${tag} ${b.id}`;
        // said once
        const text = await page_text(page);
        for (const s of b.said) if (count(text, s) !== 1) fail(`${what}: "${s}" is on the screen ${count(text, s)} times, not once`);
        if (await byTid(page, "composer-block", { kind: b.kind }).count() !== 1) fail(`${what}: more than one composer-block of kind ${b.kind}`);
        // the box
        const box = byTid(page, "composer-box");
        if (b.place === "toolbar") {
          if (await attr(box, "data-readonly") !== "true") fail(`${what}: the box is not read-only (data-readonly ${J(await attr(box, "data-readonly"))})`);
          if (b.draft && !(await textOf(box)).includes(b.draft)) fail(`${what}: the draft is not in the box (it holds ${J(await textOf(box))})`);
        } else if (b.place === "box") {
          if (await byTid(page, "composer-input").count()) fail(`${what}: the box is drawn beside the block that stands in its place`);
        }
        if (b.place !== "above") {
          if (/Ask or tell/.test(text)) fail(`${what}: the box's placeholder is shown under a block`);
          if (await byTid(page, "composer-err").count()) fail(`${what}: a composer-err line is drawn (the sentence is said twice)`);
          if (await byTid(page, "model-notice").count()) fail(`${what}: a model notice is drawn beside the block`);
          if (await byTid(page, "archived-bar").count() > 1) fail(`${what}: more than one archived bar`);
        } else if (await byTid(page, "model-notice", { warn: true }).count() !== 1) fail(`${what}: the amber card's line is not the one model notice`);
        if (b.id === "toosmall") {
          if (await byTid(page, "composer-block", { kind: "toosmall" }).locator(tidSel("block-dismiss")).count()) fail(`${what}: the amber card has a × (it has none: Pick a model is its control)`);
          await press(page, byTid(page, "composer-input"));
          await page.keyboard.type("hello");
          const send = byTid(page, "send");
          if (!await until(async () => (await attr(send, "aria-disabled")) === "true", 5000)) fail(`${what}: Send is not greyed (aria-disabled ${J(await attr(send, "aria-disabled"))}) with a model too small`);
          else if (!/too small a context window/.test((await attr(send, "aria-label")) ?? "")) fail(`${what}: Send's label is ${J(await attr(send, "aria-label"))}, not the reason`);
          await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
          await page.keyboard.press("Backspace");
        }
        await sizes(page, tidSel("composer-block"), what, b.place === "above" ? [] : [b.said[0]]);
        await shot(page, theme, b.id);
        // its control
        if (theme === "light" && b.control) {
          const c = byTid(page, b.control);
          if (!await shown(c, 5000)) fail(`${what}: no ${b.control}`);
          else if (b.control === "block-servers") {
            await press(page, c);
            if (!await until(() => byTid(page, "srv-facts").count(), WAIT)) fail(`${what}: Servers did not push the server's detail (srv-facts)`);
          } else if (b.control === "unarchive") {
            await press(page, c);
            if (!await until(() => byTid(page, "composer-input").count(), WAIT)) fail(`${what}: Unarchive did not bring the box back`);
            if (await byTid(page, "composer-block").count()) fail(`${what}: the block stays after Unarchive`);
          } else if (b.control === "block-newchat") {
            const before = await page.evaluate(() => JSON.stringify(window.__aiwbStack.entries().map((e) => e.key)));
            await press(page, c);
            if (!await until(async () => (await byTid(page, "composer-input").count()) > 0 && (await byTid(page, "empty-thread").count()) > 0, WAIT)) fail(`${what}: New chat on this board did not open an empty chat (stack was ${before})`);
            else if (!(await textOf(byTid(page, "ctx-chip", { kind: "board" }))).includes("Sketch")) fail(`${what}: the new chat is not on the board "Sketch"`);
          } else if (b.control === "block-pick-model") {
            await press(page, c);
            if (!await shown(byTid(page, "model-sheet"))) fail(`${what}: Pick a model did not open the model sheet`);
          }
        }
      } catch (e) { fail(`${tag} ${b.id}: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }
    // no agent in a NEW chat: the sentence is the block's alone (the phone's empty thread does not repeat it as `empty-reason`): said once
    if (theme === "light") {
      const { page, ctx } = await session({ chat: `${B}~c_UXV1_bare_new` }, { theme, wait: "" });
      try {
        await byTid(page, "composer-block", { kind: "noagent" }).first().waitFor({ state: "visible", timeout: WAIT });
        const n = count(await page_text(page), "No agent is installed on Bare box.");
        if (n !== 1) fail(`${tag} noagent-new: "No agent is installed on Bare box." is on the screen ${n} times, not once`);
        if (await byTid(page, "empty-reason").count()) fail(`${tag} noagent-new: the empty thread repeats the block as empty-reason`);
      } catch (e) { fail(`${tag} noagent-new: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }
    // the refused card: a send the server refuses; × removes it and leaves the text
    {
      const { page, ctx } = await session({ chat: "c_UXV1_plain" }, { theme });
      try {
        await mockEval(`flags.send = { refuse: { status: 409, code: "agent_missing", error: "Claude Code is not installed on this computer" } }; return 1;`, url);
        await press(page, byTid(page, "composer-input"));
        await page.keyboard.type("Does the tax rounding have the same problem?");
        await press(page, byTid(page, "send"));
        const card = byTid(page, "composer-block", { kind: "refused", place: "above" });
        if (!await shown(card)) fail(`${tag} refused: no refused card after the send was refused`);
        else {
          await sleep(300);
          const text = await page_text(page);
          if (count(text, "Claude Code is not installed on this computer") !== 1) fail(`${tag} refused: the reason is on the screen ${count(text, "Claude Code is not installed on this computer")} times, not once`);
          if (await byTid(page, "composer-err").count() !== 1) fail(`${tag} refused: ${await byTid(page, "composer-err").count()} composer-err lines, not the one on the card`);
          if (await byTid(page, "composer-block", { kind: "refused" }).locator(tidSel("composer-err")).count() !== 1) fail(`${tag} refused: the reason is not on the card`);
          if (!(await textOf(byTid(page, "composer-box"))).includes("Does the tax rounding")) fail(`${tag} refused: the text left the box`);
          await sizes(page, tidSel("composer-block"), `${tag} refused`);
          await shot(page, theme, "refused");
          await press(page, byTid(page, "block-dismiss"));
          if (!await until(async () => (await byTid(page, "composer-block").count()) === 0, 5000)) fail(`${tag} refused: × did not remove the card`);
          if (!(await textOf(byTid(page, "composer-box"))).includes("Does the tax rounding")) fail(`${tag} refused: × took the text out of the box`);
        }
      } catch (e) { fail(`${tag} refused: ${e.message.split("\n")[0]}`); }
      await mockEval("delete flags.send; return 1;", url);
      await ctx.close().catch(() => {});
    }
    note(`${tag}: ${BLOCKS.length + 1} blocked states, each said once, read-only where the design says so, with their controls`);

    // ================= 2: Dictate
    {
      const { page, ctx } = await session({ chat: "c_UXV1_plain" }, { theme, key: true });
      try {
        const box = byTid(page, "composer-input");
        const txt = async () => ((await box.first().textContent()) ?? "").replace(/ /g, " ").trim();
        await press(page, box);
        await page.keyboard.type("my draft");
        await script([{ after: 3, committed: "turn the lights" }, { after: 6, partial: "on in the hall" }]);
        const mic = byTid(page, "voice-dictate").locator("[aria-label]");
        if (await attr(mic, "aria-label") === "End dictation") fail(`${tag} dictate: the mic says "End dictation" before dictation started`);
        await press(page, byTid(page, "voice-dictate"));
        if (!await until(async () => (await byTid(page, "dictate-guess").count()) > 0, 20000)) fail(`${tag} dictate: no dictate-guess (the box holds ${J(await txt())})`);
        else {
          const line = byTid(page, "dictate-line");
          const lt = await textOf(line);
          if (!lt.includes("Listening…") || !lt.includes("Tap the mic to end")) fail(`${tag} dictate: the line says ${J(lt)}, not "Listening…" and "Tap the mic to end"`);
          if (/stop/i.test(lt)) fail(`${tag} dictate: the line says Stop`);
          const guess = await textOf(byTid(page, "dictate-guess"));
          if (!guess.includes("on in the hall")) fail(`${tag} dictate: the guess says ${J(guess)}`);
          const inBox = await txt();
          if (inBox.includes("on in the hall")) fail(`${tag} dictate: the guess is in the box's text (${J(inBox)})`);
          if (!inBox.includes("my draft") || !inBox.includes("turn the lights")) fail(`${tag} dictate: the box holds ${J(inBox)}, not the draft and the finished words`);
          if (await byTid(page, "send").count() !== 1) fail(`${tag} dictate: Send is not the primary while dictating`);
          if (await byTid(page, "voice-speech").count()) fail(`${tag} dictate: Talk is drawn beside Send`);
          if (await attr(mic, "aria-label") !== "End dictation") fail(`${tag} dictate: the mic's label is ${J(await attr(mic, "aria-label"))}, not "End dictation"`);
          await noStop(page, `${tag} dictate`);
          await sizes(page, tidSel("composer"), `${tag} dictate`);
          await shot(page, theme, "dictate");
        }
        await press(page, byTid(page, "voice-dictate"));
        if (!await phaseIs(page, "idle", 10000)) fail(`${tag} dictate: the mic did not end dictation`);
        if (await byTid(page, "dictate-line").count()) fail(`${tag} dictate: the line stays after dictation ended`);
      } catch (e) { fail(`${tag} dictate: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }

    // ================= 3: speech mode
    {
      // Auto-send off: Listening, Muted, End leaves the heard words in the box
      const { page, ctx } = await session({ chat: "c_UXV1_plain" }, { theme, key: true, settings: { autoSend: false } });
      try {
        await script([{ after: 3, committed: "what is the plan" }, { after: 6, partial: "for the board" }]);
        await press(page, byTid(page, "voice-speech"));
        if (!await phaseIs(page, "listening")) fail(`${tag} speech: speech mode did not start listening`);
        const bar = byTid(page, "speech-bar");
        if (!await shown(bar)) fail(`${tag} speech: no speech bar`);
        else {
          if (!await until(async () => /for the board/.test(await textOf(bar)), 20000)) fail(`${tag} speech: the words never reached the bar (${J(await textOf(bar))})`);
          const word = byTid(page, "speech-state");
          if (await textOf(word) !== "Listening") fail(`${tag} speech: the state word is ${J(await textOf(word))}, not "Listening"`);
          if (await byTid(page, "speech-autosend").count()) fail(`${tag} speech: the bar has the Auto-send switch`);
          if (/Auto-send/.test(await textOf(bar))) fail(`${tag} speech: the bar says "Auto-send"`);
          if (await attr(byTid(page, "speech-send"), "disabled") !== null && (await textOf(byTid(page, "speech-words"))) === "") fail(`${tag} speech: Send is off with words`);
          await noStop(page, `${tag} speech listening`);
          await sizes(page, tidSel("speech-bar"), `${tag} speech listening`);
          await shot(page, theme, "speech-listening");
          await press(page, byTid(page, "speech-mute"));
          if (!await until(async () => (await textOf(word)) === "Muted", 5000)) fail(`${tag} speech: muted, the state word is ${J(await textOf(word))}`);
          await shot(page, theme, "speech-muted");
          await press(page, byTid(page, "speech-mute"));
          await press(page, byTid(page, "speech-end"));
          if (!await phaseIs(page, "idle", 10000)) fail(`${tag} speech: End did not end speech mode`);
          await sleep(400);
          const left = ((await byTid(page, "composer-input").first().textContent()) ?? "").replace(/ /g, " ");
          if (!left.includes("what is the plan")) fail(`${tag} speech: End left ${J(left)} in the box, not the heard words`);
          if (await byTid(page, "speech-bar").count()) fail(`${tag} speech: the bar stays after End`);
        }
      } catch (e) { fail(`${tag} speech: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }
    {
      // Auto-send on: the countdown with Cancel, Thinking…, Speaking with Interrupt
      const { page, ctx } = await session({ chat: "c_UXV1_plain" }, { theme, key: true, settings: { autoSend: true, pauseMs: 3000 } });
      try {
        await script([{ after: 3, partial: "what is" }, { after: 6, committed: "what is the plan" }]);
        await reply(ANSWER);
        await press(page, byTid(page, "voice-speech"));
        const word = byTid(page, "speech-state");
        if (!await until(async () => (await byTid(page, "speech-countdown").count()) > 0, 30000)) fail(`${tag} speech: no countdown`);
        else {
          const w = await textOf(word);
          if (!/^Sending in \d+(\.\d)? s$/.test(w)) fail(`${tag} speech: the countdown's word is ${J(w)}, not "Sending in N s"`);
          if (!await shown(byTid(page, "speech-cancel"), 3000)) fail(`${tag} speech: the countdown has no Cancel`);
          else if (!/^Cancel$/.test(await textOf(byTid(page, "speech-cancel")))) fail(`${tag} speech: the countdown's button says ${J(await textOf(byTid(page, "speech-cancel")))}`);
          await sizes(page, tidSel("speech-bar"), `${tag} speech countdown`);
          await shot(page, theme, "speech-countdown");
        }
        if (!await until(async () => (await textOf(word)) === "Thinking…", 40000)) fail(`${tag} speech: the state word never became "Thinking…" (it is ${J(await textOf(word))})`);
        else {
          if (await byTid(page, "speech-interrupt").count() || await byTid(page, "speech-cancel").count()) fail(`${tag} speech: Thinking… has an action (it has none)`);
          await shot(page, theme, "speech-thinking");
        }
        if (!await until(async () => (await textOf(word)) === "Speaking", 40000)) fail(`${tag} speech: the state word never became "Speaking" (it is ${J(await textOf(word))})`);
        else {
          if (!await shown(byTid(page, "speech-interrupt"), 3000)) fail(`${tag} speech: Speaking has no Interrupt`);
          else if (await textOf(byTid(page, "speech-interrupt")) !== "Interrupt") fail(`${tag} speech: Interrupt says ${J(await textOf(byTid(page, "speech-interrupt")))}`);
          await noStop(page, `${tag} speech speaking`);
          await sizes(page, tidSel("speech-bar"), `${tag} speech speaking`);
          await shot(page, theme, "speech-speaking");
        }
        await press(page, byTid(page, "speech-end")).catch(() => {});
      } catch (e) { fail(`${tag} speech: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }

    // ================= 4: Set up voice (no key: Talk opens the sheet)
    if (SETUP) {
      const { page, ctx } = await session({ chat: "c_UXV1_plain" }, { theme });
      try {
        const sheet = byTid(page, "setup-voice");
        await press(page, byTid(page, "voice-speech"));
        if (!await shown(sheet)) fail(`${tag} setup: Talk with no key did not open the Set up voice sheet (setup-voice)`);
        else {
          const t = await textOf(sheet);
          for (const w of ["Set up voice", "Talk to Claude Code", "ElevenLabs", "Open Settings › Voice", "Not now"]) if (!t.includes(w)) fail(`${tag} setup: the sheet lacks ${J(w)} (it says ${J(t.slice(0, 300))})`);
          if (await byTid(page, "voice-problem", { kind: "no_key" }).count() !== 1) fail(`${tag} setup: no voice-problem of kind no_key`);
          if (await sheet.locator("input,textarea").count()) fail(`${tag} setup: the sheet has a key field (only Settings has one)`);
          if (await byTid(page, "voice-problem-text").count() < 1) fail(`${tag} setup: no voice-problem-text`);
          await sizes(page, tidSel("setup-voice"), `${tag} setup`);
          await shot(page, theme, "setup-voice");
          if (theme === "light") {
            await press(page, byTid(page, "voice-problem-act"));
            if (!await until(async () => (await stackNames(page)).includes("voice-settings"), WAIT)) fail(`${tag} setup: Open Settings › Voice did not push voice-settings (${J(await stackNames(page))})`);
            else {
              const back = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="nav-back"]')].pop(); return b ? b.innerText.trim() : null; });
              if (back !== "Settings") fail(`${tag} setup: the voice screen's back says ${J(back)}, not "Settings"`);
              await press(page, byTid(page, "nav-back").last());
              if (!await until(async () => (await stackNames(page)).at(-1) === "settings", WAIT)) fail(`${tag} setup: Back from the voice screen did not land on Settings (${J(await stackNames(page))})`);
              await press(page, byTid(page, "nav-back").last()); // (the chat, Settings and the voice screen were pushed in that order: a second Back returns to the chat)
              if (!await until(async () => /^chat/.test((await stackNames(page)).at(-1) ?? ""), WAIT)) fail(`${tag} setup: a second Back did not return to the chat (${J(await stackNames(page))})`);
            }
            await byTid(page, "setup-voice").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => fail(`${tag} setup: the sheet stays after Open Settings`));
            await press(page, byTid(page, "voice-speech"));
            if (!await shown(sheet)) fail(`${tag} setup: the sheet does not open a second time`);
            else {
              await press(page, byTid(page, "voice-problem-dismiss"));
              if (!await until(async () => (await sheet.count()) === 0, 5000)) fail(`${tag} setup: Not now did not close the sheet`);
            }
          }
        }
      } catch (e) { fail(`${tag} setup: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }

    // ================= 5: the board (the window edits it)
    {
      const { page, ctx, calls } = await session({ board: "b_ui", chat: null }, { theme, key: true, settings: { autoSend: false, pauseMs: 600 }, wait: tidSel("board-canvas") });
      try {
        await page.waitForSelector(tidSel("board-canvas", { state: "ready" }), { timeout: WAIT });
        await editHere(page);
        await byTid(page, "voice-orb").first().waitFor({ state: "visible", timeout: WAIT });
        // at rest: the orb in its slot, no card, nothing of the app over the canvas but the bottom row
        if (await byTid(page, "board-orb-slot").locator(tidSel("voice-orb")).count() !== 1) fail(`${tag} board: the orb is not in board-orb-slot`);
        if (await byTid(page, "voice-card").count()) fail(`${tag} board: a voice card is drawn at rest`);
        if (await byTid(page, "voice-orb").count() !== 1) fail(`${tag} board: ${await byTid(page, "voice-orb").count()} orbs`);
        if (await attr(byTid(page, "voice-orb"), "aria-label") !== "Talk") fail(`${tag} board: the orb's label is ${J(await attr(byTid(page, "voice-orb"), "aria-label"))}, not "Talk"`);
        const over = await page.evaluate(() => {
          const canvas = document.querySelector(".excalidraw canvas.interactive") ?? document.querySelector(".excalidraw canvas");
          if (!canvas) return ["no canvas"];
          const c = canvas.getBoundingClientRect(), row = document.querySelector('[data-testid="board-row"]'), out = [];
          for (const e of document.querySelectorAll("[data-testid]")) {
            if (e.closest(".excalidraw") || e.contains(canvas) || /^flash/.test(e.dataset.testid) /* the agent-edit flash layer: transparent and drawn only while an edit flashes */ || (row && (row === e || row.contains(e)))) continue;
            const r = e.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || getComputedStyle(e).visibility === "hidden") continue;
            if (Math.min(r.right, c.right) - Math.max(r.left, c.left) > 2 && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 2) out.push(`${e.dataset.testid} (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)})`);
          }
          return out;
        });
        if (over.length) fail(`${tag} board at rest: the app draws over the canvas: ${over.slice(0, 6).join(", ")}`);
        const orbR = await byTid(page, "voice-orb").first().boundingBox();
        if (orbR.width < 43.5 || orbR.height < 43.5) fail(`${tag} board: the orb is ${Math.round(orbR.width)}×${Math.round(orbR.height)}, under 44`);
        await shot(page, theme, "board-rest");
        // one selected shape: a click on the rectangle's edge (the view says where it is)
        const v = await page.evaluate(() => window.__aiwbView()), cv = await byTid(page, "board-canvas").first().boundingBox();
        const x = cv.x + (160 + v.scrollX) * v.zoom, y = cv.y + (80 + v.scrollY) * v.zoom; // (the top edge of the rectangle: an unfilled shape is picked by its stroke)
        await page.mouse.click(x, y);
        if (await attr(byTid(page, "voice-orb"), "data-badge") !== null) fail(`${tag} board: the orb has a badge at rest (it counts only what goes with a spoken turn)`);
        // press the orb: the card listens
        await script([{ after: 3, partial: "make it" }, { after: 6, committed: "make it blue" }]);
        await reply("Done. Anything else?", 2, 800);
        await press(page, byTid(page, "voice-orb"));
        const card = byTid(page, "voice-card");
        if (!await shown(card)) fail(`${tag} board: the orb did not open the voice card`);
        else {
          if (!await until(async () => /make it blue/.test(await textOf(byTid(page, "voice-card-words"))), 20000)) fail(`${tag} board: the words never reached the card (${J(await textOf(card))})`);
          const t = await textOf(card);
          if (!t.includes("To:")) fail(`${tag} board: the card does not say "To:" (${J(t)})`);
          if (!/With 1 selected shape(?!s)/.test(t)) fail(`${tag} board: the card does not say "With 1 selected shape" (${J(t)})`);
          if (await attr(byTid(page, "voice-orb"), "data-badge") !== "1") fail(`${tag} board: with one shape selected the orb's badge is ${J(await attr(byTid(page, "voice-orb"), "data-badge"))}, not 1`);
          if (/Auto-send/.test(t) || await byTid(page, "pill-autosend").count() || await byTid(page, "speech-autosend").count()) fail(`${tag} board: Auto-send is on the board's card`);
          await noStop(page, `${tag} board card`);
          await sizes(page, tidSel("voice-card"), `${tag} board card`, [], { "voice-card-selection-x": 6 } /* (hitSlop 6 on a 32 pt box: 44 pt) */);
          await shot(page, theme, "board-card");
          if (theme === "light") {
            // "To:" opens the Chats sheet
            await press(page, byTid(page, "voice-card-to"));
            if (!await shown(byTid(page, "chats-sheet"))) fail(`${tag} board: "To:" did not open the Chats sheet`);
            else await page.keyboard.press("Escape");
            await byTid(page, "chats-sheet").first().waitFor({ state: "hidden", timeout: 5000 }).catch(async () => { await page.mouse.click(20, 80); });
          }
          // × takes the selection out of the turn
          if (theme === "light") {
            await press(page, byTid(page, "voice-card-selection-x"));
            if (!await until(async () => (await byTid(page, "voice-card-selection").count()) === 0, 5000)) fail(`${tag} board: × did not take the selection out of the card`);
            if (await attr(byTid(page, "voice-orb"), "data-badge") === "1") fail(`${tag} board: the orb's badge stays after ×`);
          }
          // Send: the message carries the selection's tag (not after ×) and the words
          await press(page, byTid(page, "voice-card-send"));
          const sent = await until(() => posts(calls).length === 1, 20000);
          if (!sent) fail(`${tag} board: Send sent no message`);
          else {
            const text = bodyText(posts(calls)[0]);
            const withTag = /^<selection ids="[^"]+" label="[^"]*">[^<]*<\/selection> make it blue$/.test(text);
            if (theme === "light" ? text !== "make it blue" : !withTag) fail(`${tag} board: the spoken turn is ${J(text)}, not ${theme === "light" ? "the words alone (the selection was taken out)" : "the selection's tag and the words"}`);
          }
          // thinking, speaking: Interrupt and Open chat
          if (!await until(async () => (await attr(card, "data-phase")) === "speaking", 40000)) fail(`${tag} board: the card never spoke (phase ${J(await attr(card, "data-phase"))})`);
          else {
            if (!await shown(byTid(page, "voice-card-interrupt"), 3000)) fail(`${tag} board: no Interrupt while the reply is spoken`);
            if (!await shown(byTid(page, "voice-card-open"), 3000)) fail(`${tag} board: no Open chat while the reply is spoken`);
            await noStop(page, `${tag} board speaking`);
            await sizes(page, tidSel("voice-card"), `${tag} board speaking`);
            await shot(page, theme, "board-speaking");
            if (theme === "light") {
              await press(page, byTid(page, "voice-card-open"));
              if (!await shown(byTid(page, "chat-head"))) fail(`${tag} board: Open chat did not push the chat`);
              else {
                // a typed message in a chat of the board never carries the selection
                const before = posts(calls).length;
                await press(page, byTid(page, "composer-input"));
                await page.keyboard.type("a typed note");
                await press(page, byTid(page, "send"));
                if (!await until(() => posts(calls).length === before + 1, 20000)) fail(`${tag} board: the typed message was not sent`);
                else if (/<selection/.test(bodyText(posts(calls)[before]) ?? "")) fail(`${tag} board: a typed message carries a selection: ${J(bodyText(posts(calls)[before]))}`);
              }
            } else await press(page, byTid(page, "voice-card-interrupt")).catch(() => {});
          }
        }
      } catch (e) { fail(`${tag} board: ${e.message.split("\n")[0]}`); }
      await ctx.close().catch(() => {});
    }
    note(`${tag}: Dictate, speech mode and the board's voice card walked`);
  }
}, { viewports, page: false });
