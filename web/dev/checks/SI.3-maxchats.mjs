// SI.3-maxchats (small-improvements goal 3.3 and 3.4; checks 6.3 and 6.4, risks 7.5 and 7.6; plans/small-improvements/sliders.md): "Running at once", the
// chat's max chats, is a slider from 1 to 100 in the Subagents popover of the composer's chip (the desktop and the tablet, a new chat in a page of 900 and
// 810 px) and in the phone's Subagents sheet (the phone), each in light and dark; depth stays a list. On the mock's section A2 (`plain-new`, `c_A2_new`);
// the page's calls are read with `callsOf` as S1.1 and L19 read them, the chat's state in the mock. What it proves, per viewport and theme:
//   1 ends, value    the ends are labelled "1" and "100" (`sub-cap-min`, `-max`) and are aria-valuemin/max; the value beside the track (`-value`) and the root's
//                    data-value, and the track's aria-valuenow/text, are the chat's: a chat that an API client gave a max of 3 shows 3 and the chip
//                    says "1 level · 3 at once" (a bare "1 level" at the default 100, goal 3.3); the roles: the track is role slider, −/+ are buttons.
//   2 set            1, 37 and 100 set by a mouse drag, by a click or tap on the track and by the keyboard (Home → 1, End → 100, 36 then one → → 37; Page Up
//                    and Page Down move 10) each make exactly ONE PATCH of the chat with that exact `subCap` and no other, the mock's chat keeps it, the slider
//                    and the chip follow ("1 level · 37 at once", the title "Subagents — 1 level, at most 37 running at once — …"; at 100 the label leaves the cap
//                    out). On the tablet and the phone also with a finger (touch events), which is a different pointer (the slider's size follows the last
//                    pointer: a 14 px handle for a mouse, 24 for a finger, so the geometry is read again before every move).
//   3 live, one call a drag, mid-drag, before the release, `data-value`, the value text and aria-valuenow are the number under the handle, the handle is under
//                    the pointer, `data-dragging` is true and no call has been made; one drag from 100 to 5 through 30 moves and 20+ different numbers makes one call.
//   4 leaves         a drag whose pointer goes out of the slider to the popover's backdrop (the sheet's: above the sheet), back over it and out again, and is
//                    released outside, keeps moving the handle (its value follows the pointer's x each time), ends in one call with the value at the release, and
//                    the popover or the sheet is still open (goal 3.4, 7.5).
//   5 − and +        change by one, one call each, and are disabled at the ends (1 and 100) where a forced press makes no call.
//   6 finger         at the phone: the slider's touch area, − and + are at least 44 px high; with the sheet made to scroll (a window 430 px high) a sideways drag
//                    on the slider moves it and the sheet's scroll position stays, a vertical one that starts on the slider scrolls the sheet and moves nothing
//                    (6.4). (If the sheet at a viewport has nothing to scroll the check says so in its note and does not fake it.) The tablet's popover target
//                    is the touch size (44 px) after a finger and the wide layouts' 28 px row after a mouse.
//   7 focus          Tab reaches the track (the focus ring: a 2 px solid outline, `:focus-visible`), a mouse press does not leave one.
//   8 Off            depth Off greys the slider (data-disabled, the track's aria-disabled, opacity < 1), says why (the popover's `sub-pop-cap` data-off with its
//                    title "With depth Off no subagent runs", the sheet's `sub-cap-line`), and no drag, click, key or −/+ moves it or makes a call.
//   9 pictures       with OUT=/tmp/x the popover and the sheet are written as SI.3-<viewport>-<theme>-<state>.png (3, 37, 100, Off, focused), for a person's look.
// And once per viewport (light): a fork and a branch are fixed (the chip is static, with the reason of subChip, a press opens no popover and the phone's
// row has no Subagents chip); a started chat is fixed and opens nothing: S1.1 ("a started chat") proves it at the three viewports, not repeated here.
// Run: `cd web && PORT=4931 npm run uicheck -- SI.3`, or alone: node web/dev/checks/SI.3-maxchats.mjs (VIEWPORT=phone, DIST=… as README.md says).
import fs from "node:fs";
import path from "node:path";
import { atRest, callsOf, check, hostCall, mockEval, paneSize, seed, until } from "../shot.mjs";
import { chip, frame, openAt, openChoice, phoneChip, pickDepthPhone, playable } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";
import { pointer, sliderOf, sliderX, sliderY, tapSlider, trackOf } from "./slider.mjs";

export const viewports = ["desktop", "tablet", "phone"];
export const limit = 1500;

const OUT = process.env.OUT;
const ID = "sub-cap", CHAT = "c_A2_new";
const WIDE = { desktop: 900, tablet: 810 }; // the page's width (as S1.1), where the chip is in the toolbar's row
const nap = (ms) => new Promise((ok) => setTimeout(ok, ms));

await check("SI.3 max chats: the slider of the Subagents popover and sheet", async ({ url, layout, viewport, open, fail, note }) => {
  const phone = layout === "phone";
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const kinds = layout === "desktop" ? ["mouse"] : ["mouse", "touch"]; // the pointers this viewport has

  const run = async (theme, full) => {
    const T = `${theme}`;
    const say = (line) => `${T}: ${line}`;
    const bad = (line) => fail(say(line));
    await seed(url, "A2");
    await hostCall(url, "PATCH", `/api/chats/${CHAT}`, { subCap: 3 }); // an API client gave the chat a max of 3 before any window showed it
    // (the theme is a saved choice: the desktop's saved pane widths are kept beside it)
    const p = await openAt(open, state("plain-new"), layout, phone ? 400 : WIDE[layout], { ls: { "aiwb.theme": theme, ...(layout === "desktop" ? paneSize("page", WIDE.desktop, 640).ls : {}) } });
    const { page } = p;
    try {
    const calls = callsOf(page);
    const caps = () => calls.filter((c) => c.method === "PATCH" && c.path.split("?")[0] === `/api/chats/${CHAT}` && c.body && "subCap" in c.body);
    const otherPatches = () => calls.filter((c) => c.method === "PATCH" && c.path.split("?")[0] === `/api/chats/${CHAT}` && c.body && !("subCap" in c.body));
    const chatNow = () => mockEval(`const c = chats.${CHAT}; return { cap: c.subCap ?? 100, depth: c.subOff ? 0 : c.subDepth ?? 1 };`, url);
    const words = (page_ = page) => (phone ? phoneChip(page_, "subagents") : chip(page_, "subagents")).first().evaluate((e) => ({ text: e.textContent.replace(/[▾⌄]/g, "").trim(), title: e.getAttribute("title") ?? "", aria: e.getAttribute("aria-label") ?? "" }));
    const SURFACE = phone ? "sub-sheet" : "sub-pop";
    const isOpen = async () => (await byTid(page, SURFACE).count()) > 0;
    const settled = async () => {
      let last = "";
      await until(async () => { const b = await byTid(page, SURFACE).first().boundingBox().catch(() => null); const now = JSON.stringify(b); const still = now === last && !!b; last = now; return still; }, 4000);
    };
    const openIt = async () => {
      if (phone) await openChoice(page, "subagents"); else await press(page, chip(page, "subagents"));
      if (!await until(isOpen, 5000)) bad(`a press on the chip opened no ${SURFACE}`);
      await settled();
      await frame(page);
    };
    const shot = async (name) => {
      if (!OUT) return;
      fs.mkdirSync(OUT, { recursive: true });
      await atRest(page, 6).catch(() => {});
      await page.screenshot({ path: path.join(OUT, `SI.3-${viewport}-${theme}-${name}.png`) });
    };
    /** The pointer of a kind is the page's last one (the slider's size follows it): a mouse moves over the slider's value, a finger taps it (it is no control). */
    const prime = async (kind) => {
      const v = await byTid(page, `${ID}-value`).boundingBox();
      const x = v.x + v.width / 2, y = v.y + v.height / 2;
      if (kind === "touch") await page.touchscreen.tap(x, y); else await page.mouse.move(x, y);
      await frame(page);
      await nap(60);
      await frame(page);
    };
    /** Another client sets the cap (as an API client does: not a call of this page), and the slider shows it. */
    const setBy = async (v) => {
      await hostCall(url, "PATCH", `/api/chats/${CHAT}`, { subCap: v });
      if (!await until(async () => (await sliderOf(page, ID))?.value === v, 5000)) bad(`the slider does not show ${v} after another client set it (it shows ${(await sliderOf(page, ID))?.value})`);
      await nap(80);
    };
    const chipSays = (v) => (phone ? `Subagents · 1 level${v === 100 ? "" : ` · ${v} at once`}` : `Subagents1 level${v === 100 ? "" : ` · ${v} at once`}`);

    // ---- 1 the ends, the value, the current cap, and the roles
    await openIt();
    {
      const name = "a chat with a max of 3";
      const s = await sliderOf(page, ID);
      if (!s) return bad(`${name}: the ${SURFACE} has no slider ${ID}`);
      if (s.value !== 3 || s.text !== "3" || s.aria.now !== 3 || s.aria.text !== "3") bad(`${name}: the slider shows data-value ${s.value}, text "${s.text}", aria-valuenow ${s.aria.now}, aria-valuetext "${s.aria.text}", not 3`);
      if (s.min !== "1" || s.max !== "100" || s.aria.min !== 1 || s.aria.max !== 100) bad(`${name}: the ends are "${s.min}" … "${s.max}" (aria ${s.aria.min} … ${s.aria.max}), not "1" … "100"`);
      const roles = await page.evaluate((id) => ({ track: document.querySelector(`[data-testid="${id}-track"]`)?.getAttribute("role"), label: document.querySelector(`[data-testid="${id}-track"]`)?.getAttribute("aria-label"),
        minus: document.querySelector(`[data-testid="${id}-minus"]`)?.getAttribute("aria-label") ?? document.querySelector(`[data-testid="${id}-minus"]`)?.getAttribute("title"), plus: document.querySelector(`[data-testid="${id}-plus"]`)?.getAttribute("aria-label") ?? document.querySelector(`[data-testid="${id}-plus"]`)?.getAttribute("title"),
        theme: document.documentElement.dataset.theme }), ID);
      if (roles.track !== "slider" || roles.label !== "Running at once") bad(`${name}: the track is role ${roles.track} named ${JSON.stringify(roles.label)}, not the slider "Running at once"`);
      if (roles.minus !== "Decrease Running at once" || roles.plus !== "Increase Running at once") bad(`${name}: − and + are named ${JSON.stringify(roles.minus)} and ${JSON.stringify(roles.plus)}`);
      if (roles.theme !== (theme === "dark" ? "dark" : "light")) bad(`${name}: the page is in the ${roles.theme} theme, not ${theme}`);
      const w = await words();
      if (w.text !== chipSays(3)) bad(`${name}: the chip says "${w.text}", not "${chipSays(3)}"`);
      if (!phone && !w.title.startsWith("Subagents — 1 level, at most 3 running at once — ")) bad(`${name}: the chip's title is "${w.title}"`);
      if (phone && !w.aria.includes("3")) bad(`${name}: the phone chip's label "${w.aria}" does not say 3`);
      // the depth is a list still: no row of the old cap
      if (await byTid(page, "sub-opt", { section: "cap" }).count()) bad(`${name}: the cap still has rows (sub-opt section cap)`);
      if (await byTid(page, "sub-opt", { section: "depth" }).count() !== 4) bad(`${name}: depth has ${await byTid(page, "sub-opt", { section: "depth" }).count()} choices, not Off, 1, 2, 3`);
      await shot("at-3");
    }

    // ---- 2 setting 1, 37 and 100: by drag, by tap, by the keyboard
    /** Runs `how`, then proves it made exactly one PATCH of the chat with {subCap: want} and that the chat, the slider and the chip say `want`. */
    const act = async (label, start, want, how) => {
      await setBy(start);
      const before = caps().length, others = otherPatches().length;
      await how(before);
      if (!await until(async () => (await chatNow()).cap === want, 6000)) return bad(`${label}: the chat's cap is ${(await chatNow()).cap}, not ${want}`);
      await nap(450); // (a second call, if there were one, has been sent by now)
      const mine = caps().slice(before).map((c) => c.body.subCap), s = await sliderOf(page, ID);
      if (mine.length !== 1 || mine[0] !== want) bad(`${label}: ${mine.length} calls with subCap [${mine}], not one with ${want}`);
      if (otherPatches().length !== others) bad(`${label}: a call that is not the cap's was made`);
      if (caps().slice(before).some((c) => Object.keys(c.body).join() !== "subCap")) bad(`${label}: the call carries more than subCap: ${JSON.stringify(caps().slice(before).map((c) => c.body))}`);
      if (s.value !== want || s.text !== String(want) || s.aria.now !== want || s.dragging !== "false") bad(`${label}: the slider shows ${s.value} / "${s.text}" / ${s.aria.now} (dragging ${s.dragging}), not ${want}`);
      const w = await words();
      if (w.text !== chipSays(want)) bad(`${label}: the chip says "${w.text}", not "${chipSays(want)}"`);
      if (!phone && w.title !== `Subagents — 1 level, at most ${want} running at once — ${w.title.split(" — ")[2] ?? ""}`) bad(`${label}: the chip's title is "${w.title}"`);
      if (!phone && !w.title.split(" — ")[2]) bad(`${label}: the chip's title has no hint after the settings: "${w.title}"`);
      if (!await isOpen()) bad(`${label}: the ${SURFACE} closed`);
      return true;
    };
    /** A drag by `kind` from the handle to the place of `v`, read in the middle of it (before the release): live value, handle under the pointer, dragging, no call. */
    const dragTo = async (kind, v, { steps = 12 } = {}) => { // (answers the pointer, still down)
      await prime(kind);
      const ptr = await pointer(page, kind, { steps });
      const s0 = await sliderOf(page, ID), y = await sliderY(page, ID);
      await ptr.down({ x: s0.handle.x, y });
      const was = caps().length;
      const mid = (v + s0.value) / 2, midx = await sliderX(page, ID, mid), seen = new Set();
      await ptr.move({ x: midx, y }, 4);
      const sm = await sliderOf(page, ID);
      if (sm.dragging !== "true") bad(`${kind} drag to ${v}: data-dragging is "${sm.dragging}" in the middle of the drag`);
      if (Math.abs(sm.value - mid) > 1.01) bad(`${kind} drag to ${v}: in the middle the slider shows ${sm.value}, the pointer is at about ${Math.round(mid)}`);
      if (sm.text !== String(sm.value) || sm.aria.now !== sm.value) bad(`${kind} drag to ${v}: in the middle the value text is "${sm.text}" and aria-valuenow ${sm.aria.now}, data-value ${sm.value}`);
      seen.add(sm.value);
      const x = await sliderX(page, ID, v);
      await ptr.move({ x, y }, steps);
      const se = await sliderOf(page, ID);
      if (se.value !== v || se.text !== String(v) || se.aria.now !== v) bad(`${kind} drag to ${v}: before the release the slider shows ${se.value} / "${se.text}" / ${se.aria.now}, not ${v}`);
      if (Math.abs(se.handle.x - x) > 1.5) bad(`${kind} drag to ${v}: before the release the handle is ${Math.round(se.handle.x - x)} px from the pointer`);
      if (caps().length !== was) bad(`${kind} drag to ${v}: a call was made before the release`);
      return { ptr, release: async () => { await ptr.up(); } };
    };
    const matrix = full ? [1, 37, 100] : [37];
    for (const kind of full ? kinds : kinds.slice(0, 1)) {
      for (const v of matrix) {
        await act(`${kind} drag to ${v}`, 50, v, async () => { const d = await dragTo(kind, v); await d.release(); });
        await act(`${kind} ${kind === "touch" ? "tap" : "click"} on the track at ${v}`, 50, v, async () => {
          await prime(kind);
          const x = await sliderX(page, ID, v), y = await sliderY(page, ID);
          if (kind === "touch") await tapSlider(page, ID, v); else await page.mouse.click(x, y);
        });
      }
    }
    // the keyboard: Home, End, one → from 36, Page Up and Page Down (10); the track has the focus
    const key = (k, n = 1) => async () => { await trackOf(page, ID).focus(); for (let i = 0; i < n; i++) await page.keyboard.press(k); };
    await act("Home", 50, 1, key("Home"));
    await act("End", 50, 100, key("End"));
    await act("→ from 36", 36, 37, key("ArrowRight"));
    await act("← from 38", 38, 37, key("ArrowLeft"));
    await act("Page Up from 50", 50, 60, key("PageUp"));
    await act("Page Down from 50", 50, 40, key("PageDown"));
    await act("Page Up from 95 stops at 100", 95, 100, key("PageUp"));
    await act("Page Down from 4 stops at 1", 4, 1, key("PageDown"));
    {
      // at an end the key that goes on makes no call; the same value is never committed
      await setBy(100);
      const n = caps().length;
      await trackOf(page, ID).focus();
      await page.keyboard.press("ArrowRight"); await page.keyboard.press("End"); await page.keyboard.press("PageUp");
      await nap(300);
      if (caps().length !== n) bad(`→, End and Page Up at 100 made ${caps().length - n} calls`);
    }
    await setBy(37); await shot("at-37");
    await setBy(1); await shot("at-1");
    await setBy(100); await shot("at-100");
    {
      const w = await words();
      if (w.text !== chipSays(100)) bad(`at 100 the chip says "${w.text}", not "${chipSays(100)}" (the default leaves the cap out)`);
    }

    // ---- 3 one drag across many numbers is one call
    for (const kind of full ? kinds : kinds.slice(0, 1)) {
      await act(`${kind} drag 100 to 5 through 30 moves`, 100, 5, async (before) => {
        await prime(kind);
        const ptr = await pointer(page, kind), s0 = await sliderOf(page, ID), y = await sliderY(page, ID);
        await ptr.down({ x: s0.handle.x, y });
        const x0 = s0.handle.x, x1 = await sliderX(page, ID, 5), seen = [];
        for (let i = 1; i <= 30; i++) {
          await ptr.move({ x: x0 + ((x1 - x0) * i) / 30, y }, 1);
          seen.push((await sliderOf(page, ID)).value);
        }
        const distinct = new Set(seen).size;
        if (distinct < 20) bad(`${kind} drag 100 to 5: only ${distinct} different numbers shown over 30 moves (${seen.join(",")})`);
        if (seen.some((v, i) => i && v > seen[i - 1])) bad(`${kind} drag 100 to 5: the value went up on the way (${seen.join(",")})`);
        if (caps().length !== before) bad(`${kind} drag 100 to 5: ${caps().length - before} calls before the release`);
        await ptr.up();
      });
    }

    // ---- 4 a drag that leaves the slider keeps the handle and closes nothing
    for (const kind of full ? kinds : kinds.slice(0, 1)) {
      await act(`${kind} drag out of the slider, back and released outside`, 50, 10, async (before) => {
        await prime(kind);
        const ptr = await pointer(page, kind), s0 = await sliderOf(page, ID), y = await sliderY(page, ID), out = 24; // (the top of the window: over the backdrop)
        const over = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? "", [s0.handle.x, out]);
        if (over !== "overlay-backdrop") bad(`${kind} drag out: the place the pointer goes to (${Math.round(s0.handle.x)}, ${out}) is "${over}", not the backdrop`);
        await ptr.down({ x: s0.handle.x, y });
        const at = async (label, v, py) => {
          const x = await sliderX(page, ID, v);
          await ptr.move({ x, y: py }, 8);
          // (the gesture handler takes the first move after the pointer comes back over the slider as the pointer's entry and the handle is one event behind until the
          // next: a real pointer sends one every few ms, so a tiny move of this one stands for it)
          await ptr.move({ x: x + 0.3, y: py }, 1);
          const s = await sliderOf(page, ID);
          if (s.value !== v || s.dragging !== "true") bad(`${kind} drag out: ${label}, the slider shows ${s.value} (dragging ${s.dragging}), not ${v} under the pointer`);
          if (!await isOpen()) bad(`${kind} drag out: the ${SURFACE} closed ${label}`);
          if (caps().length !== before) bad(`${kind} drag out: a call was made ${label}`);
        };
        // (a drag begins sideways: one that goes 10 up first is the page's scroll, not the slider's; and the browser takes a finger for a scroll (a pointercancel, as touch-action
        // is pan-y) when its first move past the touch slop, some 15 px, is a vertical one, so the finger goes 40 px sideways before it leaves)
        await ptr.move({ x: s0.handle.x - 40, y }, 6);
        await at("outside, over the backdrop", 20, out);
        await at("back over the slider", 80, y);
        await at("outside again", 10, out);
        await ptr.up();
        await nap(150);
        if (!await isOpen()) bad(`${kind} drag out: the ${SURFACE} closed with the release over the backdrop`);
      });
    }

    // ---- 5 − and +
    {
      const btn = (n) => byTid(page, `${ID}-${n}`);
      for (const kind of kinds.slice(0, full ? kinds.length : 1)) {
        await prime(kind);
        await act(`${kind} + from 50`, 50, 51, () => press(page, btn("plus")));
        await act(`${kind} − from 50`, 50, 49, () => press(page, btn("minus")));
      }
      await setBy(1);
      let s = await sliderOf(page, ID), n = caps().length;
      if (!s.minus.disabled || s.plus.disabled) bad(`at 1: − is ${s.minus.disabled ? "disabled" : "enabled"} and + is ${s.plus.disabled ? "disabled" : "enabled"}, not the reverse`);
      await btn("minus").click({ force: true, timeout: 3000 }).catch(() => {});
      await nap(300);
      if (caps().length !== n || (await sliderOf(page, ID)).value !== 1) bad(`at 1: a press on − made ${caps().length - n} calls / moved the slider`);
      await act("+ from 1", 1, 2, () => press(page, btn("plus")));
      await setBy(100);
      s = await sliderOf(page, ID); n = caps().length;
      if (!s.plus.disabled || s.minus.disabled) bad(`at 100: + is ${s.plus.disabled ? "disabled" : "enabled"} and − is ${s.minus.disabled ? "disabled" : "enabled"}, not the reverse`);
      await btn("plus").click({ force: true, timeout: 3000 }).catch(() => {});
      await nap(300);
      if (caps().length !== n || (await sliderOf(page, ID)).value !== 100) bad(`at 100: a press on + made ${caps().length - n} calls / moved the slider`);
      await act("− from 100", 100, 99, () => press(page, btn("minus")));
    }

    // ---- 6 sizes of the touch targets: the finger's slider is 44 px, the mouse's is the wide layouts' row
    {
      await setBy(50);
      for (const kind of kinds) {
        await prime(kind);
        const s = await sliderOf(page, ID);
        const big = kind === "touch";
        if (big && (s.track.height < 43.5 || s.minus.h < 43.5 || s.minus.w < 43.5 || s.plus.h < 43.5 || s.plus.w < 43.5 || s.handle.w < 23.5)) bad(`${kind}: the touch area is ${Math.round(s.track.height)} px high, − ${Math.round(s.minus.w)} × ${Math.round(s.minus.h)}, + ${Math.round(s.plus.w)} × ${Math.round(s.plus.h)}, the handle ${Math.round(s.handle.w)}: under 44 / 24`);
        if (!big && phone) continue; // (a mouse on the phone's sheet is not a case: the sheet asks for the touch size, size="touch")
        if (!big && (s.track.height > 30 || s.handle.w > 15)) bad(`${kind}: the wide layouts' slider is ${Math.round(s.track.height)} px high with a ${Math.round(s.handle.w)} px handle after a mouse`);
      }
      if (phone) { // (the sheet's slider is always the touch size)
        await prime("mouse");
        const s = await sliderOf(page, ID);
        if (s.track.height < 43.5 || s.minus.h < 43.5 || s.plus.h < 43.5) bad(`the sheet's slider is ${Math.round(s.track.height)} px high, − ${Math.round(s.minus.h)}, + ${Math.round(s.plus.h)} after a mouse: under 44`);
      }
    }

    // ---- 6b a finger on the sheet's slider: a sideways drag moves it and does not scroll the sheet, a vertical one scrolls the sheet and does not move it
    if (phone) {
      const scroller = () => page.evaluate(() => {
        let e = document.querySelector('[data-testid="sheet-body"]')?.parentElement;
        while (e && !(e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
        if (!e) return null;
        e.setAttribute("data-si3-scroll", "1");
        return { top: e.scrollTop, max: e.scrollHeight - e.clientHeight };
      });
      const top = () => page.evaluate(() => document.querySelector('[data-si3-scroll="1"]')?.scrollTop ?? -1);
      await setBy(50);
      await trackOf(page, ID).scrollIntoViewIfNeeded();
      await nap(150);
      const sc = await scroller();
      if (!sc) note(`the sheet has nothing to scroll in a window ${page.viewportSize().height} px high: the finger's scroll part is not exercised`);
      else {
        await prime("touch");
        let t0 = await top();
        await act("finger: a sideways drag in the scrolling sheet", 50, 70, async () => {
          const ptr = await pointer(page, "touch"), s0 = await sliderOf(page, ID), y = await sliderY(page, ID);
          await ptr.down({ x: s0.handle.x, y });
          await ptr.move({ x: await sliderX(page, ID, 70), y: y + 7 }, 10); // (a finger drifts a little up or down: under the 10 points of a scroll)
          if (await top() !== t0) bad(`finger: the sheet scrolled from ${t0} to ${await top()} under a sideways drag on the slider`);
          await ptr.up();
        });
        if (await top() !== t0) bad(`finger: after the sideways drag the sheet is scrolled to ${await top()}, was ${t0}`);
        // a vertical drag that starts on the slider is the sheet's scroll: it moves the sheet (down if the sheet is at its end, else up) and not the slider
        const n = caps().length, at = (await sliderOf(page, ID)).value;
        const before = await top(), room = sc.max - before, dir = room > 20 ? -1 : 1; // (-1: the finger goes up: the content goes up)
        const ptr = await pointer(page, "touch"), s1 = await sliderOf(page, ID), y1 = await sliderY(page, ID);
        await ptr.down({ x: s1.handle.x, y: y1 });
        await ptr.move({ x: s1.handle.x, y: y1 + dir * 90 }, 12);
        await ptr.up();
        await nap(300);
        const after = await top(), s2 = await sliderOf(page, ID);
        if (after === before) bad(`finger: a vertical drag that starts on the slider did not scroll the sheet (${before} → ${after}, of ${sc.max})`);
        if (s2.value !== at || caps().length !== n) bad(`finger: a vertical drag that starts on the slider moved it to ${s2.value} / made ${caps().length - n} calls`);
        note(`the finger on the sheet's slider (the sheet scrolls ${sc.max} px at ${page.viewportSize().height} px high): sideways it moves the slider and the sheet stays at ${t0}; up or down it scrolls the sheet (${before} → ${after}) and moves nothing`);
        await page.evaluate(() => { document.querySelector('[data-si3-scroll="1"]').scrollTop = 0; });
      }
    }

    // ---- 7 the focus ring
    {
      await setBy(50);
      await press(page, byTid(page, "sub-opt", { section: "depth", value: phone ? 1 : 1 }).first()); // (the depth row/segment: nothing changes, it is the chat's depth)
      await page.evaluate(() => document.activeElement?.blur?.());
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate((id) => document.activeElement?.getAttribute("data-testid") === `${id}-track`, ID);
      }
      if (!reached) bad("Tab does not reach the slider's track in 12 presses");
      else {
        const ring = await page.evaluate((id) => { const e = document.querySelector(`[data-testid="${id}-track"]`), c = getComputedStyle(e); return { style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, matches: e.matches(":focus-visible") }; }, ID);
        if (!ring.matches || ring.style !== "solid" || ring.width !== "2px") bad(`the focused track's outline is ${JSON.stringify(ring)}, not a 2 px solid ring on :focus-visible`);
        await shot("focused");
      }
      // a press with the mouse leaves no ring (only the keyboard shows it)
      if (!phone && layout === "desktop") {
        await page.mouse.click(...(await (async () => [await sliderX(page, ID, 70), await sliderY(page, ID)])()));
        await nap(300);
        const after = await page.evaluate((id) => { const e = document.querySelector(`[data-testid="${id}-track"]`); return { focus: document.activeElement === e, visible: e.matches(":focus-visible") }; }, ID);
        if (after.visible) bad("a mouse press on the track leaves the focus ring");
      }
    }

    // ---- 8 depth Off: greyed, says why, cannot be moved
    if (phone) await pickDepthPhone(page, 0);
    else await press(page, byTid(page, "sub-opt", { section: "depth", value: 0 }).first());
    if (!await until(async () => (await chatNow()).depth === 0, 6000)) bad("Off was not saved");
    {
      await until(async () => (await sliderOf(page, ID)).disabled === "true", 5000);
      const s = await sliderOf(page, ID), at = s.value;
      if (s.disabled !== "true" || s.ariaDisabled !== "true") bad(`depth Off: data-disabled "${s.disabled}", the track's aria-disabled "${s.ariaDisabled}", not both "true"`);
      // (the opacity the slider is drawn at inside its popover or sheet: the elements from the slider up to the surface, which fades as it opens and re-places itself as the content changes)
      const op = await page.evaluate(([id, top]) => { let o = 1; for (let e = document.querySelector(`[data-testid="${id}"]`); e && e.dataset.testid !== top && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; }, [ID, SURFACE]);
      if (!(op < 0.75)) bad(`depth Off: the slider is drawn at opacity ${op}: not greyed`);
      if (op < 0.4) bad(`depth Off: the slider is drawn at opacity ${op}: greyed twice (the section's grey over the slider's own), the ends' labels all but gone`);
      if (!phone) { // (the heading of the section is greyed with it)
        const head = await page.evaluate(() => { const h = [...document.querySelectorAll('[data-testid="sub-pop-cap"] *')].find((e) => e.children.length === 0 && e.textContent === "Running at once"); let o = 1; for (let e = h; e && e.dataset.testid !== "sub-pop" && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return h ? o : null; });
        if (head === null || !(head < 0.75)) bad(`depth Off: the heading "Running at once" is drawn at opacity ${head}: not greyed`);
      }
      if (!s.minus.disabled || !s.plus.disabled) bad("depth Off: − or + is enabled");
      if (phone) {
        const line = await byTid(page, "sub-cap-line").first().innerText();
        if (line.trim() !== "With depth Off no subagent runs.") bad(`depth Off: the sheet's line says "${line}", not "With depth Off no subagent runs."`);
      } else {
        const sec = await byTid(page, "sub-pop-cap", { off: true }).first().evaluate((e) => ({ title: e.getAttribute("title") ?? "" })).catch(() => null);
        if (!sec) bad("depth Off: sub-pop-cap has no data-off true");
        else if (sec.title !== "With depth Off no subagent runs") bad(`depth Off: the section's reason on hover is "${sec.title}", not "With depth Off no subagent runs"`);
      }
      const n = caps().length;
      for (const kind of kinds) {
        await prime(kind);
        const ptr = await pointer(page, kind), y = await sliderY(page, ID), h = await sliderOf(page, ID);
        await ptr.down({ x: h.handle.x, y });
        await ptr.move({ x: await sliderX(page, ID, 80), y }, 6);
        const mid = await sliderOf(page, ID);
        if (mid.value !== at || mid.dragging === "true") bad(`depth Off: a ${kind} drag moved the handle to ${mid.value} (dragging ${mid.dragging})`);
        await ptr.up();
        if (kind === "touch") await page.touchscreen.tap(await sliderX(page, ID, 20), y); else await page.mouse.click(await sliderX(page, ID, 20), y);
      }
      await trackOf(page, ID).focus().catch(() => {});
      for (const k of ["ArrowRight", "ArrowLeft", "Home", "End", "PageUp", "PageDown"]) await page.keyboard.press(k);
      await byTid(page, `${ID}-plus`).click({ force: true, timeout: 3000 }).catch(() => {});
      await byTid(page, `${ID}-minus`).click({ force: true, timeout: 3000 }).catch(() => {});
      await nap(400);
      const after = await sliderOf(page, ID);
      if (after.value !== at || caps().length !== n || (await chatNow()).cap !== at) bad(`depth Off: after drags, taps, keys and −/+ the slider shows ${after.value} (was ${at}), ${caps().length - n} cap calls, the chat's cap ${(await chatNow()).cap}`);
      if (!await isOpen()) bad(`depth Off: the ${SURFACE} closed`);
      await shot("off");
    }
    } finally { await p.ctx.close().catch(() => {}); }
  };

  await run("light", true);
  await run("dark", false); // (the same slider in the dark theme; one of each way to set it)

  // a fork and a branch: the chip is fixed (S1.1 proves it for a started chat): no popover and no sheet opens, the title says why
  if (true) {
    const why = "a branch and a fork keep the settings of the chat they came from";
    for (const [name, id, before] of [["a fork", "plain-fork-fresh", ""], ["a branch", "plain-new", `chats.${CHAT}.branches = 2;`]]) {
      await seed(url, "A2");
      if (before) await mockEval(before, url);
      const p = await openAt(open, state(id), layout, phone ? 400 : WIDE[layout]);
      try {
        const { page } = p, c = chip(page, "subagents");
        if (phone) { // (the phone's chip row has no Subagents chip for a chat whose settings are fixed, or one that opens nothing)
          if (await phoneChip(page, "subagents").count()) { await press(page, phoneChip(page, "subagents")).catch(() => {}); await frame(page); }
          if (await byTid(page, "sub-sheet").count() || await byTid(page, "sub-cap").count()) fail(`${name}: the phone opened the Subagents sheet`);
        } else {
          if (!await c.count() && await page.locator(tidSel("more-chip")).count()) { await press(page, page.locator(tidSel("more-chip"))); await until(() => c.count(), 5000); }
          const says = await c.first().evaluate((e) => ({ fixed: e.dataset.fixed === "true", title: e.getAttribute("title") ?? "" })).catch(() => null);
          if (!says?.fixed || !says.title.includes(why)) fail(`${name}: the chip is ${JSON.stringify(says)}: fixed, with "${why}"`);
          await press(page, c.first()).catch(() => {});
          await frame(page); await nap(200);
          if (await byTid(page, "sub-pop").count() || await byTid(page, "sub-cap").count()) fail(`${name}: a press on the fixed chip opened the popover with the slider`);
        }
      } finally { await p.ctx.close().catch(() => {}); }
    }
    note("a fork and a branch: the Subagents chip is fixed, with the reason, and no popover or sheet with the slider opens (a started chat: S1.1)");
  }
}, { viewports, page: false });
