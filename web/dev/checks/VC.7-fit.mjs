// VC.7 (new, voice-chats P13a): Dictate and Speech mode in the composer's toolbar, and their place as the room changes, on the mock with the
// stand-in voice service, at the desktop, the tablet and the phone. Goal 3.4, 4.5, 4.10, 6.6; architecture VC-17 (core's `fitWithTail`).
//   the row        on a wide composer the pair stands after the row's spacer: insert button, Dictate, Speech mode, attach, Send, in that order, the pair
//                  one gap from the attach button and Dictate beside Speech mode; both inside the box, none past the row
//   the popup      on the narrowest row (a window of 200 px) the pair is two entries of the "more" popup (`more-row` control "dictate" and "speech"), after
//                  the insert entry, and the row holds neither; the "more" chip is there (it comes with the pair when the row had none)
//   the order      across rows from the widest to the narrowest the pair leaves last: it is never in the popup while the insert button, a control or the
//                  meter's text is in the row, never in the popup with no "more" chip, in the row when wide and in the popup when narrowest, and once
//                  it is in the row it stays there in every wider row
//   both work      from the popup: Dictate puts the words in the box and a second press stops it; Speech mode starts speech mode, whose bar takes
//                  the place of the box and the toolbar (so no chip is seen), and End on the bar ends it and the toolbar and the pair come back
//                  as they were; the popup closes as listening starts, and its chip is tinted while Dictate inside is on
//   no key         a press in the popup shows the "needs your key" popover and starts nothing
//   off            on a chat shown as it was (its server is not connected) both controls are off and say why in their title
//   never used     a page that never presses either makes no request to the voice service and never calls getUserMedia (goal 3.9)
//   the phone      (package V1) a window under 700 px draws the phone composer (ux-improvements C1), which has no `composer-tools` row and no "more" popup: its
//                  toolbar always holds Dictate (`voice-dictate`) and, while the box is empty, Talk (`voice-speech`, the primary; with text the primary is Send),
//                  both 44 pt, to a window of 200 px; both work from there (Dictate puts the words in the box, Talk's bar takes the box's and the toolbar's place
//                  and End brings them back), a press with no key shows the problem and starts nothing, and a chat shown as it was has the block in the box's place.
//                  The wide composer's popup is the pair's last place and no wide layout reaches it: the narrowest row of a wide composer is 255 px (the board's
//                  panel at its 300 px minimum; the page keeps 320 px), with the pair still in the row. The popup's half runs where a row reaches it.
// OUT=/tmp/x keeps a screenshot of the page in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { HEIGHT, MORE, POP, frame, openState, resizeTo } from "./composer.mjs";
import { useMic } from "./mic.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

const PHONE_TARGET = 44; // the phone's smallest control, in points (app/src/ui/metrics.ts PHONE.target)

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_VC7CANARY1";
const J = JSON.stringify;

await check("VC.7 the composer's voice pair: in the row, in the \"more\" popup, in the order the room gives", async ({ url, viewport, layout, open, fail, note }) => {
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.7-${viewport}-${name}.png`) }); } };
  const states = async () => seed(url, "A2");
  const stateOf = async (id) => (await states()).find((s) => s.id === id);
  /** What the toolbar says of itself: where it put the insert button and the pair, whether it has the "more" chip. */
  const place = (p) => p.evaluate(() => {
    const t = document.querySelector('[data-testid="composer-tools"]');
    return t ? { voice: t.dataset.voice, insert: t.dataset.insert, more: t.dataset.more === "true", meter: t.dataset.meter, tools: t.querySelectorAll('[data-testid="tool"]').length, w: innerWidth, row: Math.round(t.getBoundingClientRect().width) } : null;
  });
  const rect = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, sel);
  const textOf = async (p) => ((await byTid(p, "composer-input").first().textContent()) ?? "").replace(/ /g, " ");
  const sess = (p) => p.evaluate(() => window.__aiwbVoice.state().session);
  const boxOf = (p) => p.evaluate(() => { const e = document.querySelector('[data-testid="composer-input"]'); return ((e?.value ?? e?.textContent ?? "") + "").replace(/ /g, " "); });
  /** What the phone composer's toolbar holds: its voice controls (the wrapper `voice-dictate` / `voice-speech`) with their size, and whether a wide row or a popup is drawn. */
  const phoneTools = (p) => p.evaluate(() => {
    const r = (id) => { const e = document.querySelector(`[data-testid="${id}"]`); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height, off: e.getAttribute("aria-disabled") === "true" || e.disabled === true }; };
    return { w: innerWidth, bar: !!document.querySelector('[data-testid="composer-phone-tools"]'), wide: !!document.querySelector('[data-testid="composer-tools"]'),
      popup: !!document.querySelector('[data-testid="more-chip"], [data-testid="more-pop"]'), dict: r("voice-dictate"), talk: r("voice-speech"), send: r("send"), plus: r("composer-plus"),
      talkBtn: r("composer-talk"), dictBtn: r("composer-dictate") };
  });
  /** The phone toolbar's rules in a window: no row, no popup; Dictate and (the box empty) Talk are in it, 44 pt and inside the window (`inside`: from 320 px, the
   *  narrowest phone; below it the five 44 pt controls of the toolbar run 3 px past a window of 200), Dictate before Talk. */
  const judgePhone = (t, what, fail, { empty = true, inside = true } = {}) => {
    if (!t.bar) return fail(`${what}: no phone toolbar (composer-phone-tools)`);
    if (t.wide || t.popup) fail(`${what}: the phone window draws a wide row or a "more" popup`);
    for (const [id, c] of [["voice-dictate", t.dict], ...(empty ? [["voice-speech", t.talk]] : [])]) {
      if (!c) { fail(`${what}: the toolbar has no ${id}`); continue; }
      if (c.w < PHONE_TARGET - 0.5 || c.h < PHONE_TARGET - 0.5) fail(`${what}: ${id} is ${Math.round(c.w)}x${Math.round(c.h)} pt, under ${PHONE_TARGET}`);
      if (inside && (c.r > t.w + 0.5 || c.l < -0.5)) fail(`${what}: ${id} is outside the window (${Math.round(c.l)} to ${Math.round(c.r)} in ${t.w})`);
    }
    if (empty && t.dict && t.talk && t.dict.r > t.talk.l + 0.5) fail(`${what}: Dictate is not before Talk`);
    if (!empty && t.talk) fail(`${what}: Talk is drawn with text in the box (the primary is Send)`);
    if (!empty && !t.send) fail(`${what}: Send is not drawn with text in the box`);
  };
  const resize = async (p, w) => { await p.setViewportSize({ width: w, height: HEIGHT }); await frame(p); await frame(p); };
  const log = () => mockEval("return voice.log();", url);

  // ---- the row: a chat with few controls, wide (the phone viewport's window is the phone composer: the phone block below is its half)
  if (layout !== "phone") {
    const { page, ctx } = await openState(open, await stateOf("plain-started"), layout, 900);
    const calls = callsOf(page);
    await page.evaluate(() => { window.__gum = 0; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return g(...a); }; });
    const at = await place(page);
    if (at?.voice !== "row") fail(`a wide composer puts the pair in the ${at?.voice || "nowhere"}, not the row`);
    for (const id of ["voice-dictate", "voice-speech"]) if (await byTid(page, id).count() !== 1) fail(`the row has ${await byTid(page, id).count()} ${id}, not 1`);
    const R = { box: await rect(page, tidSel("composer-box")), ins: await rect(page, tidSel("insert-btn")), dict: await rect(page, tidSel("voice-dictate")), sp: await rect(page, tidSel("voice-speech")), att: await rect(page, tidSel("attach-btn")), send: await rect(page, tidSel("send")) };
    // (the insert button is in the row where there is room for it beside the pair: the phone's has none)
    if (Object.entries(R).some(([k, v]) => !v && !(k === "ins" && at?.insert !== "row"))) fail(`a control of the row is not drawn: ${J(Object.entries(R).filter(([, v]) => !v).map(([k]) => k))}`);
    else {
      if (!((!R.ins || R.ins.r <= R.dict.l) && R.dict.r <= R.sp.l && R.sp.r <= R.att.l && R.att.r <= R.send.l)) fail(`the row is not insert, Dictate, Speech mode, attach, Send from the left: ${J(R)}`);
      if (Math.abs(R.sp.l - R.dict.r - 4) > 1.5 || Math.abs(R.att.l - R.sp.r - 4) > 1.5) fail(`the pair is not one gap beside itself and the attach button: Dictate ends ${R.dict.r}, Speech mode ${R.sp.l} to ${R.sp.r}, attach ${R.att.l}`);
      if (R.sp.r > R.box.r || R.dict.l < R.box.l) fail("the pair is outside the box");
      const row = await rect(page, tidSel("composer-tools"));
      if (Math.abs((R.dict.t + R.dict.b) / 2 - (R.send.t + R.send.b) / 2) > 2) fail(`Dictate is not on Send's line: ${R.dict.t} to ${R.dict.b}, Send ${R.send.t} to ${R.send.b}`);
      if (R.sp.r > row.r + 0.5) fail("the pair ends past the row");
    }
    for (const [id, title] of [["voice-dictate", "Dictate"], ["voice-speech", "Speech mode"]]) {
      if (await byTid(page, id).getAttribute("title") !== title) fail(`${id} is titled ${J(await byTid(page, id).getAttribute("title"))}, not ${J(title)}`);
      if (await byTid(page, id).getAttribute("data-on") !== "false") fail(`${id} says it is on before anything was pressed`);
      if (await byTid(page, id).isDisabled()) fail(`${id} is off on a chat that can send`);
    }
    await shot(page, "1-row");
    // never used: nothing of voice has run
    if (calls.some((c) => /\/voice\//.test(c.path ?? c.url ?? ""))) fail("a page that never pressed either control made a request to the voice service");
    if ((await log()).length) fail(`the stand-in saw ${(await log()).length} requests from a page that never used voice`);
    if (await page.evaluate(() => window.__gum) !== 0) fail("getUserMedia was called by a page that never used voice");
    await ctx.close();
  }

  // ---- the order, from wide to narrow
  {
    const { page, ctx } = await openState(open, await stateOf("plain-new"), layout, 900);
    const widths = [];
    for (let w = 1200; w >= 200; w -= (w > 700 ? 50 : 20)) widths.push(w);
    const seen = [];
    for (const w of widths) {
      await resize(page, w);
      const at = await place(page);
      if (at) { seen.push({ ...at, w }); continue; }
      // (under 700 px the window is the phone layout: its toolbar is the phone's, with the pair always in it)
      judgePhone(await phoneTools(page), `a window of ${w} px`, fail, { inside: w >= 320 });
    }
    await ctx.close(); // (the mock has one stream for one page: the panel's page opens after this one is closed)
    // (the wide composer's narrowest row: the board's panel at its minimum, where the desktop's resizer can put it)
    if (layout === "desktop") {
      const panel = await stateOf("board-new");
      const { page: pp, ctx: pc } = await openState(open, panel, layout, 760);
      for (const w of [760, 640, 560, 500, 440, 400, 360, 330, 300]) { await resizeTo(pp, panel, layout, w); const at = await place(pp); if (at) seen.push({ ...at, w, panel: true }); }
      await pc.close();
    }
    // (the window's width is not the row's: the layout changes at 1100 and 700 px, and the pane with it. The room is the row's own.)
    seen.sort((a, b) => b.row - a.row);
    note(`${seen.length} windows, rows of ${seen.at(-1).row} to ${seen[0].row} px, the insert button and the pair as: ${[...new Set(seen.map((s) => `${s.insert || "-"}/${s.voice}`))].join(" ")}`);
    if (seen.some((s) => s.voice !== "row" && s.voice !== "more")) fail(`the pair is in ${J([...new Set(seen.map((s) => s.voice))])}, not the row or the popup`);
    if (seen.some((s) => s.insert === "row" && s.voice === "more")) fail(`the pair is in the popup while the insert button is in the row: rows of ${J(seen.filter((s) => s.insert === "row" && s.voice === "more").map((s) => s.row))} px`);
    if (seen.some((s) => s.voice === "more" && !s.more)) fail(`the pair is in the popup with no "more" chip: rows of ${J(seen.filter((s) => s.voice === "more" && !s.more).map((s) => s.row))} px`);
    const firstNot = (key, value) => seen.find((s) => s[key] !== value)?.row ?? 0; // the widest row at which it is no longer there
    if (firstNot("insert", "row") < firstNot("voice", "row")) fail(`the pair left the row at ${firstNot("voice", "row")} px, before the insert button did (${firstNot("insert", "row")} px)`);
    const early = seen.filter((s) => s.voice === "more" && (s.tools > 0 || s.meter !== "ring"));
    if (early.length) fail(`the pair is in the popup while the row still holds a control or the meter's text: ${J(early.map((s) => ({ row: s.row, tools: s.tools, meter: s.meter })))}`);
    // (the popup is the pair's place when even the narrowest row has no room; a wide layout's narrowest row is 255 px, which still holds the pair: the
    // phone layout, which could reach the popup at 200 px, has no popup. What is asserted is that the pair never leaves the row before the room is gone.)
    if (seen.at(-1)?.voice !== "more") note(`the pair is still in the row in the narrowest wide row seen, ${seen.at(-1)?.row} px: the popup is not reached by a wide layout`);
    if (seen[0]?.voice !== "row") fail(`in a row of ${seen[0]?.row} px the pair is not in the row`);
    // (monotonic, by core's rule: the pair leaves only where the row cannot hold it at its last step, which does not depend on the room)
    const back = seen.findIndex((s, i) => i > 0 && s.voice === "row" && seen[i - 1].voice === "more");
    if (back >= 0) fail(`the pair is in the popup in a row of ${seen[back - 1].row} px and in the row in a narrower one of ${seen[back].row} px`);
    await ctx.close();
  }

  // ---- the popup: the narrowest row of a wide composer (the desktop's board panel at its minimum, a touch viewport's window of 700 px); it holds the popup's half
  // only where that row has no room for the pair, which no wide layout has now (the order block's note says the row): the phone block proves the phone's half
  {
    const narrow = layout === "desktop" ? await stateOf("board-new") : await stateOf("plain-new");
    const { page, ctx } = layout === "desktop" ? await openState(open, narrow, layout, 300) : await openState(open, narrow, layout, 0, { size: [700, HEIGHT] });
    const at = await place(page);
    if (at?.voice !== "more") {
      note(`the narrowest wide row (${at?.row} px) holds the pair in the ${at?.voice || "nowhere"}: no popup to open`);
      await ctx.close();
    } else {
    await useMic(page, note);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    if (!at.more) fail(`the pair is in the popup with no "more" chip (a row of ${at.row} px)`);
    if (await byTid(page, "voice-dictate").count() || await byTid(page, "voice-speech").count()) fail("the row still draws Dictate or Speech mode with the pair in the popup");
    await shot(page, "2-narrow-row");
    let chipLook = "";
    await press(page, page.locator(MORE));
    if (!await until(() => page.locator(POP).count(), 5000)) fail("the \"more\" chip opened no popup");
    else {
      const rows = await byTid(page.locator(POP), "more-row").evaluateAll((es) => es.map((e) => e.dataset.control));
      if (rows.slice(-2).join() !== "dictate,speech") fail(`the popup's last rows are ${J(rows.slice(-2))}, not dictate and speech: ${J(rows)}`);
      if (!rows.includes("insert")) fail(`the popup has no insert entry (${J(rows)})`);
      else if (rows.indexOf("insert") > rows.indexOf("dictate")) fail(`the insert entry is after the pair's: ${J(rows)}`);
      for (const id of ["more-dictate", "more-speech"]) {
        if (!await byTid(page.locator(POP), id).isVisible()) fail(`${id} is not visible in the popup`);
        if (await byTid(page, id).getAttribute("data-on") !== "false") fail(`${id} says it is on before it was pressed`);
      }
      const labels = await byTid(page.locator(POP), "more-row").evaluateAll((es) => es.slice(-2).map((e) => e.textContent.trim()));
      if (labels.join() !== "Dictate,Speech mode") fail(`the entries say ${J(labels)}`);
      const pop = await rect(page, tidSel("more-pop"));
      if (pop && (pop.r > page.viewportSize().width + 0.5 || pop.l < -0.5)) fail(`the popup is outside the window: ${J(pop)}`);
      await shot(page, "3-popup");
      chipLook = await page.locator(MORE).evaluate((e) => e.innerHTML);

      // both work from the popup: Dictate
      await mockEval(`voice.reset(); voice.script([{ after: 2, partial: "from the" }, { after: 4, committed: "from the popup" }]);`, url);
      await press(page, byTid(page, "more-dictate"));
      if (!await until(async () => (await sess(page)).owner?.kind === "dictation" && (await sess(page)).phase === "listening", 20000)) fail(`Dictate from the popup did not start listening: ${J(await sess(page))}`);
      else {
        if (!await until(async () => (await textOf(page)).includes("from the popup"), 20000)) fail(`the words did not reach the box: ${J(await textOf(page))}`);
        if (!await until(async () => !await page.locator(POP).count(), 5000)) fail("the popup stays open as listening starts");
        if (await page.locator(MORE).evaluate((e) => e.innerHTML) === chipLook) fail("the \"more\" chip does not change while the pair inside is on");
        await shot(page, "4-dictating-from-popup");
        await press(page, page.locator(MORE));
        await until(() => byTid(page, "more-dictate").count());
        if (await byTid(page, "more-dictate").getAttribute("data-on") !== "true") fail("the Dictate entry does not say it is on while dictating");
        if ((await byTid(page, "more-dictate").getAttribute("aria-label")) !== "End dictation") fail(`the Dictate entry is labelled ${J(await byTid(page, "more-dictate").getAttribute("aria-label"))}, not "End dictation"`);
        await press(page, byTid(page, "more-dictate"));
        if (!await until(async () => (await sess(page)).phase === "idle")) fail("a second press of Dictate in the popup did not stop it");
        if (await textOf(page) !== "from the popup") fail(`stopping changed the box: ${J(await textOf(page))}`);
      }
      // and Speech mode (the speech bar is the composer part SpeechBar; here the session is what shows it)
      await mockEval("voice.reset();", url);
      if (!await page.locator(POP).count()) { await press(page, page.locator(MORE)); await until(() => byTid(page, "more-speech").count()); }
      await press(page, byTid(page, "more-speech"));
      if (!await until(async () => (await sess(page)).owner?.kind === "speech" && (await sess(page)).phase === "listening", 20000)) fail(`Speech mode from the popup did not start listening: ${J(await sess(page))}`);
      else {
        if (!await until(async () => !await page.locator(POP).count(), 5000)) fail("the popup stays open as speech mode starts");
        // Speech mode puts the speech bar in the place of the box and the toolbar (goal 3.1; hidden, not unmounted), so the "more" chip is not
        // there to press: the bar shows, the toolbar does not, and End on the bar ends the session and brings the toolbar back as it was.
        if (!await until(() => byTid(page, "speech-bar").isVisible(), 5000)) fail("speech mode started from the popup shows no speech bar");
        if (await page.locator(MORE).isVisible()) fail("the toolbar's \"more\" chip is seen while the speech bar is");
        await shot(page, "4b-speech-from-popup");
        await press(page, byTid(page, "speech-end"));
        if (!await until(async () => (await sess(page)).phase === "idle")) fail("End on the speech bar did not end speech mode started from the popup");
        if (!await until(async () => !await byTid(page, "speech-bar").count() || !await byTid(page, "speech-bar").isVisible(), 5000)) fail("the speech bar stays after End");
        if (!await until(() => page.locator(MORE).isVisible(), 5000)) fail("the toolbar's \"more\" chip does not come back after End");
        else {
          const back = await place(page);
          if (back?.voice !== "more" || !back.more) fail(`after End the pair is in the ${back?.voice || "nowhere"} (the chip: ${back?.more}), not in the popup as before`);
          if (await page.locator(MORE).evaluate((e) => e.innerHTML) !== chipLook) fail("the \"more\" chip is not as it was before speech mode: it still looks on");
          await press(page, page.locator(MORE));
          await until(() => byTid(page, "more-speech").count());
          if (await byTid(page, "more-speech").getAttribute("data-on") !== "false") fail("the Speech mode entry still says it is on after End");
          if ((await byTid(page, "more-speech").getAttribute("aria-label")) !== "Speech mode") fail(`the Speech mode entry is labelled ${J(await byTid(page, "more-speech").getAttribute("aria-label"))} after End`);
          if (await byTid(page, "voice-dictate").count() || await byTid(page, "voice-speech").count()) fail("the row draws Dictate or Speech mode after End, with the pair in the popup");
        }
        const stt = (await log()).filter((e) => e.kind === "stt");
        if (!stt.length || stt.some((e) => e.problems?.length)) fail(`the stand-in's log of the speech session: ${J(stt.map((e) => e.problems))}`);
        if (JSON.stringify(await log()).includes(KEY)) fail("the key is in the stand-in's log");
      }
      // no key: the popover, from the popup
      await page.evaluate(() => window.__aiwbVoice.clearKey());
      await mockEval("voice.reset();", url);
      if (!await page.locator(POP).count()) { await press(page, page.locator(MORE)); await until(() => byTid(page, "more-dictate").count()); }
      await press(page, byTid(page, "more-speech"));
      if (!await until(() => byTid(page, "voice-problem", { kind: "no_key" }).count(), 10000)) fail("Speech mode from the popup with no key shows no popover");
      else {
        await shot(page, "5-nokey-from-popup");
        await press(page, byTid(page, "voice-problem-dismiss"));
        await until(async () => !await byTid(page, "voice-problem").count());
      }
      if ((await sess(page)).phase !== "idle" || (await log()).some((e) => e.kind === "stt")) fail("a press with no key started a session or a socket");
    }
    await ctx.close();
    }
  }


  // ---- the phone: a window under 700 px (on any viewport) draws the phone composer
  {
    const { page, ctx } = await openState(open, await stateOf("plain-new"), layout, 0, { size: [320, HEIGHT] });
    const calls = callsOf(page);
    await page.evaluate(() => { window.__gum = 0; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return g(...a); }; });
    judgePhone(await phoneTools(page), "a window of 320 px", fail);
    // (the phone's controls are touch targets with no tooltip: their words are the accessibility label, ux-improvements goal 3.7.2, 4.7)
    for (const [id, title] of [["composer-dictate", "Dictate"], ["composer-talk", "Talk"]]) {
      if (await byTid(page, id).getAttribute("aria-label") !== title) fail(`${id} is labelled ${J(await byTid(page, id).getAttribute("aria-label"))}, not ${J(title)}`);
      if (await byTid(page, id).getAttribute("data-on") !== "false") fail(`${id} says it is on before anything was pressed`);
    }
    await shot(page, "7-phone");
    // never used: nothing of voice has run
    if (calls.some((c) => /\/voice\//.test(c.path ?? c.url ?? ""))) fail("a phone page that never pressed either control made a request to the voice service");
    if ((await log()).length) fail(`the stand-in saw ${(await log()).length} requests from a page that never used voice`);
    if (await page.evaluate(() => window.__gum) !== 0) fail("getUserMedia was called by a page that never used voice");
    // the narrowest window the phone composer has been given
    await resize(page, 200);
    judgePhone(await phoneTools(page), "a window of 200 px", fail, { inside: false });
    await shot(page, "7b-phone-200");
    await resize(page, 320);

    await useMic(page, note);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    // Talk (the primary while the box is empty): the speech bar takes the place of the box and the toolbar, End brings them back
    await mockEval("voice.reset();", url);
    await press(page, byTid(page, "composer-talk"));
    if (!await until(async () => (await sess(page)).owner?.kind === "speech" && (await sess(page)).phase === "listening", 20000)) fail(`Talk did not start speech mode: ${J(await sess(page))}`);
    else {
      if (!await until(() => byTid(page, "speech-bar").isVisible(), 5000)) fail("Talk shows no speech bar");
      if (await byTid(page, "composer-phone-tools").isVisible()) fail("the phone toolbar is seen while the speech bar is");
      await shot(page, "8-talk");
      await press(page, byTid(page, "speech-end"));
      if (!await until(async () => (await sess(page)).phase === "idle")) fail("End on the speech bar did not end speech mode");
      if (!await until(() => byTid(page, "composer-phone-tools").isVisible(), 5000)) fail("the phone toolbar does not come back after End");
      else {
        judgePhone(await phoneTools(page), "after End", fail);
        if (await byTid(page, "composer-talk").getAttribute("data-on") !== "false") fail("Talk still says it is on after End");
      }
      const stt = (await log()).filter((e) => e.kind === "stt");
      if (!stt.length || stt.some((e) => e.problems?.length)) fail(`the stand-in's log of the speech session: ${J(stt.map((e) => e.problems))}`);
      if (JSON.stringify(await log()).includes(KEY)) fail("the key is in the stand-in's log");
    }
    // Dictate: the words go into the box, a second press stops it and the box keeps them
    await mockEval(`voice.reset(); voice.script([{ after: 2, partial: "from the" }, { after: 4, committed: "from the toolbar" }]);`, url);
    await press(page, byTid(page, "composer-dictate"));
    if (!await until(async () => (await sess(page)).owner?.kind === "dictation" && (await sess(page)).phase === "listening", 20000)) fail(`Dictate did not start listening: ${J(await sess(page))}`);
    else {
      if (!await until(async () => (await boxOf(page)).includes("from the toolbar"), 20000)) fail(`the words did not reach the box: ${J(await boxOf(page))}`);
      if (await byTid(page, "composer-dictate").getAttribute("data-on") !== "true") fail("Dictate does not say it is on while dictating");
      await shot(page, "9-dictating");
      await press(page, byTid(page, "composer-dictate"));
      if (!await until(async () => (await sess(page)).phase === "idle")) fail("a second press of Dictate did not stop it");
      if (await boxOf(page) !== "from the toolbar") fail(`stopping changed the box: ${J(await boxOf(page))}`);
      // with text in the box the primary is Send: Dictate stays, Talk is not drawn
      judgePhone(await phoneTools(page), "with text in the box", fail, { empty: false });
    }
    // no key: the problem, and nothing started
    await page.evaluate(() => window.__aiwbVoice.clearKey());
    await mockEval("voice.reset();", url);
    await press(page, byTid(page, "composer-dictate"));
    if (!await until(() => byTid(page, "voice-problem", { kind: "no_key" }).count(), 10000)) fail("Dictate with no key shows no problem");
    else {
      await shot(page, "10-nokey");
      await press(page, byTid(page, "voice-problem-dismiss"));
      await until(async () => !await byTid(page, "voice-problem").count());
    }
    if ((await sess(page)).phase !== "idle" || (await log()).some((e) => e.kind === "stt")) fail("a press with no key started a session or a socket");
    note("the phone composer (windows of 320 and 200 px): Dictate and Talk in the toolbar, 44 pt, no popup; Talk starts speech mode and End brings the toolbar back; Dictate fills the box and a second press stops it; with text the primary is Send; no key: the problem and no socket");
    await ctx.close();
  }

  // ---- off: a chat shown as it was
  {
    const { page, ctx } = await openState(open, await stateOf("plain-off-started"), layout, 900);
    const where = await place(page);
    const id = where?.voice === "more" ? null : "row";
    if (!where) { // (the phone window: the block takes the box's and the toolbar's place, so neither control is drawn to be pressed)
      if (!await byTid(page, "composer-block").count()) fail("a chat shown as it was has no block in the phone's composer");
      if (await byTid(page, "voice-dictate").count() || await byTid(page, "voice-speech").count() || await byTid(page, "composer-phone-tools").count()) fail("the phone's composer of a chat shown as it was still draws its voice controls");
      await shot(page, "6-off");
    } else if (id) {
      for (const [tidName, title] of [["voice-dictate", "Dictate"], ["voice-speech", "Speech mode"]]) {
        if (!await byTid(page, tidName).isDisabled()) fail(`${tidName} is on with the chat's server not connected`);
        const t = await byTid(page, tidName).getAttribute("title");
        if (!t || t === title) fail(`${tidName} does not say why it is off: its title is ${J(t)}`);
      }
      await shot(page, "6-off");
    } else {
      await press(page, page.locator(MORE));
      await until(() => byTid(page, "more-dictate").count());
      for (const tidName of ["more-dictate", "more-speech"]) if (!await byTid(page, tidName).isDisabled()) fail(`${tidName} is on with the chat's server not connected`);
    }
    await ctx.close();
  }
}, { viewports, page: false });
