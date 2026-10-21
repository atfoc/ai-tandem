// VC.1 (new, voice-chats P12): Settings > Voice, on the mock with the stand-in voice service mounted at /voice (dev/voicestandin.mjs), at the
// desktop, the tablet and the phone: a centred dialog on the first two, a bottom sheet on the phone. Goal 3.7, 4.2, 4.9, 4.10, 6.3; architecture
// VC-13 and VC-30. The key lives in the web build's memory (VC-2), so a reload drops it.
//   the foot         the gear button (`settings-btn`, "Settings") is between the library's button and the theme picker, and opens the page
//   the page         the sections in the goal's order (key, voice, how a spoken turn is sent, Advanced options), Advanced options collapsed, the page
//                    rounded; no key: the voice list asks for one, nothing can be removed, and Test key says the key is missing
//   the key          typed in a hidden box, Show shows it; Test key with a rejected key says the 401 sentence, with a working one the number of
//                    voices; Save keeps it (the box empties, its placeholder says a key is saved) and the list of voices comes; the stand-in saw the key
//                    only as the header (`keyHeader`), the page holds it in no storage and in no line of text
//   the voices       the first four, a few words each, the first marked (the service's first speaks when none is chosen), a pick is kept as the voice
//                    setting; Show all voices lists them all with a search and the way back; the play button plays the voice's own preview clip
//                    (the stand-in logs a `preview` and no `tts`: no credits), and a preview that cannot be fetched hangs the problem popover from its
//                    button, with "Try again" and "Not now"
//   the settings     Auto-send / Tap to send and every Advanced option are the voice settings (`__aiwbVoice.settings()`), kept over a reload
//   remove           "Remove key from this device" asks first, then the key is gone: the box, the list and the button say so; a reload drops the key too
//   readable         the page's text and icons keep the contrast floor in the light theme and a dark flavour
// OUT=/tmp/x keeps a screenshot of the page in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, check, contrastAudit, mockEval, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_P12CANARY7";
const BAD = "sk_bad_P12CANARY8";
const FLOOR = 3;

await check("VC.1 Settings > Voice: the foot's button, the key, the voices, the settings, Remove", async ({ url, viewport, layout, page, context, open, fail, note }) => {
  const wide = layout !== "phone";
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const shot = async (p, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRest(p, 6).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.1-${viewport}-${name}.png`) }); } };
  const log = () => mockEval("return voice.log();", url);
  const dialog = (p) => byTid(p, "settings-dialog");
  const shown = (loc) => until(() => loc.first().isVisible().catch(() => false));
  const gone = (loc) => until(async () => (await loc.count()) === 0);
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const settings = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const btn = (root, name) => root.getByRole("button", { name, exact: true });
  const openPage = async (p) => {
    await press(p, byTid(p, "settings-btn").first());
    if (!await shown(dialog(p))) throw new Error("the Settings button opened no dialog");
  };
  const close = async (p) => { await press(p, byTid(p, "vs-close")); if (!await gone(dialog(p))) fail("Close left the page open"); };
  const resultOf = (p) => textOf(byTid(p, "vs-key-result"));
  const waitResult = async (p, re) => { await until(async () => re.test(await resultOf(p))); return resultOf(p); };
  const typeKey = async (p, v) => { const box = byTid(p, "vs-key"); await box.fill(v); };
  const pick = async (p, picker, label) => {
    await press(p, byTid(p, picker));
    const item = byTid(p, "menu-item").filter({ hasText: label }).first();
    if (!await shown(item)) { fail(`${picker}: no menu item "${label}"`); return; }
    await press(p, item);
    await gone(byTid(p, "menu"));
  };

  // ---- the foot
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="side-foot"] [data-testid]')].map((e) => e.dataset.testid).filter((id) => ["servers-btn", "library-btn", "settings-btn", "theme-btn"].includes(id)));
  if (order.join() !== "servers-btn,library-btn,settings-btn,theme-btn") fail(`the foot's buttons are ${order.join()}, not Servers, library, Settings, theme`);
  if (await page.evaluate(() => document.querySelector('[data-testid="settings-btn"]')?.getAttribute("title")) !== "Settings") fail("the Settings button is not titled \"Settings\"");
  if (await byTid(page, "settings-dialog").count()) fail("the Settings page is open before the button is pressed");

  // ---- the page, with no key
  await openPage(page);
  const order2 = await page.evaluate(() => ["vs-key-section", "vs-voices-section", "vs-autosend-section", "vs-advanced-section"].map((id) => { const e = document.querySelector(`[data-testid="${id}"]`); return e ? Math.round(e.getBoundingClientRect().top) : null; }));
  if (order2.some((y) => y === null) || order2.some((y, i) => i && y <= order2[i - 1])) fail(`the sections are not in the goal's order, top to bottom (their tops: ${order2.join()})`);
  if (await byTid(page, "vs-advanced-body").count()) fail("Advanced options are open before they are opened");
  if (await byTid(page, "vs-advanced").getAttribute("aria-expanded") !== "false") fail("Advanced options do not say they are collapsed");
  const surface = await dialog(page).evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
  const card = await byTid(page, "vs-key-section").evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
  if (!(surface >= 10 && card >= 8)) fail(`the page is not rounded: the surface ${surface}px, a section ${card}px`);
  if ((await textOf(byTid(page, "vs-voices-nokey"))) !== "Add your key to choose a voice.") fail(`with no key the voices say "${await textOf(byTid(page, "vs-voices-nokey"))}"`);
  if (await byTid(page, "vs-key-remove").count()) fail("Remove key is offered with no key");
  if (await byTid(page, "vs-key").getAttribute("placeholder") === "A key is saved on this device") fail("the box says a key is saved when none is");
  if (await byTid(page, "vs-key").getAttribute("type") !== "password") fail("the key box is not hidden");
  await press(page, byTid(page, "vs-key-test"));
  const none = await waitResult(page, /key/);
  if (none !== "Voice needs your ElevenLabs key. It stays on this device.") fail(`Test key with no key says "${none}"`);
  if (!(await textOf(byTid(page, "vs-key-section"))).includes("Stored on this device only. Sent only to elevenlabs.io.")) fail("the key's section lacks the line on where the key goes");
  await shot(page, "1-nokey");

  // ---- the key
  await typeKey(page, BAD);
  await press(page, byTid(page, "vs-key-show"));
  if (await byTid(page, "vs-key").getAttribute("type") === "password" || await byTid(page, "vs-key").inputValue() !== BAD) fail("Show does not show what is typed");
  await press(page, byTid(page, "vs-key-show"));
  if (await byTid(page, "vs-key").getAttribute("type") !== "password") fail("Hide does not hide the key again");
  await press(page, byTid(page, "vs-key-test"));
  const rejected = await waitResult(page, /accept/);
  if (rejected !== "ElevenLabs did not accept this key.") fail(`a rejected key says "${rejected}"`);
  await typeKey(page, KEY);
  if (await resultOf(page)) fail("the result of the last test stays when the key changes");
  await press(page, byTid(page, "vs-key-test"));
  const works = await waitResult(page, /Works/);
  if (works !== "Works: 6 voices found.") fail(`a working key says "${works}"`);
  if (await byTid(page, "vs-key-result").getAttribute("data-tone") !== "ok") fail("the result of a working key is not drawn as ok");
  if (await byTid(page, "vs-voices-nokey").count() === 0) fail("the voices list came before the key was saved");
  await shot(page, "2-tested");
  await press(page, byTid(page, "vs-key-save"));
  await waitResult(page, /saved/);
  if (await byTid(page, "vs-key").inputValue() !== "") fail("the box keeps the key after Save");
  if (await byTid(page, "vs-key").getAttribute("placeholder") !== "A key is saved on this device") fail("the box does not say that a key is saved");
  if (!await shown(byTid(page, "vs-key-remove"))) fail("Remove key is not offered with a key saved");
  const secret = await page.evaluate((k) => ({
    text: document.body.innerText.includes(k) || [...document.querySelectorAll("input, textarea")].some((e) => e.value.includes(k) || e.getAttribute("placeholder")?.includes(k)),
    html: document.documentElement.outerHTML.includes(k),
    storage: [localStorage, sessionStorage].some((s) => Object.keys(s).some((n) => n.includes(k) || (s.getItem(n) ?? "").includes(k))),
  }), KEY);
  if (secret.text || secret.html) fail("the key is in the page after Save");
  if (secret.storage) fail("the key is in the browser's storage");

  // ---- the voices
  if (!await shown(byTid(page, "vs-voice-row"))) fail("no voices came after Save");
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="vs-voice-row"]')].map((r) => ({ id: r.dataset.voice, selected: r.dataset.selected, text: r.innerText.replace(/\s+/g, " ").trim(), play: !!r.querySelector('[data-testid="vs-voice-play"]'), radio: r.querySelector('[data-testid="vs-voice"]')?.getAttribute("aria-checked") })));
  if (rows.map((r) => r.id).join() !== "vsAlice,vsBob,vsCarol,vsDave") fail(`the short list is ${rows.map((r) => r.id).join()}, not the first four by name`);
  if (rows[0] && !/Alice.*Warm and clear/.test(rows[0].text)) fail(`a voice's row does not carry its name and a few words: "${rows[0]?.text}"`);
  if (rows.some((r) => !r.play)) fail("a voice has no play button");
  if (rows.filter((r) => r.radio === "true").map((r) => r.id).join() !== "vsAlice") fail("with none chosen the first voice is not the one marked");
  if ((await settings(page)).voiceId !== null) fail("the first voice was stored as the choice before anyone chose");
  await press(page, byTid(page, "vs-voice", { voice: "vsCarol" }));
  await until(async () => (await settings(page)).voiceId === "vsCarol");
  const s1 = await settings(page);
  if (s1.voiceId !== "vsCarol" || s1.voiceName !== "Carol") fail(`a pick is kept as ${JSON.stringify([s1.voiceId, s1.voiceName])}`);
  if (await byTid(page, "vs-voice", { voice: "vsCarol" }).getAttribute("aria-checked") !== "true" || await byTid(page, "vs-voice", { voice: "vsAlice" }).getAttribute("aria-checked") !== "false") fail("the radio does not follow the pick");
  // the preview clip: no TTS request, no key
  await mockEval("voice.reset();", url);
  await press(page, byTid(page, "vs-voice-play", { voice: "vsBob" }));
  const played = await until(async () => (await log()).some((e) => e.kind === "preview"));
  const entries = await log();
  if (!played) fail("the play button asked for no preview clip");
  if (entries.some((e) => e.kind === "tts")) fail("a preview was made with a TTS request (it would cost credits)");
  if (entries.filter((e) => e.kind === "preview").some((e) => !/vsBob\.wav$/.test(e.path) || e.keyHeader)) fail(`the preview request is ${JSON.stringify(entries.filter((e) => e.kind === "preview"))}`);
  await until(async () => (await byTid(page, "vs-voice-play", { voice: "vsBob" }).getAttribute("data-playing")) === "false", 15000);
  // a preview that cannot be fetched: the popover on its button
  await mockEval("voice.fail('offline');", url);
  await press(page, byTid(page, "vs-voice-play", { voice: "vsAlice" }));
  if (!await shown(byTid(page, "voice-problem"))) fail("a preview that cannot be fetched shows no popover");
  else {
    if (await byTid(page, "voice-problem").getAttribute("data-kind") !== "offline") fail("the popover is not the offline one");
    if (await textOf(byTid(page, "voice-problem-text")) !== "Can't reach ElevenLabs.") fail(`the popover says "${await textOf(byTid(page, "voice-problem-text"))}"`);
    const acts = (await byTid(page, "voice-problem").getByRole("button").allTextContents()).map((s) => s.trim());
    if (acts.join() !== "Not now,Try again") fail(`the popover's buttons are ${acts.join()}`);
    await shot(page, "3-problem");
    await mockEval("voice.fail(null); voice.reset();", url);
    await press(page, byTid(page, "voice-problem-act"));
    if (!await gone(byTid(page, "voice-problem"))) fail("Try again leaves the popover");
    if (!await until(async () => (await log()).some((e) => e.kind === "preview" && e.status === 200))) fail("Try again fetched no preview");
    await mockEval("voice.fail('offline');", url);
    await press(page, byTid(page, "vs-voice-play", { voice: "vsAlice" }));
    await shown(byTid(page, "voice-problem"));
    await press(page, byTid(page, "voice-problem-dismiss"));
    if (!await gone(byTid(page, "voice-problem"))) fail("Not now leaves the popover");
    await mockEval("voice.fail(null);", url);
  }
  // the whole list, with a search
  await press(page, byTid(page, "vs-voices-all"));
  await until(async () => (await byTid(page, "vs-voice-row").count()) === 6);
  if (await byTid(page, "vs-voice-row").count() !== 6) fail(`Show all voices lists ${await byTid(page, "vs-voice-row").count()} voices, not 6`);
  if (!await byTid(page, "vs-voices-search").count()) fail("the full list has no search");
  await byTid(page, "vs-voices-search").fill("fran");
  await until(async () => (await byTid(page, "vs-voice-row").count()) === 1);
  if ((await byTid(page, "vs-voice-row").evaluateAll((es) => es.map((e) => e.dataset.voice))).join() !== "vsFrank") fail("the search does not narrow the list to Frank");
  if (await byTid(page, "vs-voices-search").evaluate((e) => document.activeElement === e) !== true) fail("the search lost the focus while the list changed");
  await byTid(page, "vs-voices-search").fill("");
  await until(async () => (await byTid(page, "vs-voice-row").count()) === 6);
  await shot(page, "4-all");
  await press(page, byTid(page, "vs-voices-all"));
  await until(async () => (await byTid(page, "vs-voice-row").count()) === 4);
  if (await byTid(page, "vs-voice-row").first().getAttribute("data-voice") !== "vsCarol") fail("the chosen voice is not first in the short list");

  // ---- the settings
  await press(page, byTid(page, "vs-autosend-false"));
  await until(async () => (await settings(page)).autoSend === false);
  if (await byTid(page, "vs-autosend-false").getAttribute("aria-checked") !== "true" || await byTid(page, "vs-autosend-true").getAttribute("aria-checked") !== "false") fail("the choice does not show Tap to send");
  await press(page, byTid(page, "vs-advanced"));
  if (!await shown(byTid(page, "vs-advanced-body"))) fail("Advanced options did not open");
  const defaults = await settings(page);
  if (defaults.ttsModel !== "eleven_flash_v2_5" || defaults.language !== null || defaults.pauseMs !== 1200 || defaults.speed !== 1 || defaults.skipCode !== true) fail(`the defaults are ${JSON.stringify(defaults)}`);
  const shownDefaults = await page.evaluate(() => Object.fromEntries(["vs-adv-tts", "vs-adv-stt", "vs-adv-language", "vs-adv-pause", "vs-adv-speed"].map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.innerText.replace(/[▾\s]+$/, "").trim()])));
  if (JSON.stringify(shownDefaults) !== JSON.stringify({ "vs-adv-tts": "Flash v2.5", "vs-adv-stt": "Scribe v2 Realtime", "vs-adv-language": "Auto-detect", "vs-adv-pause": "1.2 s", "vs-adv-speed": "1.0×" })) fail(`Advanced options show ${JSON.stringify(shownDefaults)}`);
  if (await byTid(page, "vs-adv-skipcode").getAttribute("aria-checked") !== "true") fail("Skip code blocks is not on by default");
  await shot(page, "5-advanced");
  await pick(page, "vs-adv-tts", "v4 Turbo");
  await until(async () => (await settings(page)).ttsModel === "eleven_v4_turbo");
  await pick(page, "vs-adv-tts", "Multilingual v2");
  await pick(page, "vs-adv-language", "Croatian");
  await pick(page, "vs-adv-pause", "2.0 s");
  await pick(page, "vs-adv-speed", "1.2×");
  await press(page, byTid(page, "vs-adv-skipcode"));
  await until(async () => (await settings(page)).skipCode === false);
  const s2 = await settings(page);
  if (s2.ttsModel !== "eleven_multilingual_v2" || s2.language !== "hr" || s2.pauseMs !== 2000 || s2.speed !== 1.2 || s2.skipCode !== false || s2.autoSend !== false) fail(`the settings are ${JSON.stringify(s2)}`);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.voice.settings") ?? "null"));
  if (JSON.stringify(stored) !== JSON.stringify(s2)) fail(`the stored settings are ${JSON.stringify(stored)}, not what the page holds`);
  if (await page.evaluate((k) => Object.keys(localStorage).some((n) => n.includes(k) || (localStorage.getItem(n) ?? "").includes(k)), KEY)) fail("the key is in localStorage");
  await shot(page, "6-changed");

  // ---- readable
  const floorOf = async (p, what) => {
    for (const r of (await contrastAudit(p, { only: ['[data-testid="settings-dialog"]', '[data-testid="sheet"]'] })).filter((r) => r.ratio < FLOOR)) fail(`${what}: "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1`);
  };
  await floorOf(page, "in the light theme");

  // ---- remove
  await press(page, byTid(page, "vs-key-remove"));
  const ask = byTid(page, "confirm-dialog");
  if (!await shown(ask)) fail("Remove key asked nothing first");
  else {
    await press(page, btn(ask, "Cancel"));
    await gone(ask);
    if (!await byTid(page, "vs-key-remove").count()) fail("Cancel removed the key");
    await press(page, byTid(page, "vs-key-remove"));
    await shown(ask);
    await press(page, btn(ask, "Remove key"));
    await gone(ask);
    await until(async () => !(await byTid(page, "vs-key-remove").count()));
    if (await byTid(page, "vs-key-remove").count()) fail("Remove key is still offered after the key was removed");
    if (!await shown(byTid(page, "vs-voices-nokey"))) fail("the voices stay after the key was removed");
    if (await byTid(page, "vs-key").getAttribute("placeholder") === "A key is saved on this device") fail("the box still says a key is saved");
    await press(page, byTid(page, "vs-key-test"));
    if (await waitResult(page, /key/) !== "Voice needs your ElevenLabs key. It stays on this device.") fail("Test key finds a key after it was removed");
    await shot(page, "7-removed");
  }
  await close(page);

  // ---- the stand-in saw the key as a header only; nothing else of the log carries it
  const all = await log();
  if (JSON.stringify(all).includes("CANARY")) fail("a key reached the stand-in's log in a place other than its header (the log holds `keyHeader` only)");

  // ---- a reload: the key is gone (web), the settings stay; the page reopens as it was
  await page.reload();
  await page.waitForSelector('[data-testid="settings-btn"]', { timeout: 30000 });
  await openPage(page);
  if (await byTid(page, "vs-key").getAttribute("placeholder") === "A key is saved on this device") fail("the key survived a reload (the web build keeps it in memory only)");
  const s3 = await settings(page);
  if (JSON.stringify(s3) !== JSON.stringify(s2)) fail(`the settings after a reload are ${JSON.stringify(s3)}, not ${JSON.stringify(s2)}`);
  if (await byTid(page, "vs-autosend-false").getAttribute("aria-checked") !== "true") fail("the Auto-send choice does not show what was kept");
  if (await byTid(page, "vs-advanced-body").count()) fail("Advanced options are open again after a reload");
  await press(page, byTid(page, "vs-advanced"));
  if (await byTid(page, "vs-adv-language").innerText().then((t) => !t.includes("Croatian"))) fail("the language kept over a reload is not shown");
  // Esc closes it; the page opens again at the foot's button
  await page.keyboard.press("Escape");
  if (!await gone(dialog(page))) fail("Esc leaves the page open");
  await sleep(50);

  // ---- a rejected key that is stored: the list says so, with a way to try again
  await page.evaluate((k) => window.__aiwbVoice.setKey(k), BAD);
  await openPage(page);
  if (!await shown(byTid(page, "vs-voices-failed"))) fail("a stored key the service rejects shows no failure in the voices");
  else {
    if (await textOf(byTid(page, "vs-voices-failed")) !== "ElevenLabs did not accept this key.Try again") fail(`the failed list says "${await textOf(byTid(page, "vs-voices-failed"))}"`);
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    await press(page, byTid(page, "vs-voices-retry"));
    if (!await shown(byTid(page, "vs-voice-row"))) fail("Try again did not bring the voices once the key worked");
  }
  await shot(page, "8-retried");
  await close(page);
  await context.close();

  // ---- a dark flavour keeps the floor too
  const dark = await open({ ls: { "aiwb.theme": "mocha" } });
  await openPage(dark.page);
  await press(dark.page, byTid(dark.page, "vs-advanced"));
  await floorOf(dark.page, "in Mocha");
  await shot(dark.page, "9-mocha");

  note(`the foot's gear, the page ${wide ? "as a dialog" : "as a sheet"} with the four sections and Advanced options collapsed, Test key (no key, rejected, working), Save, Show, ${rows.length} voices with their previews and the problem popover, Show all and the search, the settings kept over a reload, Remove, the contrast floor`);
}, { viewports });
