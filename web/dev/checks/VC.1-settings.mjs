// VC.1 (new, voice-chats P12): Settings > Voice, on the mock with the stand-in voice service mounted at /voice (dev/voicestandin.mjs), at the
// desktop, the tablet and the phone: a centred dialog on the first two, the pushed Voice screen on the phone (ux-improvements S3: `vs-screen`, with
// Add key a sheet, Choose voice a pushed screen and the devices in sheets that list only while open; plans/ux-improvements/s3-design.md). Goal 3.7,
// 4.2, 4.9, 4.10, 6.3; architecture VC-13 and VC-30. The key lives in the web build's memory (VC-2), so a reload drops it.
// The text below describes the dialog (desktop, tablet). The phone half proves the same things on the new screens, with the helpers of
// voicephone.mjs: Home's gear pushes Settings and its Voice row pushes the Voice screen (home, settings, voice-settings; the phone has no sidebar foot); with no key it is the card, the privacy line and the dimmed voice row,
// nothing can be removed, no device is listed and no request is made; the key typed in Add key (hidden, the eye shows it), Test key (no key, rejected,
// working), Save; the voices of Choose voice (the first four, a few words each, the first marked when none is chosen, a pick is the setting and the
// ✓ moves, the sample plays the voice's own clip with no `tts`, a sample that cannot be fetched says why on its row and not in a popover, Show all
// voices, the search, the chosen voice first the next time); the devices in their sheets (listed only while open, the permission by Test microphone,
// the meter, picks, plug and unplug, "(not connected)", Test speaker with no request); Auto-send and every Advanced row are the voice settings and
// are kept over a reload; Remove key asks first; the key is in no text, label, attribute, storage or line of the stand-in's log; the contrast floor in
// the light theme and in Mocha. Dropped on the phone, because the design removed them: the Advanced options' fold (the rows are always there once a key
// is saved), the "Microphone and speaker" card with its own no-key line (the devices are two Advanced rows, and with no key the screen has none), the
// settings page's Close and Esc (the stack's Back), the voices' radios in the screen itself (Choose voice) and the "Show all" way back.
//   the foot         (the wide layouts') the gear button (`settings-btn`, "Settings") is between the library's button and the theme picker, and opens the page
//   the page         the sections in the goal's order (key, voice, microphone and speaker, how a spoken turn is sent, Advanced options), Advanced options
//                    collapsed, the page rounded; no key: the voice list asks for one, nothing can be removed, and Test key says the key is missing
//   the key          typed in a hidden box, Show shows it; Test key with a rejected key says the 401 sentence, with a working one the number of
//                    voices; Save keeps it (the box empties, its placeholder says a key is saved) and the list of voices comes; the stand-in saw the key
//                    only as the header (`keyHeader`), the page holds it in no storage and in no line of text
//   the voices       the first four, a few words each, the first marked (the service's first speaks when none is chosen), a pick is kept as the voice
//                    setting; Show all voices lists them all with a search and the way back; the play button plays the voice's own preview clip
//                    (the stand-in logs a `preview` and no `tts`: no credits), and a preview that cannot be fetched hangs the problem popover from its
//                    button, with "Try again" and "Not now"
//   the devices      the card "Microphone and speaker" (voice-devices VD-17, D8; stand-in devices of devices.mjs, installed before the page loads): it is
//                    between Voice and Auto-send and looks like the other cards (`vs-devices-section`); with no key saved it says "Add your key …"
//                    (`vs-devices-nokey`) and offers and lists nothing (no `enumerateDevices` call); with the key, before the microphone is allowed both pickers
//                    (`vs-mic`, `vs-speaker`) hold System default alone and `vs-devices-note` says why; Test microphone (`vs-mic-test`) asks for the
//                    permission, the lists fill, the meter (`vs-mic-level`) moves and carries a peak, and a second tap, a different microphone (it
//                    restarts on it) and closing Settings behave as VD-16 says; a pick is the voice setting `mic` / `speaker`; Test speaker
//                    (`vs-speaker-test`) plays on the chosen sink and makes no request of the voice service; a device plugged in while
//                    Settings is open is listed, a saved one unplugged shows "(not connected)" and stays saved; the card keeps the contrast floor
//   the settings     Auto-send / Tap to send and every Advanced option are the voice settings (`__aiwbVoice.settings()`), kept over a reload
//   remove           "Remove key from this device" asks first, then the key is gone: the box, the list and the button say so; a reload drops the key too
//   readable         the page's text and icons keep the contrast floor in the light theme and a dark flavour
// OUT=/tmp/x keeps a screenshot of the page in each state there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest, check, contrastAudit, mockEval, until } from "../shot.mjs";
import { installDevices } from "./devices.mjs";
import { byTid, press } from "./sel.mjs";
import { atRest as atRestId } from "./settings.mjs";
import { closeSheet, deviceCalls, leaks, openAddKey, openChooseVoice, openVoice, pickIn, sheetGone, sheetShown, stackNames, typeKey, voiceKeyState, voiceSettings, voicesLoaded } from "./voicephone.mjs";

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

  // ---- the phone: the pushed Voice screen, Add key, Choose voice and the device sheets (voicephone.mjs). The dialog's code below is for the wide layouts.
  const phoneHalf = async () => {
    const J = JSON.stringify;
    const STORED = "Stored on this device only. Sent only to elevenlabs.io.";
    const pshot = async (name, rest = "vs-screen", p = page) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await atRestId(p, rest, 6000).catch(() => {}); await p.screenshot({ path: path.join(OUT, `VC.1-${viewport}-${name}.png`) }); } };
    const dev = (fn, ...args) => page.evaluate(([f, a]) => window.__aiwbDevices[f](...a), [fn, args]);
    const cellValue = (id) => textOf(byTid(page, id).last().locator('[data-testid="cell-value"]'));
    const resultText = () => textOf(byTid(page, "vs-key-result").last());
    const sheetRows = (id) => page.evaluate((id) => {
      const all = document.querySelectorAll(`[data-testid="${id}"]`), s = all[all.length - 1];
      return s ? [...s.querySelectorAll('[data-testid="picker-row"]')].map((e) => e.innerText.replace(/\s+/g, " ").trim().replace(/\s*✓$/, "")) : [];
    }, id);
    const sheetPick = (id, label) => press(page, byTid(page, id).last().locator('[data-testid="picker-row"]').filter({ hasText: label }).first());
    // (the disclosure chevron of the kit's cells, `button > svg`, is the "faint" token: decorative, #a0a0ab on white, 2.58:1 on every kit screen, S1's too; left out)
    const floor = async (what, only, p = page) => {
      for (const r of (await contrastAudit(p, { only: [only], skip: ["button > svg"] })).filter((r) => r.ratio < FLOOR)) fail(`${what}: "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1`);
    };
    const backTo = async (p, name) => { for (let i = 0; i < 4 && (await stackNames(p)).at(-1) !== name; i++) await press(p, byTid(p, "nav-back").last()); };
    /** Out of the Voice screen and back in, so that it reads the keystore again (a key set from outside, as a saved one is). */
    const reopen = async (setup) => {
      await backTo(page, "settings");
      await setup();
      await openVoice(page);
    };
    const noCanary = async (step, k = KEY) => {
      const l = await leaks(page, k, { fields: true });
      const where = Object.entries(l).filter(([, v]) => v).map(([w]) => w);
      if (where.length) fail(`${step}: the key is in the page's ${where.join(", ")}`);
    };
    const switchOf = (id) => page.locator('[role="switch"]').filter({ has: byTid(page, id) }).last();

    // ---- with no key: the card, nothing offered, nothing asked
    await openVoice(page);
    if ((await stackNames(page)).join() !== "home,settings,voice-settings") fail(`the gear pushed [${(await stackNames(page)).join(", ")}], not home, settings, voice-settings`);
    if ((await voiceKeyState(page)) !== "none") fail(`the screen's key state is ${J(await voiceKeyState(page))}, not "none"`);
    {
      const text = await textOf(byTid(page, "vs-screen"));
      for (const s of ["Talk to your agents", "Add ElevenLabs key", STORED, "Add your key to choose a voice."]) if (!text.includes(s)) fail(`the Voice screen with no key lacks ${J(s)}`);
      for (const id of ["vs-key-remove", "vs-key-row", "vs-autosend", "vs-adv-tts", "vs-mic", "vs-speaker", "vs-mic-test", "vs-speaker-test", "vs-choose-voice"]) if (await byTid(page, id).count()) fail(`${id} is offered with no key saved`);
      if ((await textOf(byTid(page, "vs-voice-nokey"))) !== "Add your key to choose a voice.") fail(`with no key the voices say ${J(await textOf(byTid(page, "vs-voice-nokey")))}`);
      const radius = await byTid(page, "vs-nokey-card").last().evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
      if (!(radius >= 8)) fail(`the no-key card is rounded ${radius}px`);
    }
    await sleep(1000);
    if ((await log()).length) fail(`the Voice screen with no key made requests of the voice service: ${J(await log())}`);
    if (J(await deviceCalls(page)) !== J({ enumerateDevices: 0, getUserMedia: 0, setSinkId: 0 })) fail(`the Voice screen with no key made device calls: ${J(await deviceCalls(page))}`);
    await pshot("1-nokey");
    await floor("the Voice screen with no key (light)", '[data-testid="vs-screen"]');
    // Test key with no key says the key is missing; the sheet holds a hidden box and the line on where the key goes
    await openAddKey(page);
    {
      const sheet = byTid(page, "vs-key-sheet").last();
      if ((await byTid(page, "vs-key").last().getAttribute("type")) !== "password") fail("the key box is not hidden");
      if (!(await textOf(sheet)).includes(STORED)) fail("the Add key sheet lacks the line on where the key goes");
      await press(page, byTid(page, "vs-key-test").last());
      if (!await until(async () => /key/.test(await resultText()), 15000)) fail("Test key with no key said nothing");
      else if (!(await resultText()).includes("Voice needs your ElevenLabs key. It stays on this device.")) fail(`Test key with no key says ${J(await resultText())}`);
      await pshot("1-addkey-nokey", "vs-key-sheet");
      await floor("Add key (light)", '[data-testid="vs-key-sheet"]');
      await closeSheet(page, "vs-key-sheet");
    }

    // ---- the devices (voice-devices D8): the key set from outside; they list only in their sheets
    await reopen(() => page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY));
    if ((await voiceKeyState(page)) !== "saved") fail("the Voice screen is not in the key state after the key was set");
    for (const id of ["vs-mic", "vs-speaker"]) if ((await cellValue(id)) !== "System default") fail(`before anything is chosen ${id} shows ${J(await cellValue(id))}`);
    await sleep(800);
    if (J(await deviceCalls(page)) !== J({ enumerateDevices: 0, getUserMedia: 0, setSinkId: 0 })) fail(`the Voice screen with a key made device calls: ${J(await deviceCalls(page))}`);
    if ((await log()).length) fail(`the Voice screen with a key made requests of the voice service: ${J(await log())}`);
    await press(page, byTid(page, "vs-mic").last());
    await sheetShown(page, "vs-device-sheet-mic");
    if (!await until(async () => (await deviceCalls(page)).enumerateDevices > 0, 15000)) fail("the Microphone sheet listed no device");
    // before the microphone is allowed: System default alone, the note says why, no meter, no microphone opened
    {
      const rows = await sheetRows("vs-device-sheet-mic");
      if (rows.length !== 1 || !/^System default/.test(rows[0])) fail(`before the permission the Microphone sheet lists ${J(rows)}`);
      if ((await textOf(byTid(page, "vs-devices-note"))) !== "Allow the microphone to see your other devices.") fail(`the note before the permission says ${J(await textOf(byTid(page, "vs-devices-note")))}`);
      if (await byTid(page, "vs-mic-level").count()) fail("the meter is drawn before the tap");
      if ((await deviceCalls(page)).getUserMedia !== 0) fail("opening the Microphone sheet asked for the microphone");
      await pshot("1a-devices-before", "vs-device-sheet-mic");
    }
    // Test microphone: the permission is the person's tap; the list fills; the meter moves
    await press(page, byTid(page, "vs-mic-test").last());
    if (!await until(() => byTid(page, "vs-mic-level").count(), 15000)) fail("Test microphone drew no meter");
    if ((await byTid(page, "vs-mic-test").last().getAttribute("aria-pressed")) !== "true" || (await textOf(byTid(page, "vs-mic-test"))) !== "End test") fail(`the test button says ${J(await textOf(byTid(page, "vs-mic-test")))} while it runs`);
    await until(async () => (await sheetRows("vs-device-sheet-mic")).length === 3, 15000);
    {
      const rows = await sheetRows("vs-device-sheet-mic");
      if (!/^System default/.test(rows[0] ?? "") || rows.slice(1).join() !== "Desk Mic,Stand-in Headset") fail(`the microphones listed are ${J(rows)}`);
      if (await byTid(page, "vs-devices-note").count()) fail("the note stays after the microphone was allowed");
      if (!await until(async () => Number(await byTid(page, "vs-mic-level").last().getAttribute("data-peak")) > 0, 15000)) fail("the meter never moved while the test ran");
      await pshot("1b-devices-testing", "vs-device-sheet-mic");
      await floor("the Microphone sheet (light)", '[data-testid="vs-device-sheet-mic"]');
    }
    // a different microphone: the test goes on with it
    await sheetPick("vs-device-sheet-mic", "Stand-in Headset");
    await until(async () => (await voiceSettings(page)).mic?.id === "mic-headset");
    if ((await voiceSettings(page)).mic?.name !== "Stand-in Headset") fail(`the pick is kept as ${J((await voiceSettings(page)).mic)}`);
    if (!await until(async () => (await dev("opened")).at(-1)?.deviceId === "mic-headset" && (await dev("opened")).at(-1)?.live, 15000)) fail(`the test did not go on with the microphone picked (opened: ${J(await dev("opened"))})`);
    // a second tap stops it, with the microphone released
    await press(page, byTid(page, "vs-mic-test").last());
    if (!await until(async () => (await byTid(page, "vs-mic-level").count()) === 0, 10000)) fail("the meter stays after End test");
    if ((await dev("opened")).some((o) => o.live)) fail("a microphone stays open after End test");
    if ((await textOf(byTid(page, "vs-mic-test"))) !== "Test microphone") fail("the test button does not go back to \"Test microphone\"");
    // plugged in while the sheet is open: listed; a saved one unplugged: "(not connected)", still saved; plugged in again: back
    await dev("plug", { kind: "input", id: "mic-usb", label: "USB Mic", hz: 500 });
    if (!await until(async () => (await sheetRows("vs-device-sheet-mic")).includes("USB Mic"), 15000)) fail("a microphone plugged in while the sheet is open is not listed");
    await dev("unplug", "mic-usb");
    await dev("unplug", "mic-headset");
    if (!await until(async () => (await sheetRows("vs-device-sheet-mic")).includes("Stand-in Headset (not connected)"), 15000)) fail(`the unplugged microphone is listed as ${J(await sheetRows("vs-device-sheet-mic"))}`);
    if ((await sheetRows("vs-device-sheet-mic")).includes("USB Mic")) fail("a microphone unplugged while the sheet is open is still listed");
    if ((await voiceSettings(page)).mic?.id !== "mic-headset") fail("unplugging the saved microphone changed the saved choice");
    await dev("plug", { kind: "input", id: "mic-headset", label: "Stand-in Headset", hz: 700 });
    if (!await until(async () => (await sheetRows("vs-device-sheet-mic")).includes("Stand-in Headset"), 15000)) fail("the microphone does not come back to the list when it is plugged in again");
    await pshot("1c-devices", "vs-device-sheet-mic");
    await closeSheet(page, "vs-device-sheet-mic");
    if ((await cellValue("vs-mic")) !== "Stand-in Headset") fail(`the Microphone row says ${J(await cellValue("vs-mic"))} after the pick`);
    // the Speaker sheet: Test speaker plays on the chosen sink and makes no request of the voice service
    await press(page, byTid(page, "vs-speaker").last());
    await sheetShown(page, "vs-device-sheet-speaker");
    await until(async () => (await sheetRows("vs-device-sheet-speaker")).length === 3, 15000);
    {
      const rows = await sheetRows("vs-device-sheet-speaker");
      if (!/^System default/.test(rows[0] ?? "") || rows.slice(1).join() !== "Desk Speakers,Stand-in Headphones") fail(`the speakers listed are ${J(rows)}`);
    }
    await sheetPick("vs-device-sheet-speaker", "Stand-in Headphones");
    await until(async () => (await voiceSettings(page)).speaker?.id === "out-headphones");
    await mockEval("voice.reset();", url);
    await press(page, byTid(page, "vs-speaker-test").last());
    if (!await until(async () => (await dev("sinks")).some((x) => x.sinkId === "out-headphones"), 15000)) fail(`Test speaker did not play on the speaker picked (sinks: ${J(await dev("sinks"))})`);
    await until(async () => (await byTid(page, "vs-speaker-test").last().getAttribute("data-playing")) === "false", 15000);
    if ((await log()).length) fail(`Test speaker made a request of the voice service: ${J(await log())}`);
    await sheetPick("vs-device-sheet-speaker", "System default");
    await until(async () => (await voiceSettings(page)).speaker === null);
    await closeSheet(page, "vs-device-sheet-speaker");
    // System default again for the microphone; a test running when the sheet closes ends with it
    await press(page, byTid(page, "vs-mic").last());
    await sheetShown(page, "vs-device-sheet-mic");
    await sheetPick("vs-device-sheet-mic", "System default");
    await until(async () => (await voiceSettings(page)).mic === null);
    await press(page, byTid(page, "vs-mic-test").last());
    await until(() => byTid(page, "vs-mic-level").count(), 15000);
    await closeSheet(page, "vs-device-sheet-mic");
    if (!await until(async () => !(await dev("opened")).some((o) => o.live), 15000)) fail("the microphone test goes on after its sheet was closed");
    await press(page, byTid(page, "vs-mic").last());
    await sheetShown(page, "vs-device-sheet-mic");
    if (await byTid(page, "vs-mic-level").count()) fail("the meter is drawn when the sheet opens again");
    await closeSheet(page, "vs-device-sheet-mic");

    // ---- the key (the part below starts with none)
    await reopen(() => page.evaluate(() => window.__aiwbVoice.clearKey()));
    if ((await voiceKeyState(page)) !== "none") fail("the Voice screen still says a key is saved after it was cleared");
    await openAddKey(page);
    await typeKey(page, BAD);
    const eye = byTid(page, "vs-key-eye").last();
    await press(page, eye);
    if ((await byTid(page, "vs-key").last().getAttribute("type")) === "password" || (await byTid(page, "vs-key").last().inputValue()) !== BAD) fail("the eye does not show what is typed");
    await press(page, eye);
    if ((await byTid(page, "vs-key").last().getAttribute("type")) !== "password") fail("the eye does not hide the key again");
    await press(page, byTid(page, "vs-key-test").last());
    if (!await until(async () => /accept/.test(await resultText()), 15000)) fail("Test key with a rejected key said nothing");
    else if ((await resultText()) !== "! ElevenLabs did not accept this key.") fail(`a rejected key says ${J(await resultText())}`);
    await typeKey(page, KEY);
    if (await byTid(page, "vs-key-result").count()) fail("the result of the last test stays when the key changes");
    await press(page, byTid(page, "vs-key-test").last());
    if (!await until(async () => /Works/.test(await resultText()), 15000)) fail("Test key with a working key said nothing");
    else if ((await resultText()) !== "✓ Works: 6 voices found.") fail(`a working key says ${J(await resultText())}`);
    if ((await byTid(page, "vs-key-result").last().getAttribute("data-tone")) !== "ok") fail("the result of a working key is not drawn as ok");
    if ((await voiceKeyState(page)) !== "none" || !(await byTid(page, "vs-voice-nokey").count())) fail("the voices came before the key was saved");
    await pshot("2-tested", "vs-key-sheet");
    {
      const l = await leaks(page, KEY);
      const where = Object.entries(l).filter(([, v]) => v).map(([w]) => w);
      if (where.length) fail(`the key typed is in the page's ${where.join(", ")} (its box excepted)`);
    }
    await press(page, byTid(page, "sheet-right").last());
    await sheetGone(page, "vs-key-sheet");
    await until(async () => (await voiceKeyState(page)) === "saved", 15000);
    await atRestId(page, "vs-screen");
    if (!(await textOf(byTid(page, "vs-key-row"))).includes("Saved on this device ✓")) fail(`the key row says ${J(await textOf(byTid(page, "vs-key-row")))} after Save`);
    if (!await byTid(page, "vs-key-remove").count()) fail("Remove key is not offered with a key saved");
    await openAddKey(page);
    if ((await byTid(page, "vs-key").last().inputValue()) !== "") fail("Add key opens with the saved key in its box");
    await noCanary("a key saved, Add key open again");
    await closeSheet(page, "vs-key-sheet");
    await noCanary("a key saved");

    // ---- the voices (Choose voice)
    await openChooseVoice(page);
    await voicesLoaded(page);
    const rowsNow = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="cv-row"]')].map((r) => ({ id: r.dataset.voice, selected: r.dataset.selected, text: r.innerText.replace(/\s+/g, " ").trim(), play: !!r.querySelector('[data-testid="cv-play"]') })));
    let rows = await rowsNow();
    if (rows.map((r) => r.id).join() !== "vsAlice,vsBob,vsCarol,vsDave") fail(`the short list is ${rows.map((r) => r.id).join()}, not the first four by name`);
    if (rows[0] && !/Alice.*Warm and clear/.test(rows[0].text)) fail(`a voice's row does not carry its name and a few words: ${J(rows[0]?.text)}`);
    if (rows.some((r) => !r.play)) fail("a voice has no play button");
    if (rows.filter((r) => r.selected === "true").map((r) => r.id).join() !== "vsAlice") fail("with none chosen the first voice is not the one marked");
    if ((await voiceSettings(page)).voiceId !== null) fail("the first voice was stored as the choice before anyone chose");
    await floor("Choose voice (light)", '[data-testid="cv-screen"]');
    await press(page, byTid(page, "cv-row", { voice: "vsCarol" }).last().locator('[role="radio"]'));
    await until(async () => (await voiceSettings(page)).voiceId === "vsCarol");
    {
      const s1 = await voiceSettings(page);
      if (s1.voiceId !== "vsCarol" || s1.voiceName !== "Carol") fail(`a pick is kept as ${J([s1.voiceId, s1.voiceName])}`);
      rows = await rowsNow();
      if (rows.filter((r) => r.selected === "true").map((r) => r.id).join() !== "vsCarol") fail(`the ✓ does not follow the pick: ${J(rows.map((r) => [r.id, r.selected]))}`);
    }
    // the sample is the voice's own clip: no TTS request, no key
    await mockEval("voice.reset();", url);
    await press(page, byTid(page, "cv-play", { voice: "vsBob" }).last());
    const played = await until(async () => (await log()).some((e) => e.kind === "preview"), 15000);
    {
      const entries = await log();
      if (!played) fail("the play button asked for no preview clip");
      if (entries.some((e) => e.kind === "tts")) fail("a preview was made with a TTS request (it would cost credits)");
      if (entries.filter((e) => e.kind === "preview").some((e) => !/vsBob\.wav$/.test(e.path) || e.keyHeader)) fail(`the preview request is ${J(entries.filter((e) => e.kind === "preview"))}`);
    }
    await until(async () => (await byTid(page, "cv-play", { voice: "vsBob" }).last().getAttribute("data-playing")) === "false", 15000);
    // a sample that cannot be fetched says so on its row, and hangs no popover (no sheet over the screen's rows)
    await mockEval("voice.fail('offline');", url);
    await press(page, byTid(page, "cv-play", { voice: "vsAlice" }).last());
    if (!await until(() => byTid(page, "cv-problem").count(), 15000)) fail("a preview that cannot be fetched says nothing on its row");
    else {
      if ((await byTid(page, "cv-problem").first().getAttribute("data-kind")) !== "offline") fail("the row's problem is not the offline one");
      if ((await textOf(byTid(page, "cv-problem"))).replace(/Try again$/, "").trim() !== "Can't reach ElevenLabs.") fail(`the row says ${J(await textOf(byTid(page, "cv-problem")))}`);
      if (await byTid(page, "voice-problem").count()) fail("a failed sample hangs a popover over Choose voice");
      await pshot("3-problem", "cv-screen");
      await mockEval("voice.fail(null); voice.reset();", url);
      const again = byTid(page, "cv-problem").first().getByRole("button", { name: "Try again" });
      await press(page, (await again.count()) ? again.first() : byTid(page, "cv-play", { voice: "vsAlice" }).last());
      if (!await until(async () => (await log()).some((e) => e.kind === "preview" && e.status === 200), 15000)) fail("trying again fetched no preview");
      await until(async () => (await byTid(page, "cv-play", { voice: "vsAlice" }).last().getAttribute("data-playing")) === "false", 15000);
    }
    // the whole list, with a search
    await press(page, byTid(page, "cv-all").last());
    await until(async () => (await rowsNow()).length === 6, 15000);
    if ((await rowsNow()).length !== 6) fail(`Show all voices lists ${(await rowsNow()).length} voices, not 6`);
    await byTid(page, "cv-search").last().fill("fran");
    await until(async () => (await rowsNow()).length === 1, 15000);
    if ((await rowsNow()).map((r) => r.id).join() !== "vsFrank") fail("the search does not narrow the list to Frank");
    if (await byTid(page, "cv-search").last().evaluate((e) => !e.contains(document.activeElement) && !e.matches(":focus-within"))) fail("the search lost the focus while the list changed");
    await byTid(page, "cv-search").last().fill("");
    await until(async () => (await rowsNow()).length === 6, 15000);
    await pshot("4-all", "cv-screen");
    // back on the Voice screen: the chosen voice, its sample (no TTS), and a sample that fails says so there too
    await press(page, byTid(page, "nav-back").last());
    await atRestId(page, "vs-screen");
    {
      const chosen = byTid(page, "vs-chosen-voice").last();
      if ((await chosen.getAttribute("data-voice")) !== "vsCarol" || !(await textOf(chosen)).includes("Carol")) fail(`the chosen voice row says ${J(await textOf(chosen))}, not Carol`);
      await mockEval("voice.reset();", url);
      await press(page, byTid(page, "vs-voice-play").last());
      if (!await until(async () => (await log()).some((e) => e.kind === "preview"), 15000)) fail("the chosen voice's play asked for no preview clip");
      if ((await log()).some((e) => e.kind === "tts")) fail("the chosen voice's sample was made with a TTS request");
      await until(async () => (await byTid(page, "vs-voice-play").last().getAttribute("data-playing")) === "false", 15000);
      await mockEval("voice.fail('offline');", url);
      await press(page, byTid(page, "vs-voice-play").last());
      if (!await until(async () => (await textOf(chosen)).includes("Can't reach ElevenLabs."), 15000)) fail(`the chosen voice row does not say the sample failed: ${J(await textOf(chosen))}`);
      await mockEval("voice.fail(null);", url);
    }
    await openChooseVoice(page);
    await voicesLoaded(page);
    rows = await rowsNow();
    if (rows.length !== 4 || rows[0].id !== "vsCarol" || rows[0].selected !== "true") fail(`the chosen voice is not first in the short list: ${J(rows.map((r) => [r.id, r.selected]))}`);
    await press(page, byTid(page, "nav-back").last());
    await atRestId(page, "vs-screen");

    // ---- the settings
    const sw = switchOf("vs-autosend");
    await press(page, sw);
    await until(async () => (await voiceSettings(page)).autoSend === false);
    if ((await sw.getAttribute("aria-checked")) !== "false" || (await byTid(page, "vs-autosend").last().getAttribute("data-on")) !== "false") fail("the switch does not show Tap to send");
    const defaults = await voiceSettings(page);
    if (defaults.ttsModel !== "eleven_flash_v2_5" || defaults.language !== null || defaults.pauseMs !== 1200 || defaults.speed !== 1 || defaults.skipCode !== true) fail(`the defaults are ${J(defaults)}`);
    {
      const shownDefaults = {};
      for (const id of ["vs-adv-tts", "vs-adv-stt", "vs-adv-language", "vs-adv-pause", "vs-adv-speed"]) shownDefaults[id] = await cellValue(id);
      if (J(shownDefaults) !== J({ "vs-adv-tts": "Flash v2.5", "vs-adv-stt": "Scribe v2 Realtime", "vs-adv-language": "Auto-detect", "vs-adv-pause": "1.2 s", "vs-adv-speed": "1.0×" })) fail(`Advanced shows ${J(shownDefaults)}`);
      if ((await switchOf("vs-adv-skipcode").getAttribute("aria-checked")) !== "true") fail("Skip code blocks is not on by default");
    }
    await pshot("5-advanced");
    await pickIn(page, "vs-adv-tts", "vs-picker", { label: "v4 Turbo" });
    await until(async () => (await voiceSettings(page)).ttsModel === "eleven_v4_turbo");
    await pickIn(page, "vs-adv-tts", "vs-picker", { label: "Multilingual v2" });
    await pickIn(page, "vs-adv-language", "vs-picker", { search: "croat", label: "Croatian" });
    await pickIn(page, "vs-adv-pause", "vs-picker", { label: "2.0 s" });
    await pickIn(page, "vs-adv-speed", "vs-picker", { label: "1.2×" });
    await press(page, switchOf("vs-adv-skipcode"));
    await until(async () => (await voiceSettings(page)).skipCode === false);
    const s2 = await voiceSettings(page);
    if (s2.ttsModel !== "eleven_multilingual_v2" || s2.language !== "hr" || s2.pauseMs !== 2000 || s2.speed !== 1.2 || s2.skipCode !== false || s2.autoSend !== false) fail(`the settings are ${J(s2)}`);
    {
      const rowsShown = {};
      for (const id of ["vs-adv-tts", "vs-adv-language", "vs-adv-pause", "vs-adv-speed"]) rowsShown[id] = await cellValue(id);
      if (J(rowsShown) !== J({ "vs-adv-tts": "Multilingual v2", "vs-adv-language": "Croatian", "vs-adv-pause": "2.0 s", "vs-adv-speed": "1.2×" })) fail(`the rows after the picks are ${J(rowsShown)}`);
    }
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.voice.settings") ?? "null"));
    if (J(stored) !== J(s2)) fail(`the stored settings are ${J(stored)}, not what the page holds`);
    if (await page.evaluate((k) => Object.keys(localStorage).some((n) => n.includes(k) || (localStorage.getItem(n) ?? "").includes(k)), KEY)) fail("the key is in localStorage");
    await pshot("6-changed");

    // ---- readable (light)
    await floor("the Voice screen with a key (light)", '[data-testid="vs-screen"]');
    await press(page, byTid(page, "vs-adv-language").last());
    await sheetShown(page, "vs-picker");
    await floor("the Language sheet (light)", '[data-testid="vs-picker"]');
    await sheetPick("vs-picker", "Croatian");
    await sheetGone(page, "vs-picker");

    // ---- remove
    await press(page, byTid(page, "vs-key-remove").last());
    await sheetShown(page, "vs-remove-confirm");
    await pshot("7a-remove-ask", "vs-remove-confirm");
    await press(page, byTid(page, "confirm-cancel").last());
    await sheetGone(page, "vs-remove-confirm");
    if (!(await byTid(page, "vs-key-remove").count()) || (await voiceKeyState(page)) !== "saved") fail("Cancel removed the key");
    await press(page, byTid(page, "vs-key-remove").last());
    await sheetShown(page, "vs-remove-confirm");
    await press(page, byTid(page, "confirm-go").last());
    await sheetGone(page, "vs-remove-confirm");
    await until(async () => (await voiceKeyState(page)) === "none", 15000);
    if (await byTid(page, "vs-key-remove").count()) fail("Remove key is still offered after the key was removed");
    if (!(await byTid(page, "vs-voice-nokey").count()) || !(await byTid(page, "vs-nokey-card").count())) fail("the voices stay after the key was removed");
    await openAddKey(page);
    await press(page, byTid(page, "vs-key-test").last());
    if (!await until(async () => /key/.test(await resultText()), 15000) || !(await resultText()).includes("Voice needs your ElevenLabs key. It stays on this device.")) fail(`Test key finds a key after it was removed: ${J(await resultText())}`);
    await closeSheet(page, "vs-key-sheet");
    await pshot("7-removed");

    // ---- the stand-in saw the key as a header only; nothing else of the log carries it
    if (J(await log()).includes("CANARY")) fail("a key reached the stand-in's log in a place other than its header (the log holds `keyHeader` only)");

    // ---- a reload: the key is gone (web), the settings stay
    await page.reload();
    await page.waitForSelector('[data-testid="home"]', { timeout: 30000 });
    await openVoice(page);
    if ((await voiceKeyState(page)) !== "none") fail("the key survived a reload (the web build keeps it in memory only)");
    {
      const s3 = await voiceSettings(page);
      if (J(s3) !== J(s2)) fail(`the settings after a reload are ${J(s3)}, not ${J(s2)}`);
    }
    await reopen(() => page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY));
    if ((await switchOf("vs-autosend").getAttribute("aria-checked")) !== "false") fail("the Auto-send switch does not show what was kept");
    if ((await cellValue("vs-adv-language")) !== "Croatian") fail(`the language kept over a reload shows ${J(await cellValue("vs-adv-language"))}`);
    // Back leaves it (the stack's way, in place of Esc)
    await press(page, byTid(page, "nav-back").last());
    await atRestId(page, "settings-screen");
    if ((await stackNames(page)).join() !== "home,settings") fail(`Back from the Voice screen left [${(await stackNames(page)).join(", ")}]`);

    // ---- a rejected key that is stored: Choose voice says so, with a way to try again
    await page.evaluate((k) => window.__aiwbVoice.setKey(k), BAD);
    await openVoice(page);
    await openChooseVoice(page);
    if (!await until(() => byTid(page, "cv-failed").count(), 15000)) fail("a stored key the service rejects shows no failure in the voices");
    else {
      if ((await textOf(byTid(page, "cv-failed"))) !== "ElevenLabs did not accept this key.Try again") fail(`the failed list says ${J(await textOf(byTid(page, "cv-failed")))}`);
      await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
      await press(page, byTid(page, "cv-retry").last());
      if (!await until(() => byTid(page, "cv-row").count(), 15000)) fail("Try again did not bring the voices once the key worked");
    }
    await pshot("8-retried", "cv-screen");
    await context.close();

    // ---- a dark flavour keeps the floor too
    const dark = await open({ ls: { "aiwb.theme": "mocha" } });
    const dp = dark.page;
    await dp.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
    await openVoice(dp);
    await floor("the Voice screen in Mocha", '[data-testid="vs-screen"]', dp);
    await openAddKey(dp);
    await floor("Add key in Mocha", '[data-testid="vs-key-sheet"]', dp);
    await closeSheet(dp, "vs-key-sheet");
    await openChooseVoice(dp);
    await voicesLoaded(dp);
    await floor("Choose voice in Mocha", '[data-testid="cv-screen"]', dp);
    await pshot("9-mocha", "cv-screen", dp);

    note("the gear pushing the Voice screen, the no-key card (nothing offered, no request, no device call), Add key (hidden box, the eye, Test key with no key, rejected and working, Save), Choose voice (the first four with a few words, the mark, a pick, the sample with no TTS, the problem on the row, Show all, the search), the devices in their sheets (listed only while open: the permission by Test microphone, the meter, picks, plug and unplug, \"(not connected)\", Test speaker with no request), Auto-send and the Advanced rows kept over a reload, Remove, the stored rejected key, the contrast floor in the light theme and in Mocha");
  };

  // ---- the stand-in devices of the card (devices.mjs): in the page from its next load on
  await installDevices(context);
  await page.reload();
  // (the phone has Home, with no sidebar and no foot: its half starts from Home; the foot and its order are the wide layouts')
  if (!wide) {
    await page.waitForSelector('[data-testid="home"]', { timeout: 30000 });
    if (await byTid(page, "settings-btn").count() || await byTid(page, "side-foot").count()) fail("the phone's Home draws the sidebar's foot");
    if (!await byTid(page, "home-gear").first().isVisible()) fail("Home's gear is not shown");
    await phoneHalf();
    return;
  }
  await page.waitForSelector('[data-testid="settings-btn"]', { timeout: 30000 });

  // ---- the foot
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="side-foot"] [data-testid]')].map((e) => e.dataset.testid).filter((id) => ["servers-btn", "library-btn", "settings-btn", "theme-btn"].includes(id)));
  if (order.join() !== "servers-btn,library-btn,settings-btn,theme-btn") fail(`the foot's buttons are ${order.join()}, not Servers, library, Settings, theme`);
  if (await page.evaluate(() => document.querySelector('[data-testid="settings-btn"]')?.getAttribute("title")) !== "Settings") fail("the Settings button is not titled \"Settings\"");
  if (await byTid(page, "settings-dialog").count()) fail("the Settings page is open before the button is pressed");

  // ---- the page, with no key
  await openPage(page);
  const order2 = await page.evaluate(() => ["vs-key-section", "vs-voices-section", "vs-devices-section", "vs-autosend-section", "vs-advanced-section"].map((id) => { const e = document.querySelector(`[data-testid="${id}"]`); return e ? Math.round(e.getBoundingClientRect().top) : null; }));
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

  // ---- the devices (voice-devices D8)
  const dev = (fn, ...args) => page.evaluate(([f, a]) => window.__aiwbDevices[f](...a), [fn, args]);
  const menuTexts = async (p, picker) => {
    await press(p, byTid(p, picker));
    await shown(byTid(p, "menu-item"));
    const items = (await byTid(p, "menu-item").allTextContents()).map((x) => x.replace(/✓/g, "").trim());
    await p.keyboard.press("Escape");
    await gone(byTid(p, "menu"));
    return items;
  };
  const pickShown = async (picker) => (await textOf(byTid(page, picker))).replace(/▾/g, "").trim();
  const box = (id) => page.evaluate((x) => { const r = document.querySelector(`[data-testid="${x}"]`).getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) }; }, id);
  const rect = await box("vs-devices-section");
  const rectVoices = await box("vs-voices-section");
  if (rect.left !== rectVoices.left || rect.width !== rectVoices.width) fail(`the devices card is not laid out like the voices card (${JSON.stringify(rect)} against ${JSON.stringify(rectVoices)})`);
  const radius = await byTid(page, "vs-devices-section").evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
  if (radius !== card) fail(`the devices card is rounded ${radius}px, the key's ${card}px`);
  if ((await textOf(byTid(page, "vs-devices-section").locator('[role="heading"]'))) !== "Microphone and speaker") fail("the devices card has no title \"Microphone and speaker\"");
  if (await byTid(page, "vs-devices-neither").count()) fail("the card says the system decides when the page can choose");
  // no key: voice is not set up, so the card offers nothing and lists nothing (goal 6.6), and says why, as the voices' section does
  if ((await textOf(byTid(page, "vs-devices-nokey"))) !== "Add your key to choose a microphone and a speaker.") fail(`with no key the devices card says "${await textOf(byTid(page, "vs-devices-nokey"))}"`);
  for (const id of ["vs-mic", "vs-speaker", "vs-mic-test", "vs-speaker-test", "vs-devices-note"]) if (await byTid(page, id).count()) fail(`${id} is offered with no key saved`);
  await sleep(1000);
  if (JSON.stringify(await dev("calls")) !== JSON.stringify({ enumerateDevices: 0, getUserMedia: 0, setSinkId: 0 })) fail(`Settings with no key made device calls: ${JSON.stringify(await dev("calls"))}`);
  await shot(page, "1-devices-nokey");
  // the key set (from outside, as a saved one is): the pickers come on the next opening
  await close(page);
  await page.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
  await openPage(page);
  // before the microphone is allowed: System default alone, the note says why, no meter, no microphone opened
  if ((await pickShown("vs-mic")) !== "System default" || (await pickShown("vs-speaker")) !== "System default") fail(`before the permission the pickers show "${await pickShown("vs-mic")}" and "${await pickShown("vs-speaker")}"`);
  if ((await textOf(byTid(page, "vs-devices-note"))) !== "Allow the microphone to see your other devices.") fail(`the note before the permission says "${await textOf(byTid(page, "vs-devices-note"))}"`);
  if ((await menuTexts(page, "vs-mic")).length !== 1) fail("before the permission the microphone picker lists more than System default");
  if (await byTid(page, "vs-mic-level").count()) fail("the meter is drawn before the tap");
  if ((await dev("calls")).getUserMedia !== 0) fail("opening Settings asked for the microphone");
  await shot(page, "1a-devices-before");
  // Test microphone: the permission is the person's tap; the lists fill; the meter moves
  await press(page, byTid(page, "vs-mic-test"));
  if (!await shown(byTid(page, "vs-mic-level"))) fail("Test microphone drew no meter");
  if (await byTid(page, "vs-mic-test").getAttribute("aria-pressed") !== "true" || (await textOf(byTid(page, "vs-mic-test"))) !== "End test") fail(`the test button says "${await textOf(byTid(page, "vs-mic-test"))}" while it runs`);
  await until(async () => (await menuTexts(page, "vs-mic")).length === 3, 15000);
  const micItems = await menuTexts(page, "vs-mic");
  if (!/^System default/.test(micItems[0] ?? "") || !micItems.includes("Desk Mic") || !micItems.includes("Stand-in Headset")) fail(`the microphones listed are ${JSON.stringify(micItems)}`);
  const spItems = await menuTexts(page, "vs-speaker");
  if (!/^System default/.test(spItems[0] ?? "") || !spItems.includes("Desk Speakers") || !spItems.includes("Stand-in Headphones")) fail(`the speakers listed are ${JSON.stringify(spItems)}`);
  if (await byTid(page, "vs-devices-note").count()) fail("the note stays after the microphone was allowed");
  if (!await until(async () => Number(await byTid(page, "vs-mic-level").getAttribute("data-peak")) > 0, 15000)) fail("the meter never moved while the test ran");
  await shot(page, "1b-devices-testing");
  // a different microphone: the test goes on with it
  await pick(page, "vs-mic", "Stand-in Headset");
  await until(async () => (await settings(page)).mic?.id === "mic-headset");
  if ((await settings(page)).mic?.name !== "Stand-in Headset") fail(`the pick is kept as ${JSON.stringify((await settings(page)).mic)}`);
  if (await byTid(page, "vs-mic").getAttribute("data-value") !== "d:mic-headset") fail("the picker does not show the pick");
  if (!await until(async () => (await dev("opened")).at(-1)?.deviceId === "mic-headset" && (await dev("opened")).at(-1)?.live, 15000)) fail(`the test did not go on with the microphone picked (opened: ${JSON.stringify(await dev("opened"))})`);
  // a second tap stops it, with the microphone released
  await press(page, byTid(page, "vs-mic-test"));
  if (!await gone(byTid(page, "vs-mic-level"))) fail("the meter stays after End test");
  if ((await dev("opened")).some((o) => o.live)) fail("a microphone stays open after End test");
  if ((await textOf(byTid(page, "vs-mic-test"))) !== "Test microphone") fail("the test button does not go back to \"Test microphone\"");
  // Test speaker: no key, no request of the voice service, played on the chosen sink
  await pick(page, "vs-speaker", "Stand-in Headphones");
  await until(async () => (await settings(page)).speaker?.id === "out-headphones");
  await mockEval("voice.reset();", url);
  await press(page, byTid(page, "vs-speaker-test"));
  if (!await until(async () => (await dev("sinks")).some((x) => x.sinkId === "out-headphones"), 15000)) fail(`Test speaker did not play on the speaker picked (sinks: ${JSON.stringify(await dev("sinks"))})`);
  await until(async () => (await byTid(page, "vs-speaker-test").getAttribute("data-playing")) === "false", 15000);
  if ((await log()).length) fail(`Test speaker made a request of the voice service: ${JSON.stringify(await log())}`);
  // plugged in while Settings is open: listed without reopening; a saved device unplugged: shown "(not connected)", still saved
  await dev("plug", { kind: "input", id: "mic-usb", label: "USB Mic", hz: 500 });
  if (!await until(async () => (await menuTexts(page, "vs-mic")).includes("USB Mic"), 15000)) fail("a microphone plugged in while Settings is open is not listed");
  await dev("unplug", "mic-headset");
  if (!await until(async () => (await pickShown("vs-mic")) === "Stand-in Headset (not connected)", 15000)) fail(`the unplugged microphone shows "${await pickShown("vs-mic")}"`);
  if ((await settings(page)).mic?.id !== "mic-headset") fail("unplugging the saved microphone changed the saved choice");
  await dev("plug", { kind: "input", id: "mic-headset", label: "Stand-in Headset", hz: 700 });
  if (!await until(async () => (await pickShown("vs-mic")) === "Stand-in Headset", 15000)) fail("the microphone does not come back to the picker when it is plugged in again");
  await shot(page, "1c-devices");
  // System default again; the test ends with Settings
  await pick(page, "vs-mic", "System default");
  await until(async () => (await settings(page)).mic === null);
  await press(page, byTid(page, "vs-mic-test"));
  await shown(byTid(page, "vs-mic-level"));
  await close(page);
  if (!await until(async () => !(await dev("opened")).some((o) => o.live), 15000)) fail("the microphone test goes on after Settings was closed");
  await openPage(page);
  if (await byTid(page, "vs-mic-level").count()) fail("the meter is drawn when Settings opens again");
  for (const r of (await contrastAudit(page, { only: ['[data-testid="vs-devices-section"]'] })).filter((r) => r.ratio < FLOOR)) fail(`the devices card: "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1`);
  await pick(page, "vs-speaker", "System default");
  await until(async () => (await settings(page)).speaker === null);
  await close(page);
  await page.evaluate(() => window.__aiwbVoice.clearKey()); // (the key's part below starts with none)
  await openPage(page);

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

  note(`the foot's gear, the page ${wide ? "as a dialog" : "as a sheet"} with the five sections and Advanced options collapsed, the Microphone and speaker card (stand-in devices: the permission by Test microphone, the lists, the meter, picks, plug and unplug, Test speaker with no request), Test key (no key, rejected, working), Save, Show, ${rows.length} voices with their previews and the problem popover, Show all and the search, the settings kept over a reload, Remove, the contrast floor`);
}, { viewports });
