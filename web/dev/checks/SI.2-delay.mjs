// SI.2 (new, small-improvements package d1): the delay before send as a slider in Settings > Voice, on the mock with the stand-in voice service mounted
// at /voice (dev/voicestandin.mjs; no ElevenLabs), at the desktop and the tablet (the Settings dialog, Advanced options) and the phone (the pushed Voice
// screen, the Advanced group), in the light and the dark theme. Small-improvements goal 3.2, 3.4, 4.6, 6.2 (first two bullets), 6.4 (the delay's half;
// the max chats' slider is SI.3's and the timing in Speech mode is SI.2b's). The slider is `app/src/ui/Slider.tsx`, its root `vs-adv-pause` with
// `data-value` (milliseconds, live while a drag moves), `data-dragging`, and the parts `-track` (role slider), `-handle`, `-value`, `-min`, `-max`,
// `-minus`, `-plus`, `-mark`; `slider.mjs` reads and moves it.
//   the ends       "0.1 s" and "10.0 s" under the track's ends (`-min`, `-max`), `aria-valuemin` 100 and `aria-valuemax` 10000, the value at the right ("1.2 s"
//                  by default) and the mark (`-mark`) at 1.2 s, where the handle's centre is when the value is 1.2 s; the text keeps the contrast floor of
//                  3:1 in both themes, nothing overlaps (− track + value) and nothing leaves the dialog or the screen
//   a drag         by the mouse (desktop) and by a finger (tablet, phone): the value text and `data-value` follow the handle LIVE, read in the
//                  middle of the drag before the release, only in steps of 0.1 s, and nothing is stored until the release; 4.7 s is reached and kept
//   the ways       (the mouse on the desktop, a finger on the tablet and the phone) 4.7 s by a drag, by a click or tap on the track, by the keyboard (Home, Page Up ×4, → ×6; from 4.6 one →; ↑ and ↓; End and Page Down) and by
//                  − and + (and − is off at 0.1 s, + at 10.0 s); each time the stored `aiwb.voice.settings` has `pauseMs: 4700`; it survives closing
//                  Settings and opening it again, and a reload of the page (the web build's restart)
//   saved before   600, 2000 and 3000 read "0.6 s", "2.0 s", "3.0 s" (nothing rescaled); 50 reads "0.1 s" and 99999 "10.0 s" (brought into range); 1250 is
//                  kept as it is (shown "1.3 s"), and the first step from it lands on the steps
//   the finger     (touch) a drag along the slider moves it and the Voice screen does not scroll; a vertical swipe that starts on the slider scrolls the
//                  screen and moves nothing; the target is 44 pt tall and − and + are 44 × 44 on the phone
//   a drag leaves  a drag that goes off the slider (past its ends, up, down, over the dialog's backdrop) keeps the handle (`data-dragging`), follows the
//                  pointer's x, and the release commits; the dialog stays open and the phone's stack stays where it was
//   the focus      reached by Tab, the track has the app's ring (2 px, `--focus-ring`, outside the track); a mouse press leaves none
// OUT=/tmp/x keeps screenshots (SI.2-<viewport>-<theme>-<state>.png: the page and the row), for a person's look.
import fs from "node:fs";
import path from "node:path";
import { atRest as atRestPage, check, contrastAudit, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";
import { atRest } from "./settings.mjs";
import { PAUSE, pauseOf, setByKeys, sliderKeys, sliderNow, sliderPoint, sliderRead, xOnTrack } from "./slider.mjs";
import { openVoice, stackNames, voiceSettings } from "./voicephone.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const OUT = process.env.OUT;
const KEY = "sk_test_SI2CANARY1";
const ID = PAUSE.id;
const FLOOR = 3;
const J = JSON.stringify;
const fmt = (ms) => `${(ms / 1000).toFixed(1)} s`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const frame = (p) => p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));

await check("SI.2 the delay before send: a slider from 0.1 s to 10 s in Settings > Voice (ends, steps, live value, mouse, finger, tap, keys, − and +, kept, old values)", async ({ viewport, layout, touch, open, fail, note }) => {
  const wide = layout !== "phone";
  // (a mouse only where the window has one: Chromium's mobile emulation, which the tablet and the phone are, gives a mouse's events an offset of its own, 20 px off
  // on the tablet, and leaves the next tap wrong too: the tablet's pointer here is the finger, as on an iPad without a trackpad)
  const modes = touch ? ["finger"] : ["mouse"];
  const dialog = (p) => byTid(p, "settings-dialog");
  const shown = (loc, ms = 15000) => until(() => loc.first().isVisible().catch(() => false), ms);
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.voice.settings") ?? "null"));
  const live = (p) => p.evaluate(() => window.__aiwbVoice.settings());
  const box = (loc) => loc.last().boundingBox();
  const shot = async (p, theme, name) => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await frame(p);
    const base = path.join(OUT, `SI.2-${viewport}-${theme}-${name}`);
    await p.screenshot({ path: `${base}.png` });
    const part = wide ? byTid(p, "vs-advanced-body").last() : byTid(p, ID).last().locator("xpath=..");
    await part.screenshot({ path: `${base}-row.png` }).catch(() => {});
  };

  // ---- a page with a key (in memory: the web build) and the delay's slider on screen
  // (nothing saved for the delay is the default: `shape` starts so; every other scene saves 1.2 s as a person's Settings has, so that "stored" is a number)
  const settingsOf = (pauseMs) => J({ autoSend: true, ...(pauseMs === null ? {} : { pauseMs: pauseMs ?? 1200 }) });
  const keyIn = async (p) => {
    await p.waitForFunction(() => !!window.__aiwbVoice && !!window.__aiwbVoice.setKey, null, { timeout: 30000 });
    await p.evaluate((k) => window.__aiwbVoice.setKey(k), KEY);
  };
  const openPause = async (p) => {
    if (wide) {
      await press(p, byTid(p, "settings-btn").first());
      if (!await shown(dialog(p))) throw new Error("the Settings button opened no dialog");
      if (!await byTid(p, "vs-advanced-body").count()) await press(p, byTid(p, "vs-advanced"));
      if (!await shown(byTid(p, "vs-advanced-body"))) throw new Error("Advanced options did not open");
    } else await openVoice(p);
    await atRest(p, ID);
  };
  const closeSettings = async (p) => {
    if (wide) { await press(p, byTid(p, "vs-close")); if (!await gone(dialog(p))) fail("Close left the Settings dialog open"); return; }
    for (let i = 0; i < 4 && (await stackNames(p)).at(-1) !== "settings"; i++) await press(p, byTid(p, "nav-back").last());
  };
  const session = async ({ pauseMs, theme = "light" } = {}) => {
    const ls = { "aiwb.voice.settings": settingsOf(pauseMs), ...(theme === "dark" ? { "aiwb.theme": "dark" } : {}) };
    const o = await open({ ls });
    await keyIn(o.page);
    await openPause(o.page);
    return o;
  };
  const reloaded = async (p) => {
    await p.reload();
    await p.waitForSelector('[data-testid="app-root"]', { timeout: 30000 });
    await keyIn(p);
  };

  /** The state of the slider is `ms` everywhere: the slider (data-value, the text, aria), the voice setting and the stored one. */
  const is = async (p, ms, what) => {
    if (!await until(async () => (await live(p)).pauseMs === ms && (await stored(p))?.pauseMs === ms, 5000)) fail(`${what}: the setting is ${J((await live(p)).pauseMs)} and the stored ${J((await stored(p))?.pauseMs)}, not ${ms}`);
    const r = await sliderRead(p, ID);
    if (r.value !== ms || r.text !== fmt(ms) || r.ariaNow !== ms || r.ariaText !== fmt(ms) || r.dragging) fail(`${what}: the slider shows ${J(r)}, not ${ms} (${fmt(ms)})`);
  };

  // ---- the pointer: a mouse, or a finger by the DevTools touch events
  const pointer = async (p, mode) => {
    if (mode === "mouse") return {
      down: async (q) => { await p.mouse.move(q.x, q.y); await p.mouse.down(); },
      move: (q) => p.mouse.move(q.x, q.y),
      up: () => p.mouse.up(),
      tap: (q) => p.mouse.click(q.x, q.y),
    };
    const c = await p.context().newCDPSession(p), at = (q) => [{ x: q.x, y: q.y, id: 1 }];
    return {
      down: (q) => c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(q) }),
      move: (q) => c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(q) }),
      up: () => c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
      tap: (q) => p.touchscreen.tap(q.x, q.y),
    };
  };
  const at = (p, ms) => sliderPoint(p, ID, ms);
  /** The distance on the page of one step, to correct a drag by. */
  const stepPx = async (p) => (await at(p, 200)).x - (await at(p, 100)).x;

  // ---- the shape: the ends, the mark, the value, the room, the contrast, in one theme
  const shape = async (theme) => {
    const o = await session({ theme, pauseMs: null });
    const p = o.page, tag = `${theme}`;
    if ((await p.evaluate(() => document.documentElement.dataset.theme)) !== theme) fail(`${tag}: the page is not in the ${theme} theme`);
    const r = await sliderRead(p, ID);
    if (r.value !== 1200 || r.text !== "1.2 s" || r.ariaNow !== 1200 || r.ariaText !== "1.2 s") fail(`${tag}: the default shows ${J(r)}, not 1.2 s`);
    if (r.min !== "0.1 s" || r.max !== "10.0 s") fail(`${tag}: the ends read ${J(r.min)} and ${J(r.max)}, not "0.1 s" and "10.0 s"`);
    if (r.ariaMin !== 100 || r.ariaMax !== 10000) fail(`${tag}: aria-valuemin/max are ${r.ariaMin} and ${r.ariaMax}, not 100 and 10000`);
    const track = await box(byTid(p, ID + "-track")), handle = await box(byTid(p, ID + "-handle")), rad = handle.width / 2;
    const range = { min: PAUSE.min, max: PAUSE.max, r: rad };
    // (the handle's centre is where the value sits on the track area: padded by its radius)
    const hc = handle.x + rad;
    if (Math.abs(hc - xOnTrack(track, 1200, range)) > 1) fail(`${tag}: the handle at 1.2 s is centred at ${hc.toFixed(1)}, not ${xOnTrack(track, 1200, range).toFixed(1)}`);
    const mark = await box(byTid(p, ID + "-mark"));
    if (!mark) fail(`${tag}: no mark at 1.2 s`);
    else if (Math.abs(mark.x + mark.width / 2 - xOnTrack(track, 1200, range)) > 1) fail(`${tag}: the mark is centred at ${(mark.x + mark.width / 2).toFixed(1)}, not at 1.2 s (${xOnTrack(track, 1200, range).toFixed(1)})`);
    if (await byTid(p, ID + "-mark").count() !== 1) fail(`${tag}: ${await byTid(p, ID + "-mark").count()} marks`);
    // the ends' labels are under the track's ends, inside the slider, and the value does not touch the track or the buttons
    const lo = await box(byTid(p, ID + "-min")), hi = await box(byTid(p, ID + "-max"));
    if (lo.y < track.y + track.height - 1 || hi.y < track.y + track.height - 1) fail(`${tag}: the ends' labels are not under the track`);
    if (lo.x < track.x - 1 || lo.x > track.x + 2 * rad + 2) fail(`${tag}: "0.1 s" starts at ${lo.x.toFixed(1)}, not at the track's left end (${track.x.toFixed(1)}…${(track.x + 2 * rad).toFixed(1)})`);
    if (hi.x + hi.width > track.x + track.width + 1 || hi.x + hi.width < track.x + track.width - 2 * rad - 2) fail(`${tag}: "10.0 s" ends at ${(hi.x + hi.width).toFixed(1)}, not at the track's right end (${(track.x + track.width).toFixed(1)})`);
    const parts = {};
    for (const part of ["-minus", "-track", "-plus", "-value"]) parts[part] = await box(byTid(p, ID + part));
    const row = [parts["-minus"], parts["-track"], parts["-plus"], parts["-value"]];
    for (let i = 1; i < row.length; i++) if (row[i].x < row[i - 1].x + row[i - 1].width - 1) fail(`${tag}: ${["−", "track", "+", "value"][i]} overlaps ${["−", "track", "+", "value"][i - 1]} (${J(row[i])} over ${J(row[i - 1])})`);
    const rootBox = await box(byTid(p, ID)), win = p.viewportSize();
    if (rootBox.x < 0 || rootBox.x + rootBox.width > win.width + 0.5) fail(`${tag}: the slider leaves the screen: ${J(rootBox)}`);
    if (wide) {
      const d = await box(dialog(p));
      if (rootBox.x < d.x || rootBox.x + rootBox.width > d.x + d.width + 0.5) fail(`${tag}: the slider (${rootBox.x.toFixed(0)}…${(rootBox.x + rootBox.width).toFixed(0)}) leaves the dialog (${d.x.toFixed(0)}…${(d.x + d.width).toFixed(0)})`);
      const label = await box(byTid(p, "vs-advanced-body").last().getByText("Pause before auto-send", { exact: true }));
      // (the slider takes the row's whole width under its label: a track as wide as the card, not a 260 px one beside the label)
      if (!label || label.y + label.height > rootBox.y + 1) fail(`${tag}: the label "Pause before auto-send" (${label && label.y.toFixed(0)}+${label && label.height.toFixed(0)}) is not above the slider (starts ${rootBox.y.toFixed(0)})`);
      if (label && Math.abs(label.x - rootBox.x) > 1) fail(`${tag}: the slider starts at ${rootBox.x.toFixed(0)}, not under its label (${label.x.toFixed(0)})`);
      const body = await box(byTid(p, "vs-advanced-body").last());
      if (body && rootBox.width < body.width - 1) fail(`${tag}: the slider is ${rootBox.width.toFixed(0)} px wide, not the row's ${body.width.toFixed(0)}`);
      note(`${tag}: the slider is ${rootBox.width.toFixed(0)} px wide in the dialog (${d.width.toFixed(0)} px), the track ${track.width.toFixed(0)} px = ${(await stepPx(p)).toFixed(2)} px a step`);
    }
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail(`${tag}: the page scrolls sideways`);
    // the target sizes of the finger
    if (!wide) {
      if (track.height < 44 - 0.5) fail(`${tag}: the track's touch area is ${track.height.toFixed(1)} pt tall, under 44`);
      for (const part of ["-minus", "-plus"]) if (parts[part].width < 43.5 || parts[part].height < 43.5) fail(`${tag}: ${part} is ${parts[part].width.toFixed(1)} × ${parts[part].height.toFixed(1)} pt, under 44 × 44`);
    } else note(`${tag}: the track is ${track.height.toFixed(0)} px tall, − ${parts["-minus"].width.toFixed(0)} × ${parts["-minus"].height.toFixed(0)}, the handle ${handle.width.toFixed(0)} px`);
    // the text keeps the contrast floor
    for (const c of (await contrastAudit(p, { only: [tidSel(ID)] })).filter((c) => c.ratio < FLOOR)) fail(`${tag}: "${c.what}" is ${c.fg} on ${c.bg}, ${c.ratio}:1, under ${FLOOR}:1`);
    await shot(p, theme, "1-default");
    // the ends and a middle value, for the pictures
    await setByKeys(p, ID, 100);
    await is(p, 100, `${tag}: Home`);
    if ((await sliderRead(p, ID)).text !== "0.1 s") fail(`${tag}: at the left end the value reads ${(await sliderRead(p, ID)).text}`);
    if (!await byTid(p, ID + "-minus").last().isDisabled()) fail(`${tag}: − is on at 0.1 s`);
    if (await byTid(p, ID + "-plus").last().isDisabled()) fail(`${tag}: + is off at 0.1 s`);
    await shot(p, theme, "2-min");
    await setByKeys(p, ID, 10000);
    await is(p, 10000, `${tag}: End`);
    if ((await sliderRead(p, ID)).text !== "10.0 s") fail(`${tag}: at the right end the value reads ${(await sliderRead(p, ID)).text}`);
    if (await byTid(p, ID + "-minus").last().isDisabled()) fail(`${tag}: − is off at 10.0 s`);
    if (!await byTid(p, ID + "-plus").last().isDisabled()) fail(`${tag}: + is on at 10.0 s`);
    await shot(p, theme, "3-max");
    await setByKeys(p, ID, 4700);
    await is(p, 4700, `${tag}: 4.7 s`);
    await shot(p, theme, "4-mid");
    // a drag held for a picture
    const d = await pointer(p, modes[0]);
    await d.down(await at(p, 4700));
    await d.move(await at(p, 2300));
    await frame(p);
    await shot(p, theme, "5-held");
    await d.up();
    await is(p, 2300, `${tag}: a drag to 2.3 s`);
    await o.ctx.close();
  };

  // ---- 4.7 s by every way, and kept
  const ways = async () => {
    const o = await session();
    const p = o.page;
    const px = await stepPx(p);
    // a drag, live: the value follows the handle in steps of 0.1 s; nothing is stored until the release
    for (const mode of modes) {
      const tag = `${mode}'s drag`;
      await setByKeys(p, ID, mode === "mouse" ? 1200 : 8000);
      await is(p, mode === "mouse" ? 1200 : 8000, `${tag}: the start`);
      const from = (await sliderRead(p, ID)).value, d = await pointer(p, mode);
      const a = await at(p, from), b = await at(p, 4700), seen = [];
      await d.down(a);
      for (let i = 1; i <= 14; i++) {
        await d.move({ x: a.x + ((b.x - a.x) * i) / 14, y: a.y });
        await frame(p);
        seen.push(await sliderNow(p, ID));
      }
      for (let k = 0; k < 8 && seen.at(-1).value !== 4700; k++) { // (the last pixels: as a person does, watching the number)
        await d.move({ x: b.x + (4700 > seen.at(-1).value ? 1 : -1) * px * 0.55 * (k + 1), y: b.y });
        await frame(p);
        seen.push(await sliderNow(p, ID));
      }
      const mid = seen.at(-1);
      if (mid.value !== 4700 || mid.text !== "4.7 s" || !mid.dragging) fail(`${tag}: in the middle of the drag, at the target, the slider shows ${J(mid)}, not 4700 "4.7 s" dragging`);
      if (seen.some((s) => s.value % 100 !== 0 || s.value < 100 || s.value > 10000 || s.text !== fmt(s.value))) fail(`${tag}: a value off the steps or a text that is not the value: ${J(seen.filter((s) => s.value % 100 !== 0 || s.text !== fmt(s.value)))}`);
      const distinct = new Set(seen.map((s) => s.value));
      if (distinct.size < 4) fail(`${tag}: the value showed only ${[...distinct]} while the handle moved over ${Math.abs(4700 - from) / 100} steps`);
      if (seen.slice(1).some((s, i) => (from < 4700 ? s.value < seen[i].value : s.value > seen[i].value) && i < 12)) fail(`${tag}: the value went back while the handle went on: ${seen.map((s) => s.value)}`);
      if ((await live(p)).pauseMs !== from || (await stored(p))?.pauseMs !== from) fail(`${tag}: the setting changed before the release (${(await live(p)).pauseMs}, stored ${(await stored(p))?.pauseMs})`);
      if ((await sliderRead(p, ID)).ariaNow !== 4700) fail(`${tag}: aria-valuenow is ${(await sliderRead(p, ID)).ariaNow} in the middle of the drag, not 4700`);
      await d.up();
      await is(p, 4700, tag);
    }
    // a click or a tap on the track
    for (const mode of modes) {
      await setByKeys(p, ID, 10000);
      await is(p, 10000, `${mode}'s click: the start`);
      const d = await pointer(p, mode), c = await at(p, 4700);
      await d.tap(c);
      await is(p, 4700, `a ${mode === "mouse" ? "click" : "tap"} on the track`);
    }
    // the keyboard: Home, Page Up ×4, → ×6; from 4.6 one →; ↑ ↓; Page Down, End
    await sliderKeys(p, ID, ["Home"]);
    await is(p, 100, "Home");
    await sliderKeys(p, ID, ["PageUp", "PageUp", "PageUp", "PageUp"]);
    await is(p, 4100, "Page Up ×4");
    await sliderKeys(p, ID, ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    await is(p, 4700, "Home, Page Up ×4, → ×6");
    await sliderKeys(p, ID, ["ArrowLeft"]);
    await is(p, 4600, "←");
    await sliderKeys(p, ID, ["ArrowRight"]);
    await is(p, 4700, "from 4.6 s one →");
    await sliderKeys(p, ID, ["ArrowUp", "ArrowUp", "ArrowDown"]);
    await is(p, 4800, "↑ ↑ ↓");
    await sliderKeys(p, ID, ["PageDown"]);
    await is(p, 3800, "Page Down");
    await sliderKeys(p, ID, ["End"]);
    await is(p, 10000, "End");
    await sliderKeys(p, ID, ["ArrowRight"]);
    await is(p, 10000, "→ at the end (nothing to move)");
    // − and +
    await setByKeys(p, ID, 4600);
    await press(p, byTid(p, ID + "-plus").last());
    await is(p, 4700, "+ from 4.6 s");
    await setByKeys(p, ID, 4800);
    await press(p, byTid(p, ID + "-minus").last());
    await is(p, 4700, "− from 4.8 s");
    await press(p, byTid(p, ID + "-minus").last());
    await press(p, byTid(p, ID + "-plus").last());
    await is(p, 4700, "− then +");
    // kept: Settings closed and opened, then the page loaded anew
    await closeSettings(p);
    await openPause(p);
    await is(p, 4700, "Settings closed and opened again");
    await reloaded(p);
    if ((await live(p)).pauseMs !== 4700) fail(`after a reload the voice setting is ${(await live(p)).pauseMs}, not 4700`);
    await openPause(p);
    await is(p, 4700, "after a reload (the web build's restart)");
    await o.ctx.close();
  };

  // ---- values saved before this work, and out of range
  const old = async () => {
    const o = await session({ pauseMs: 600 });
    const p = o.page;
    const case_ = async (saved, shownValue, shownText, what) => {
      if (saved !== 600) {
        await closeSettings(p);
        await p.evaluate((v) => localStorage.setItem("aiwb.voice.settings", v), settingsOf(saved));
        await reloaded(p);
        await openPause(p);
      }
      const r = await sliderRead(p, ID);
      if (r.value !== shownValue || r.text !== shownText) fail(`${what}: ${saved} is shown as ${J(r.text)} (${r.value}), not ${J(shownText)} (${shownValue})`);
      if (saved >= 100 && saved <= 10000 && (await live(p)).pauseMs !== saved) fail(`${what}: the setting is ${(await live(p)).pauseMs}, not ${saved} as saved`);
      if (saved >= 100 && saved <= 10000 && (await stored(p))?.pauseMs !== saved) fail(`${what}: the stored setting was changed to ${(await stored(p))?.pauseMs} by looking`);
      return r;
    };
    await case_(600, 600, "0.6 s", "saved before");
    await case_(2000, 2000, "2.0 s", "saved before");
    await case_(3000, 3000, "3.0 s", "saved before");
    await case_(50, 100, "0.1 s", "below the range");
    await case_(99999, 10000, "10.0 s", "above the range");
    const r = await case_(1250, 1250, fmt(1250), "off the steps");
    note(`1250 is shown as "${r.text}" (data-value ${r.value}, aria-valuenow ${r.ariaNow}), not snapped`);
    await sliderKeys(p, ID, ["ArrowRight"]);
    const after = (await live(p)).pauseMs;
    note(`→ from 1250 gives ${after} (${after % 100 === 0 ? "on the steps" : "OFF the steps"})`);
    if (after % 100 !== 0) fail(`a step from the saved 1250 lands on ${after}, off the steps`);
    await o.ctx.close();
  };

  // ---- the finger: along does not scroll, across scrolls, the target
  const finger = async () => {
    const o = await session();
    const p = o.page;
    const d = await pointer(p, "finger");
    const scroller = () => byTid(p, ID).last().evaluate((e) => { for (let n = e.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return { top: n.scrollTop, max: n.scrollHeight - n.clientHeight }; return { top: 0, max: 0 }; });
    if ((await scroller()).max < 80) fail(`what the slider is in (the ${wide ? "dialog" : "Voice screen"}) does not scroll (${J(await scroller())}): the test of the swipe means nothing`);
    // sideways, with a little drift up and down (under the 10 pt that makes it a scroll)
    const before = await scroller(), a = await at(p, 1200), b = await at(p, 7300);
    await d.down(a);
    for (let i = 1; i <= 12; i++) { await d.move({ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + (i % 2 ? 4 : -4) }); await frame(p); }
    const mid = await sliderNow(p, ID);
    if (mid.value !== 7300 && Math.abs(mid.value - 7300) > 100) fail(`the finger's sideways drag shows ${J(mid)} at 7.3 s`);
    if (!mid.dragging) fail("the finger's sideways drag is not dragging");
    await d.up();
    await sleep(300);
    if (!await until(async () => (await live(p)).pauseMs > 7000, 5000)) fail(`the finger's sideways drag stored ${(await live(p)).pauseMs}, not about 7300`);
    const after = await scroller();
    if (after.top !== before.top) fail(`a sideways drag on the slider scrolled what it is in: ${before.top} → ${after.top}`);
    const kept = (await live(p)).pauseMs;
    // across: a vertical swipe that starts on the slider scrolls the screen and moves nothing (the screen is scrolled to its start first)
    {
      await byTid(p, ID).last().evaluate((e) => { for (let n = e.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) { n.scrollTop = 0; return; } });
      await sleep(200);
      const start = await scroller();
      const t0 = await box(byTid(p, ID + "-track"));
      await d.down({ x: t0.x + t0.width / 2, y: t0.y + t0.height / 2 });
      for (let i = 1; i <= 12; i++) { await d.move({ x: t0.x + t0.width / 2, y: t0.y + t0.height / 2 - (i * 200) / 12 }); await sleep(8); }
      await d.up();
      if (!await until(async () => (await scroller()).top > start.top + 40, 8000)) fail(`a vertical swipe that starts on the slider did not scroll what it is in (${start.top} → ${(await scroller()).top})`);
      if ((await live(p)).pauseMs !== kept) fail(`a vertical swipe on the slider moved it: ${kept} → ${(await live(p)).pauseMs}`);
    }
    await o.ctx.close();
  };

  // ---- a drag that leaves the slider keeps the handle until the release
  const leaves = async (mode) => {
    const o = await session();
    const p = o.page, tag = `${mode}'s drag that leaves`;
    const d = await pointer(p, mode), px = await stepPx(p);
    const start = await at(p, 1200), win = p.viewportSize();
    await setByKeys(p, ID, 1200);
    await d.down(start);
    const track = await box(byTid(p, ID + "-track"));
    // far to the right and down, off the slider (past its end)
    const far = { x: Math.min(win.width - 2, track.x + track.width + 120), y: Math.min(win.height - 4, track.y + 160) };
    for (let i = 1; i <= 3; i++) { await d.move({ x: start.x + 10 * i, y: start.y }); await frame(p); } // (sideways first: the drag begins, a move up or down at once would be a scroll)
    const turn = { x: start.x + 30, y: start.y };
    for (let i = 1; i <= 8; i++) { await d.move({ x: turn.x + ((far.x - turn.x) * i) / 8, y: turn.y + ((far.y - turn.y) * i) / 8 }); await frame(p); }
    let now = await sliderNow(p, ID);
    if (now.value !== 10000 || !now.dragging) fail(`${tag}: beyond the right end, below the slider, it shows ${J(now)}, not 10000 held`);
    // back over the dialog's backdrop (wide) or the rest of the screen (phone), at the x of 2.0 s: the handle follows the x
    let out;
    if (wide) {
      const dlg = await box(dialog(p));
      const x2 = (await at(p, 2000)).x;
      const cands = [{ x: x2, y: dlg.y - 12 }, { x: x2, y: dlg.y + dlg.height + 12 }].filter((q) => q.y > 2 && q.y < win.height - 2);
      out = cands[0];
      if (!out) { out = { x: dlg.x - 12, y: dlg.y + 20 }; note(`${tag}: no room above or below the dialog; released to its left (the x is the backdrop's)`); }
    } else out = { x: (await at(p, 2000)).x, y: Math.min(win.height - 10, track.y + track.height + 220) };
    for (let i = 1; i <= 8; i++) { await d.move({ x: far.x + ((out.x - far.x) * i) / 8, y: far.y + ((out.y - far.y) * i) / 8 }); await frame(p); }
    for (let k = 0; k < 8; k++) { // (corrected to the step at the x of 2.0 s)
      now = await sliderNow(p, ID);
      if (now.value === 2000 || !out.x) break;
      out = { x: out.x + (2000 > now.value ? 1 : -1) * px * 0.55, y: out.y };
      await d.move(out); await frame(p);
    }
    now = await sliderNow(p, ID);
    if (now.value !== 2000 || !now.dragging) fail(`${tag}: outside the slider at the x of 2.0 s it shows ${J(now)}, not 2000 held`);
    if (wide && !(await dialog(p).count())) fail(`${tag}: the dialog closed during the drag`);
    await shot(p, "light", `6-left-${mode}`);
    await d.up();
    await sleep(300);
    if (wide && !await shown(dialog(p), 3000)) fail(`${tag}: the Settings dialog closed when the drag was released over its backdrop`);
    if (!wide && (await stackNames(p)).join() !== "home,settings,voice-settings") fail(`${tag}: the stack is [${(await stackNames(p)).join(", ")}] after the release`);
    await is(p, 2000, `${tag}: released outside`);
    await o.ctx.close();
  };

  // ---- the focus ring by Tab
  const focus = async () => {
    const o = await session();
    const p = o.page;
    await setByKeys(p, ID, 1200);
    await p.evaluate(() => document.activeElement?.blur?.());
    let on = false;
    const isTrack = () => p.evaluate((id) => document.activeElement === [...document.querySelectorAll(`[data-testid="${id}-track"]`)].pop(), ID);
    // (start from the control before: the Language row's picker, or the document)
    await byTid(p, wide ? "vs-adv-language" : "vs-adv-language").last().focus().catch(() => {});
    for (let i = 0; i < 6 && !on; i++) { await p.keyboard.press("Tab"); on = await isTrack(); }
    if (!on) { fail("Tab never reached the slider's track after the Language row"); await o.ctx.close(); return; }
    const ring = await byTid(p, ID + "-track").last().evaluate((e) => {
      const c = getComputedStyle(e), v = getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim();
      const probe = document.createElement("i"); probe.style.color = v; document.body.append(probe);
      const want = getComputedStyle(probe).color; probe.remove();
      return { focusVisible: e.matches(":focus-visible"), style: c.outlineStyle, width: c.outlineWidth, offset: c.outlineOffset, color: c.outlineColor, want };
    });
    if (!ring.focusVisible || ring.style !== "solid" || ring.width !== "2px" || ring.color !== ring.want) fail(`the focused track's ring is ${J(ring)}, not a solid 2px outline in --focus-ring`);
    await shot(p, "light", "7-focus");
    await p.keyboard.press("ArrowRight");
    await is(p, 1300, "a key on the focused track");
    // a press with the mouse leaves no ring
    if (modes.includes("mouse")) {
      await p.evaluate(() => document.activeElement?.blur?.());
      const c = await at(p, 5000);
      await p.mouse.click(c.x, c.y);
      await is(p, 5000, "a click");
      const after = await byTid(p, ID + "-track").last().evaluate((e) => ({ focusVisible: e.matches(":focus-visible"), style: getComputedStyle(e).outlineStyle }));
      if (after.focusVisible || after.style !== "none") fail(`a mouse press left a ring on the track: ${J(after)}`);
    }
    await o.ctx.close();
  };

  await shape("light");
  await shape("dark");
  await ways();
  await old();
  if (touch) await finger();
  for (const mode of modes) await leaves(mode);
  await focus();
  void atRestPage;
  note(`the ends, the mark, the value, the room and the contrast in both themes; 4.7 s by ${modes.map((m) => (m === "mouse" ? "the mouse" : "a finger")).join(" and ")}, a click or tap, the keys and − and +, kept over a close and a reload; the old values; a drag that leaves; the focus ring${touch ? "; the finger along and across" : ""}`);
}, { viewports, page: false });
