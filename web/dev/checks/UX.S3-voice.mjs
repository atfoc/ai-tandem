// UX.S3-voice (package S3, ux-improvements goal 3.8.5, 3.7.3, 4.5; plans/ux-improvements/s3-design.md): Settings > Voice on the phone, on the mock
// with the stand-in voice service (dev/voicestandin.mjs) and the stand-in devices (devices.mjs). Phone only (the wide layouts keep the dialog:
// VC.1 and VC.8). The path is the person's: Home's gear, Settings' Voice row, a key typed or pasted into Add key, rows and sheets pressed. In the light theme, then
// the sizes and the pictures again in the dark.
//   opening      Home's gear pushes Settings, its Voice row pushes `vs-screen` (stack home, settings, voice-settings); the bar's back says "Settings", its title "Voice"; Back lands on
//                Settings
//   no key       the card (`vs-nokey-card`: "Talk to your agents", the one button "Add ElevenLabs key", the link to elevenlabs.io, window.open held and
//                read), the privacy line, the dimmed voice row; no Sending, no Advanced, no Remove; no request to the voice service and no
//                enumerateDevices / getUserMedia from opening the screen
//   Add key      Cancel · ElevenLabs key · Save, Save off until something is typed; the box hidden and monospaced, the eye shows it; Paste fills it from
//                the clipboard; Test key: a bad key gives the red "!" line, the good one "✓ Works: 6 voices found."; Cancel with text asks "Discard
//                changes" (keep editing keeps the sheet); Save leaves the key state with "Saved on this device ✓"
//   with a key   the rows of the mockup 07 in order (key, Voice, Choose voice, Auto-send, Speech model, Transcription, Language, Pause, Playback
//                speed, Microphone, Speaker, Skip code blocks, Remove key last, red); the screen asks the service for nothing and lists no device
//   settings     Auto-send flips `autoSend` and back; Language (a P2 sheet with its search pinned) and Playback speed change their setting and the row
//   Choose voice `cv-screen` ("‹ Voice"), the search visible, the chosen voice first and checked; a tap moves the ✓ and stays; play shows "Playing
//                sample…" with a `preview` in the stand-in's log and no `tts`, stop ends it; search narrows; "N of M voices" and Show all voices; Back
//                names the voice picked on the Voice screen
//   devices      the Microphone sheet lists only when opened (enumerateDevices counted before and after); a pick is the setting `mic`; Done closes
//   remove       the P4 asks first (Cancel keeps the key), then the no-key state; the canary key (`sk_test_S3CANARY…`) is in no storage, text, label,
//                testID or data attribute at any step
//   sizes        on every screen and sheet above: text ≥ 13 px, controls ≥ 44 × 44 with a label of 17 px (but the small link of the card, 15 px)
// OUT=/tmp/x (default web/out/s3-shots) keeps screenshots of: no key, Add key, key saved, a picker, Choose voice (playing), a device sheet and the
// P4, in the light and the dark theme.
import fs from "node:fs";
import { check, mockEval, until } from "../shot.mjs";
import { installDevices } from "./devices.mjs";
import { byTid, press } from "./sel.mjs";
import { atRest } from "./settings.mjs";
import {
  closeSheet, deviceCalls, stackNames, leaks, openAddKey, openChooseVoice, openVoice, pickIn, saveKey, sheetGone, sheetShown, textOf, typeKey, voiceKeyState,
  voiceLog, voiceSettings, voicesLoaded,
} from "./voicephone.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT ?? new URL("../../out/s3-shots/", import.meta.url).pathname;
const KEY = "sk_test_S3CANARY7";
const BAD = "sk_bad_S3CANARY8";
const STORED = "Stored on this device only. Sent only to elevenlabs.io.";
/** Controls whose label is smaller than 17 px by the design (s3-design.md: the card's link is 13 + 2). */
const SMALL_LABEL = new Set(["vs-get-key"]);

await check("UX.S3 Settings > Voice on the phone: the screen, Add key, Choose voice, the device sheets, Remove key", async ({ url, page, context, open, fail, note }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const shoot = async (p, theme, name, rest = "vs-screen") => { await atRest(p, rest, 5000).catch(() => {}); await sleep(150); await p.screenshot({ path: `${OUT}/${theme}-${name}.png` }); };
  const log = () => voiceLog(url);
  const resetLog = () => mockEval("voice.reset();", url);

  /** The bar of the screen on top: its back (text and name) and its words. */
  const barOf = (p) => p.evaluate(() => {
    const bar = [...document.querySelectorAll('[data-testid="place-bar"]')].pop(), back = [...document.querySelectorAll('[data-testid="nav-back"]')].pop();
    return { back: back?.innerText.trim() ?? null, backName: back?.getAttribute("aria-label") ?? null, text: bar?.innerText.replace(/\s+/g, " ").trim() ?? null };
  });

  /** Text ≥ 13 px and controls ≥ 44 × 44 (their label 17 px) inside the last element `root` names. */
  const sizes = async (p, root, what) => {
    const bad = await p.evaluate(([rootCss, small]) => {
      const out = [];
      const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const all = document.querySelectorAll(rootCss), el = all[all.length - 1];
      if (!el) return ["nothing to measure: no element matches"];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const q = n.parentElement;
        if (!n.textContent.trim() || !q || !seen(q)) continue;
        const px = parseFloat(getComputedStyle(q).fontSize);
        if (px < 13) out.push(`text "${n.textContent.trim().slice(0, 30)}" is ${px} px`);
      }
      for (const b of el.querySelectorAll('[role="button"],[role="switch"],[role="radio"],[role="link"],[role^="menuitem"],button,input,textarea')) {
        if (!seen(b) || b.closest('[aria-hidden="true"]')) continue;
        const id = b.getAttribute("data-testid") ?? "", r = b.getBoundingClientRect();
        const name = `${b.getAttribute("role") ?? b.tagName.toLowerCase()} "${(b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30)}" [${id}]`;
        if (r.width < 43.5 || r.height < 43.5) out.push(`${name} is ${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}`);
        if (small.includes(id)) continue;
        let px = null;
        if (/^(INPUT|TEXTAREA)$/.test(b.tagName)) px = parseFloat(getComputedStyle(b).fontSize);
        else {
          const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n && px === null; n = w.nextNode()) if (n.textContent.trim() && n.parentElement) px = parseFloat(getComputedStyle(n.parentElement).fontSize);
        }
        if (px !== null && px < 17) out.push(`${name} has a label of ${px} px, under 17`);
      }
      return out;
    }, [root, [...SMALL_LABEL]]);
    if (bad.length) fail(`sizes, ${what}: ${[...new Set(bad)].slice(0, 6).join("; ")}${bad.length > 6 ? ` … (${bad.length})` : ""}`);
  };
  /** The canary keys are nowhere in the page, at this step. */
  const noLeak = async (p, step) => {
    for (const k of [KEY, BAD]) {
      const l = await leaks(p, k);
      const where = Object.entries(l).filter(([, v]) => v).map(([w]) => w);
      if (where.length) fail(`${step}: the key ${k === KEY ? "(good)" : "(bad)"} is in the page's ${where.join(", ")}`);
    }
  };
  const delayPreview = (p, ms = 3000) => p.route("**/voice/_preview/**", async (route) => { const r = await route.fetch(); await sleep(ms); await route.fulfill({ response: r }).catch(() => {}); });
  const topsOf = (p, ids) => p.evaluate((ids) => ids.map((id) => { const all = document.querySelectorAll(`[data-testid="${id}"]`), e = all[all.length - 1]; return e ? Math.round(e.getBoundingClientRect().top) : null; }), ids);

  // ---- the stand-in devices (listed, permission given: the sheet lists what it finds), the clipboard, a fresh load
  await installDevices(context, { granted: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.reload();
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  await until(async () => (await stackNames(page)).join() === "home", WAIT);
  await resetLog();

  // ---- opening: Home's gear pushes Settings, its Voice row pushes Voice (the phone has no sidebar foot)
  {
    if (await byTid(page, "settings-btn").count() || await byTid(page, "side-pane").count()) fail("the phone draws the sidebar or its foot");
    await press(page, byTid(page, "home-gear").first());
    await atRest(page, "settings-screen");
    if ((await stackNames(page)).join() !== "home,settings") fail(`Home's gear pushed [${(await stackNames(page)).join(", ")}], not [home, settings]`);
    await press(page, byTid(page, "settings-row", { row: "voice" }).last());
    await atRest(page, "vs-screen");
    const keys = await stackNames(page);
    if (keys.join() !== "home,settings,voice-settings") fail(`Settings' Voice row pushed [${keys.join(", ")}], not [home, settings, voice-settings]`);
    const bar = await barOf(page);
    if (bar.back !== "Settings" || bar.backName !== "Back to Settings") fail(`the Voice bar's back says ${J(bar.back)} (${J(bar.backName)}), not "Settings"`);
    if (!/^Settings\s*Voice$/.test(bar.text ?? "")) fail(`the Voice bar says ${J(bar.text)}, not "Settings" and "Voice"`);
    await press(page, byTid(page, "nav-back").last());
    await atRest(page, "settings-screen");
    if ((await stackNames(page)).join() !== "home,settings") fail(`Back from Voice left [${(await stackNames(page)).join(", ")}], not [home, settings]`);
    await openVoice(page); // (the helper's way: from Settings, by its Voice row)
    if ((await stackNames(page)).join() !== "home,settings,voice-settings") fail(`Settings' Voice row pushed [${(await stackNames(page)).join(", ")}]`);
  }

  // ---- no key
  {
    if ((await voiceKeyState(page)) !== "none") fail(`the screen's key state is ${J(await voiceKeyState(page))}, not "none"`);
    const text = await textOf(byTid(page, "vs-screen"));
    for (const s of ["Talk to your agents", "Add ElevenLabs key", "No key yet? Get one at elevenlabs.io ↗", STORED, "Add your key to choose a voice."]) if (!text.includes(s)) fail(`the no-key screen lacks ${J(s)}: ${J(text.slice(0, 300))}`);
    for (const s of ["Sending", "Advanced", "Remove key"]) if (text.includes(s)) fail(`the no-key screen says ${J(s)}`);
    for (const id of ["vs-key-remove", "vs-autosend", "vs-adv-tts", "vs-mic", "vs-choose-voice", "vs-key-row"]) if (await byTid(page, id).count()) fail(`the no-key screen draws ${id}`);
    const buttons = await page.evaluate(() => {
      const all = document.querySelectorAll('[data-testid="vs-screen"]'), el = all[all.length - 1];
      return [...el.querySelectorAll('[role="button"],[role="switch"],[role="link"],button')].map((e) => e.getAttribute("data-testid"));
    });
    if (buttons.join() !== "vs-add-key,vs-get-key") fail(`the no-key screen has the controls [${buttons.join(", ")}], not the one action and the link`);
    const nokey = byTid(page, "vs-voice-nokey").last();
    if ((await nokey.getAttribute("aria-disabled")) !== "true" || Number(await nokey.evaluate((e) => getComputedStyle(e).opacity)) >= 1) fail("the voice row is not dimmed");
    await sizes(page, '[data-testid="vs-screen"]', "no key (light)");
    await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
    await press(page, byTid(page, "vs-get-key").last());
    if (!(await until(() => page.evaluate(() => window.__opened.length > 0), 5000))) fail("a press on the link opened nothing");
    else {
      const [href, target, features] = await page.evaluate(() => window.__opened[0]);
      if (href !== "https://elevenlabs.io/app/settings/api-keys" || target !== "_blank" || !/noopener/.test(features ?? "")) fail(`the link opens ${J([href, target, features])}`);
    }
    if ((await voiceKeyState(page)) !== "none") fail("the link left the no-key screen");
    await sleep(800);
    if ((await log()).length) fail(`opening the Voice screen made requests of the voice service: ${J(await log())}`);
    const calls = await deviceCalls(page);
    if (calls.enumerateDevices !== 0 || calls.getUserMedia !== 0) fail(`opening the Voice screen made device calls: ${J(calls)}`);
    await shoot(page, "light", "1-nokey");
  }

  // ---- Add key
  {
    await openAddKey(page);
    const sheet = byTid(page, "vs-key-sheet").last();
    const head = await page.evaluate(() => {
      const all = document.querySelectorAll('[data-testid="vs-key-sheet"]'), s = all[all.length - 1];
      const l = s.querySelector('[data-testid="sheet-left"]'), r = s.querySelector('[data-testid="sheet-right"]'), t = s.querySelector('[data-testid="sheet-title"]');
      return { left: l?.innerText.trim(), title: t?.innerText.trim(), right: r?.innerText.trim(), saveOff: r?.getAttribute("aria-disabled") === "true" };
    });
    if (head.left !== "Cancel" || head.title !== "ElevenLabs key" || head.right !== "Save") fail(`the Add key head reads ${J(head)}, not Cancel · ElevenLabs key · Save`);
    if (!head.saveOff) fail("Save is on with nothing typed");
    const box = byTid(page, "vs-key").last();
    if ((await box.getAttribute("type")) !== "password") fail("the key box is not hidden");
    const family = await box.evaluate((e) => getComputedStyle(e).fontFamily);
    if (!/mono|menlo|courier|consolas/i.test(family)) fail(`the key box's font is "${family}", not a monospace one`);
    const eye = byTid(page, "vs-key-eye").last();
    if ((await eye.getAttribute("aria-label")) !== "Show key") fail(`the eye is labelled ${J(await eye.getAttribute("aria-label"))}, not "Show key"`);

    // typed: Save is on, the eye shows it
    await typeKey(page, BAD);
    if ((await byTid(page, "sheet-right").last().getAttribute("aria-disabled")) === "true") fail("Save stays off with a key typed");
    await press(page, eye);
    if ((await box.getAttribute("type")) === "password" || (await box.inputValue()) !== BAD) fail("the eye does not show what is typed");
    if ((await eye.getAttribute("aria-label")) !== "Hide key" || (await eye.getAttribute("aria-pressed")) !== "true") fail(`the shown eye is ${J([await eye.getAttribute("aria-label"), await eye.getAttribute("aria-pressed")])}`);
    await press(page, eye);
    if ((await box.getAttribute("type")) !== "password") fail("the eye does not hide the key again");
    await noLeak(page, "a key typed in Add key");

    // Test key: a bad key, then the good one
    const result = byTid(page, "vs-key-result");
    if (await result.count()) fail("a result line shows before a test");
    await press(page, byTid(page, "vs-key-test").last());
    await until(async () => /!/.test(await textOf(result)), WAIT);
    if ((await textOf(result)) !== "! ElevenLabs did not accept this key." || (await result.last().getAttribute("data-tone")) !== "danger") fail(`a bad key says ${J(await textOf(result))} (${await result.last().getAttribute("data-tone")}), not the red "!" line`);
    {
      const [r, g] = (await result.last().evaluate((e) => getComputedStyle(e).color)).match(/\d+/g).map(Number);
      if (!(r > g + 60)) fail("the bad key's line is not red");
    }
    await typeKey(page, KEY);
    if (await result.count()) fail("the result of the last test stays when the key changes");
    await press(page, byTid(page, "vs-key-test").last());
    await until(async () => /Works/.test(await textOf(result)), WAIT);
    if ((await textOf(result)) !== "✓ Works: 6 voices found." || (await result.last().getAttribute("data-tone")) !== "ok") fail(`the good key says ${J(await textOf(result))} (${await result.last().getAttribute("data-tone")})`);
    {
      const [r, g] = (await result.last().evaluate((e) => getComputedStyle(e).color)).match(/\d+/g).map(Number);
      if (!(g > r + 20)) fail("the good key's line is not green");
    }
    if ((await sheet.innerText()).includes(KEY)) fail("the sheet's text shows the key");
    if ((await voiceKeyState(page)) !== "none") fail("Test key saved the key");
    await sizes(page, '[data-testid="vs-key-sheet"]', "Add key (light)");
    await shoot(page, "light", "2-addkey");
    await noLeak(page, "a key tested in Add key");

    // Cancel with text asks first; keeping the edit keeps the sheet
    await press(page, byTid(page, "sheet-left").last());
    await byTid(page, "confirm-sheet").last().waitFor({ state: "visible", timeout: WAIT });
    const ask = await textOf(byTid(page, "confirm-sheet"));
    if (!/Discard changes/.test(ask)) fail(`Cancel with text asks ${J(ask)}, not "Discard changes"`);
    await press(page, byTid(page, "confirm-cancel").last());
    await sheetGone(page, "confirm-sheet");
    if (!(await byTid(page, "vs-key-sheet").count()) || (await byTid(page, "vs-key").last().inputValue()) !== KEY) fail("keeping the edit lost the sheet or what was typed");
    await press(page, byTid(page, "sheet-left").last());
    await byTid(page, "confirm-sheet").last().waitFor({ state: "visible", timeout: WAIT });
    await press(page, byTid(page, "confirm-go").last());
    await sheetGone(page, "vs-key-sheet");
    if ((await voiceKeyState(page)) !== "none") fail("discarding the key saved it");
    await noLeak(page, "Add key discarded");

    // Paste: the clipboard's text fills the box; Save keeps it
    await openAddKey(page);
    if ((await byTid(page, "vs-key").last().inputValue()) !== "") fail("Add key opens with the last key in its box");
    await page.bringToFront();
    await page.evaluate((k) => navigator.clipboard.writeText(k), KEY);
    await press(page, byTid(page, "vs-key-paste").last());
    if (!(await until(async () => (await byTid(page, "vs-key").last().inputValue()) === KEY, 5000))) fail(`Paste filled the box with ${J(await byTid(page, "vs-key").last().inputValue())}, not the clipboard's text`);
    await press(page, byTid(page, "sheet-right").last());
    await sheetGone(page, "vs-key-sheet");
    await until(async () => (await voiceKeyState(page)) === "saved", WAIT);
    await atRest(page, "vs-screen");
    await noLeak(page, "the key saved");
  }

  // ---- with a key: the rows of the mockup, and no request
  {
    const ids = ["vs-key-row", "vs-chosen-voice", "vs-choose-voice", "vs-autosend", "vs-adv-tts", "vs-adv-stt", "vs-adv-language", "vs-adv-pause", "vs-adv-speed", "vs-mic", "vs-speaker", "vs-adv-skipcode", "vs-key-remove"];
    const tops = await topsOf(page, ids);
    ids.forEach((id, i) => { if (tops[i] === null) fail(`the Voice screen draws no ${id}`); else if (i && tops[i - 1] !== null && tops[i] <= tops[i - 1]) fail(`${id} is not below ${ids[i - 1]} (tops ${tops[i]} and ${tops[i - 1]})`); });
    const text = await textOf(byTid(page, "vs-screen"));
    for (const s of ["ElevenLabs API key", "Saved on this device ✓", STORED, "Your account's first voice", "Choose voice", "Auto-send after speaking", "Sends your turn after a pause", "Speech model", "Transcription", "Language", "Pause before auto-send", "Playback speed", "Microphone", "Speaker", "Skip code blocks", "Remove key from this device"]) if (!text.includes(s)) fail(`the Voice screen lacks ${J(s)}`);
    for (const s of ["Sending", "Advanced"]) if (!text.includes(s)) fail(`the Voice screen has no group ${J(s)}`);
    if (await byTid(page, "vs-nokey-card").count()) fail("the no-key card stays with a key saved");
    const sub = byTid(page, "vs-key-row").last();
    {
      const colour = await sub.evaluate((e) => { const d = [...e.querySelectorAll("div")].find((x) => x.children.length === 0 && x.textContent.includes("Saved on this device")); return d ? getComputedStyle(d).color : null; });
      const [r, g] = (colour?.match(/\d+/g) ?? []).map(Number);
      if (!(g > r + 20)) fail(`the key row's "Saved on this device ✓" is ${colour}, not green`);
    }
    const remove = byTid(page, "vs-key-remove").last();
    const [r, g, b] = (await remove.evaluate((e) => { const d = [...e.querySelectorAll("div")].find((x) => x.textContent.includes("Remove key")); return getComputedStyle(d).color; })).match(/\d+/g).map(Number);
    if (!(r > g + 60 && r > b + 60)) fail(`Remove key is rgb(${r}, ${g}, ${b}), not red`);
    await resetLog();
    await sleep(1000);
    if ((await log()).length) fail(`the Voice screen with a key made requests of the voice service: ${J(await log())}`);
    const calls = await deviceCalls(page);
    if (calls.enumerateDevices !== 0 || calls.getUserMedia !== 0) fail(`the Voice screen with a key listed devices or opened the microphone: ${J(calls)}`);
    await sizes(page, '[data-testid="vs-screen"]', "the Voice screen with a key (light)");
    await shoot(page, "light", "3-saved");
  }

  // ---- Auto-send, Language, Playback speed
  {
    const switchOf = (id) => page.locator('[role="switch"]').filter({ has: byTid(page, id) }).last();
    const sw = switchOf("vs-autosend");
    if ((await sw.getAttribute("aria-label")) !== "Auto-send after speaking") fail(`the switch is labelled ${J(await sw.getAttribute("aria-label"))}`);
    // (the cell around it holds it: not disabled, so a screen reader and a tap reach the switch itself)
    if (await sw.evaluate((e) => !!e.closest('[aria-disabled="true"]'))) fail("the Auto-send switch is inside an aria-disabled element");
    const was = (await voiceSettings(page)).autoSend;
    await press(page, sw);
    await until(async () => (await voiceSettings(page)).autoSend === !was);
    if ((await voiceSettings(page)).autoSend !== !was || (await byTid(page, "vs-autosend").last().getAttribute("data-on")) !== String(!was) || (await sw.getAttribute("aria-checked")) !== String(!was)) fail("Auto-send does not flip the setting and the switch");
    await press(page, sw);
    await until(async () => (await voiceSettings(page)).autoSend === was);
    if ((await voiceSettings(page)).autoSend !== was || (await sw.getAttribute("aria-checked")) !== String(was)) fail("Auto-send does not flip back");

    // Language: the search is pinned (a long list); the pick is the setting and the row
    await pickIn(page, "vs-adv-language", "vs-picker", {
      search: "croat", label: "Croatian",
      before: async (sheet) => {
        if (!(await sheet.locator('[data-testid="search-field"]').first().isVisible())) fail("the Language sheet has no search");
        await sizes(page, '[data-testid="vs-picker"]', "the Language sheet (light)");
        await shoot(page, "light", "4-picker");
        await noLeak(page, "the Language sheet");
      },
    });
    await until(async () => (await voiceSettings(page)).language === "hr");
    {
      const row = byTid(page, "vs-adv-language").last();
      if ((await textOf(row.locator('[data-testid="cell-value"]'))) !== "Croatian" || (await row.getAttribute("data-value")) !== "hr") fail(`the Language row says ${J(await textOf(row))} after Croatian`);
    }
    await pickIn(page, "vs-adv-speed", "vs-picker", { value: "1.5" });
    await until(async () => (await voiceSettings(page)).speed === 1.5);
    if ((await textOf(byTid(page, "vs-adv-speed").last().locator('[data-testid="cell-value"]'))) !== "1.5×") fail("the Playback speed row does not say 1.5×");
    await pickIn(page, "vs-adv-language", "vs-picker", { value: "auto" });
    await until(async () => (await voiceSettings(page)).language === null);
    if ((await textOf(byTid(page, "vs-adv-language").last().locator('[data-testid="cell-value"]'))) !== "Auto-detect") fail("the Language row does not say Auto-detect after Auto-detect");
    await pickIn(page, "vs-adv-speed", "vs-picker", { value: "1" });
    await until(async () => (await voiceSettings(page)).speed === 1);
  }

  // ---- Choose voice
  {
    await openChooseVoice(page);
    await voicesLoaded(page);
    const bar = await barOf(page);
    if (bar.back !== "Voice" || !/^Voice\s*Choose voice$/.test(bar.text ?? "")) fail(`the Choose voice bar says ${J(bar)}, not "Voice" and "Choose voice"`);
    if (!(await byTid(page, "cv-search").last().isVisible())) fail("Choose voice has no search");
    const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="cv-row"]')].map((e) => ({ id: e.dataset.voice, selected: e.dataset.selected, text: e.innerText.replace(/\s+/g, " ").trim() })));
    let list = await rows();
    if (list.length !== 4 || list[0].id !== "vsAlice" || list[0].selected !== "true") fail(`with none chosen the list is ${J(list.map((r) => [r.id, r.selected]))}: the first voice should come first and be marked`);
    if ((await textOf(byTid(page, "cv-count"))) !== "4 of 6 voices") fail(`the count says ${J(await textOf(byTid(page, "cv-count")))}, not "4 of 6 voices"`);
    // a tap chooses and stays
    const carol = byTid(page, "cv-row", { voice: "vsCarol" }).last().locator('[role="radio"]');
    await press(page, carol);
    await until(async () => (await voiceSettings(page)).voiceId === "vsCarol");
    list = await rows();
    const s = await voiceSettings(page);
    if (s.voiceName !== "Carol") fail(`a pick is kept as ${J([s.voiceId, s.voiceName])}`);
    if (list[0].id !== "vsAlice" || list.filter((r) => r.selected === "true").map((r) => r.id).join() !== "vsCarol") fail(`after a tap on Carol the rows are ${J(list.map((r) => [r.id, r.selected]))}: the ✓ should move and the order stay`);
    if (!(await byTid(page, "cv-screen").count())) fail("a tap on a voice left Choose voice");
    // the chosen voice first and checked on the next visit
    await press(page, byTid(page, "nav-back").last());
    await atRest(page, "vs-screen");
    {
      const chosen = byTid(page, "vs-chosen-voice").last();
      if ((await chosen.getAttribute("data-voice")) !== "vsCarol" || !(await textOf(chosen)).includes("Carol")) fail(`the chosen voice row says ${J(await textOf(chosen))}, not Carol`);
      if (!(await byTid(page, "vs-voice-play").count())) fail("the chosen voice has no play button");
    }
    await openChooseVoice(page);
    await voicesLoaded(page);
    list = await rows();
    if (list[0].id !== "vsCarol" || list[0].selected !== "true" || list.filter((r) => r.selected === "true").length !== 1) fail(`the chosen voice is not first and checked: ${J(list.map((r) => [r.id, r.selected]))}`);

    // play: a sample, no credits; stop
    await resetLog();
    await delayPreview(page);
    const bob = byTid(page, "cv-play", { voice: "vsBob" }).last();
    await press(page, bob);
    if (!(await until(async () => (await bob.getAttribute("data-playing")) === "true", 5000))) fail("play did not start the sample");
    if (!(await textOf(byTid(page, "cv-row", { voice: "vsBob" }))).includes("Playing sample…")) fail(`the playing row says ${J(await textOf(byTid(page, "cv-row", { voice: "vsBob" })))}, not "Playing sample…"`);
    if ((await bob.getAttribute("aria-label")) !== "Pause sample") fail(`the playing button is labelled ${J(await bob.getAttribute("aria-label"))}, not "Pause sample"`);
    if (!(await until(async () => (await log()).some((e) => e.kind === "preview"), WAIT))) fail("play asked the service for no preview clip");
    if ((await log()).some((e) => e.kind === "tts")) fail("a sample was made with a TTS request (it would cost credits)");
    await sizes(page, '[data-testid="cv-screen"]', "Choose voice, playing (light)");
    await shoot(page, "light", "5-choose", "cv-screen");
    await press(page, bob);
    if (!(await until(async () => (await bob.getAttribute("data-playing")) === "false", 5000))) fail("stop did not end the sample");
    if ((await textOf(byTid(page, "cv-row", { voice: "vsBob" }))).includes("Playing sample…")) fail("the row says it plays after stop");
    await page.unroute("**/voice/_preview/**");

    // count, Show all, search
    if (!(await byTid(page, "cv-all").count())) fail("no Show all voices on the short list");
    await press(page, byTid(page, "cv-all").last());
    await until(async () => (await rows()).length === 6, WAIT);
    if ((await textOf(byTid(page, "cv-count"))) !== "6 of 6 voices" || (await byTid(page, "cv-all").count())) fail(`Show all: the count is ${J(await textOf(byTid(page, "cv-count")))}, "Show all voices" ${(await byTid(page, "cv-all").count()) ? "stays" : "gone"}`);
    await byTid(page, "cv-search").last().fill("fran");
    await until(async () => (await rows()).length === 1, WAIT);
    if ((await rows())[0]?.id !== "vsFrank") fail("the search does not narrow the list to Frank");
    await press(page, byTid(page, "cv-row", { voice: "vsFrank" }).last().locator('[role="radio"]'));
    await until(async () => (await voiceSettings(page)).voiceId === "vsFrank");
    await byTid(page, "cv-search").last().fill("");
    await until(async () => (await rows()).length === 6, WAIT);
    await noLeak(page, "Choose voice");
    await press(page, byTid(page, "nav-back").last());
    await atRest(page, "vs-screen");
    {
      const chosen = byTid(page, "vs-chosen-voice").last();
      if ((await chosen.getAttribute("data-voice")) !== "vsFrank" || !(await textOf(chosen)).includes("Frank")) fail(`after Back the chosen voice row says ${J(await textOf(chosen))}, not Frank`);
    }
    if ((await stackNames(page)).join() !== "home,settings,voice-settings") fail(`Back from Choose voice left [${(await stackNames(page)).join(", ")}]`);
  }

  // ---- a device sheet: it lists only when it is open
  {
    // (a sample played in Choose voice opens the audio output, which lists the devices once, as Read aloud does: that is the person using audio, and
    // the count is taken from here; opening Choose voice and the Voice screen listed nothing, read above)
    const before = await deviceCalls(page);
    if (before.getUserMedia !== 0) fail(`the microphone was opened before a sheet was opened: ${J(before)}`);
    await sleep(500);
    if (J(await deviceCalls(page)) !== J(before)) fail(`devices were listed with no sheet open: ${J(before)} then ${J(await deviceCalls(page))}`);
    await press(page, byTid(page, "vs-mic").last());
    await sheetShown(page, "vs-device-sheet-mic");
    if (!(await until(async () => (await deviceCalls(page)).enumerateDevices > before.enumerateDevices, WAIT))) fail("the Microphone sheet listed no device");
    const rowsNow = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="vs-device-sheet-mic"] [data-testid="picker-row"]')].map((e) => e.innerText.replace(/\s+/g, " ").trim().replace(/\s*✓$/, "")));
    await until(async () => (await rowsNow()).length >= 3, WAIT);
    const items = await rowsNow();
    if (!/^System default/.test(items[0] ?? "") || !items.includes("Desk Mic") || !items.includes("Stand-in Headset")) fail(`the Microphone sheet lists ${J(items)}`);
    if ((await deviceCalls(page)).getUserMedia !== 0) fail("opening the Microphone sheet opened the microphone");
    if (!(await byTid(page, "vs-mic-test").count())) fail("the Microphone sheet has no Test microphone");
    await sizes(page, '[data-testid="vs-device-sheet-mic"]', "the Microphone sheet (light)");
    await shoot(page, "light", "6-device");
    await press(page, byTid(page, "vs-device-sheet-mic").last().locator('[data-testid="picker-row"]').filter({ hasText: "Stand-in Headset" }).first());
    await until(async () => (await voiceSettings(page)).mic?.id === "mic-headset");
    if ((await voiceSettings(page)).mic?.name !== "Stand-in Headset") fail(`the pick is kept as ${J((await voiceSettings(page)).mic)}`);
    if (!(await byTid(page, "vs-device-sheet-mic").count())) fail("a pick closed the device sheet (it has Done)");
    await closeSheet(page, "vs-device-sheet-mic");
    if (!(await textOf(byTid(page, "vs-mic").last())).includes("Stand-in Headset")) fail(`the Microphone row says ${J(await textOf(byTid(page, "vs-mic").last()))} after the pick`);
    if ((await deviceCalls(page)).getUserMedia !== 0) fail("a pick and Done opened the microphone");
    await pickIn(page, "vs-mic", "vs-device-sheet-mic", { label: "System default" });
    await closeSheet(page, "vs-device-sheet-mic");
    await until(async () => (await voiceSettings(page)).mic === null);
  }

  // ---- Remove key: the P4, then the no-key state
  {
    await press(page, byTid(page, "vs-key-remove").last());
    await sheetShown(page, "vs-remove-confirm");
    const ask = await textOf(byTid(page, "vs-remove-confirm"));
    if (!ask.includes("Remove the key from this device?") || !ask.includes("Voice stops working until you add a key again.")) fail(`the Remove key question says ${J(ask)}`);
    if ((await textOf(byTid(page, "confirm-go"))) !== "Remove key") fail(`the confirming button says ${J(await textOf(byTid(page, "confirm-go")))}, not "Remove key"`);
    await sizes(page, '[data-testid="vs-remove-confirm"]', "the Remove key question (light)");
    await shoot(page, "light", "7-remove");
    await press(page, byTid(page, "confirm-cancel").last());
    await sheetGone(page, "vs-remove-confirm");
    if ((await voiceKeyState(page)) !== "saved") fail("Cancel removed the key");
    await press(page, byTid(page, "vs-key-remove").last());
    await sheetShown(page, "vs-remove-confirm");
    await press(page, byTid(page, "confirm-go").last());
    await sheetGone(page, "vs-remove-confirm");
    await until(async () => (await voiceKeyState(page)) === "none", WAIT);
    if (!(await byTid(page, "vs-nokey-card").last().isVisible())) fail("the no-key card is not back after Remove key");
    if (await byTid(page, "vs-key-remove").count()) fail("Remove key is still offered");
    await noLeak(page, "the key removed");
    if (J(await log()).includes("S3CANARY")) fail("a key reached the stand-in's log somewhere other than its header");
  }
  await context.close();

  // ---- the dark theme: the sizes and the pictures again, the same states
  {
    const dark = await open({ ls: { "aiwb.theme": "dark" } });
    const p = dark.page;
    await installDevices(dark.ctx, { granted: true }).catch(() => {});
    await dark.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    await p.reload();
    await byTid(p, "home").first().waitFor({ state: "visible", timeout: WAIT });
    if ((await p.evaluate(() => document.documentElement.dataset.theme)) !== "dark") fail("the dark pass is not in the dark theme");
    await openVoice(p);
    await sizes(p, '[data-testid="vs-screen"]', "no key (dark)");
    await shoot(p, "dark", "1-nokey");
    await openAddKey(p);
    await typeKey(p, KEY);
    await sizes(p, '[data-testid="vs-key-sheet"]', "Add key (dark)");
    await shoot(p, "dark", "2-addkey");
    await saveKey(p, KEY);
    await sizes(p, '[data-testid="vs-screen"]', "the Voice screen with a key (dark)");
    await shoot(p, "dark", "3-saved");
    await pickIn(p, "vs-adv-language", "vs-picker", {
      search: "croat", label: "Croatian",
      before: async () => { await sizes(p, '[data-testid="vs-picker"]', "the Language sheet (dark)"); await shoot(p, "dark", "4-picker"); },
    });
    await openChooseVoice(p);
    await voicesLoaded(p);
    await delayPreview(p);
    const play = byTid(p, "cv-play", { voice: "vsBob" }).last();
    await press(p, play);
    if (!(await until(async () => (await play.getAttribute("data-playing")) === "true", 5000))) fail("dark: play did not start the sample");
    await sizes(p, '[data-testid="cv-screen"]', "Choose voice, playing (dark)");
    await shoot(p, "dark", "5-choose", "cv-screen");
    await press(p, play);
    await until(async () => (await play.getAttribute("data-playing")) === "false", 5000);
    await p.unroute("**/voice/_preview/**");
    await press(p, byTid(p, "nav-back").last());
    await atRest(p, "vs-screen");
    await press(p, byTid(p, "vs-mic").last());
    await sheetShown(p, "vs-device-sheet-mic");
    await until(async () => (await p.locator('[data-testid="vs-device-sheet-mic"] [data-testid="picker-row"]').count()) >= 3, WAIT);
    await sizes(p, '[data-testid="vs-device-sheet-mic"]', "the Microphone sheet (dark)");
    await shoot(p, "dark", "6-device");
    await closeSheet(p, "vs-device-sheet-mic");
    await press(p, byTid(p, "vs-key-remove").last());
    await sheetShown(p, "vs-remove-confirm");
    await sizes(p, '[data-testid="vs-remove-confirm"]', "the Remove key question (dark)");
    await shoot(p, "dark", "7-remove");
    await press(p, byTid(p, "confirm-go").last());
    await until(async () => (await voiceKeyState(p)) === "none", WAIT);
    await noLeak(p, "the dark pass");
  }
  note(`the gear and Settings' row, the no-key card, Add key (Save, eye, Paste, Test key, Discard changes), the rows of 07, Auto-send, Language and Playback speed, Choose voice (pick, play, stop, count, Show all, search), the Microphone sheet, Remove key; sizes and shots in light and dark: ${OUT}`);
}, { viewports });
