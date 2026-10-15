// Proves A6.4 on the new build (it ports dev/checks/A6.4-floors.mjs; A-SB-06, A-TH-10, A-TH-11, A-TH-17, B-MD-05, B-MD-12, B-US-13): in each Catppuccin
// flavour the contrast floors hold, on the colours the browser computes. The floors are the goal's (plans/composer-ui-improvements-goals.md, section 8),
// stated here a second time, apart from core's logic/flavours.ts: 4.5:1 on the background for text, muted text, the accent, danger and text on a filled
// button; 3:1 for faint text, ok and warning, for the code colours on a code block, and for a switch's knob on its track, on and off. Each is read twice:
// as the token (the values of app/src/ui/tokens.ts, which the app draws with), and on elements of the page that are drawn in it (a text of each kind on
// the background, the filled buttons, the words of a code block, the switch). It also proves that the page is in the flavour (its background, panes,
// text and accent are Base, Mantle, Text and Mauve of the palette, the theme under it Latte's light or the others' dark) and that the build carries the
// palette's licence notice.
// What changed from the old check, and why:
//  - the new build has no CSS custom properties, so the token is not read as the computed colour of `var(--x)` on a probe element: the check imports
//    the token module in Node (`tokensFor(theme, flavour)`, the one object the provider hands to every component) and holds the page to it. The drawn
//    colours are the proof that the page uses the tokens: each token must be the colour of elements on the page (no element drawn in it fails), and a
//    word of code, a filled button and the knob must be drawn in exactly the token of their role.
//  - the licence notice is not in a stylesheet any more: the web export writes it as THIRD-PARTY-NOTICES.txt beside the page (app/scripts/export-web.mjs,
//    noticeText), the check reads that file from the build that is served. (The first run of this port found the export carried it only as a string of an
//    unused function of the bundle.)
//  - the parts of the sidebar (the New button, the switch, the state "Not started") are read on a page of their own with nothing selected: on the phone the
//    sidebar is the first screen of the stack, the chat's is another. The chat's page is as tall as the old one (1500 px) so the thread is drawn whole.
//  - the code words are told apart by the `dataSet` `tone` the markdown renderer puts on each run (the old check took the highlight.js class), and the
//    switch's knob by the testID `side-knob` (the old one read its `::after`).
// The floors are the same at every width, and the parity rows say "all": the check runs at the three viewports.
import { atRest, check, colourOf, contrastAudit, contrastOf, mockEval, seed, until } from "../shot.mjs";
import { tokensFor } from "../../../app/src/ui/tokens.ts";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// Base, Mantle, Text and Mauve of @catppuccin/palette 1.8.0
const FLAVOURS = {
  latte: { theme: "light", base: "#eff1f5", mantle: "#e6e9ef", text: "#4c4f69", mauve: "#8839ef" },
  frappe: { theme: "dark", base: "#303446", mantle: "#292c3c", text: "#c6d0f5", mauve: "#ca9ee6" },
  macchiato: { theme: "dark", base: "#24273a", mantle: "#1e2030", text: "#cad3f5", mauve: "#c6a0f6" },
  mocha: { theme: "dark", base: "#1e1e2e", mantle: "#181825", text: "#cdd6f4", mauve: "#cba6f7" },
};
const ON_BG = [["text", 4.5, "text"], ["muted", 4.5, "muted text"], ["accent", 4.5, "the accent"], ["danger", 4.5, "danger"],
  ["faint", 3, "faint text"], ["ok", 3, "ok"], ["warn", 3, "warning"]];
// the kinds of word a code block colours, and the token of each
const CODE = { keyword: "synKeyword", string: "synString", number: "synNumber", title: "synTitle", type: "synType", attr: "synAttr" };
// the window of the chat's page: tall, so that the whole thread is drawn
const SIZE = { desktop: [1280, 1500], tablet: [834, 1500], phone: [393, 1800] };

const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const two = (n) => (Math.floor(n * 100) / 100).toFixed(2);

/** In the page: every word of a code block that has a colour of its own, by the `tone` the renderer gave it: { tone, word, fg, bg }. */
function codeInPage() {
  const nums = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  return [...document.querySelectorAll('[data-testid="md-code-body"] [data-tone]')].map((e) => ({
    tone: e.dataset.tone, word: e.textContent.slice(0, 20), fg: nums(getComputedStyle(e).color), bg: nums(getComputedStyle(e.closest('[data-testid="md-code"]')).backgroundColor),
  }));
}

/** The colour a text is drawn in, in the element with this selector (its first text), and the fill behind it. */
async function inkOf(page, sel) {
  await page.evaluate((sel) => document.querySelector(sel + " [dir=auto]")?.setAttribute("data-ink-probe", "1"), sel);
  const fg = await colourOf(page, `${sel} [data-ink-probe]`, "color"), bg = await colourOf(page, sel, "backgroundColor");
  return { fg, bg };
}

await check("A6.4 the contrast floors hold in each flavour, on computed colours", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "A6");
  const notice = await fetch(url + "/THIRD-PARTY-NOTICES.txt").then((r) => (r.ok ? r.text() : ""));
  if (!/Copyright \(c\) 2021 Catppuccin/.test(notice) || !/The above copyright notice and this permission notice shall be included/.test(notice) || !/@catppuccin\/palette 1\.8\.0/.test(notice))
    fail("the build's THIRD-PARTY-NOTICES.txt does not carry the palette's licence notice (its copyright line, its permission notice, the package and its version)");

  for (const [flavour, P] of Object.entries(FLAVOURS)) {
    const say = (line) => fail(`${flavour}: ${line}`);
    // the tokens, as the app draws with them
    const T = tokensFor(P.theme, flavour), t = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.startsWith("#") ? rgb(v) : null]));
    const c = (name) => contrastOf(t[name], t.bg);
    for (const [name, want] of [["bg", P.base], ["panel", P.mantle], ["text", P.text], ["accent", P.mauve], ["accentFill", P.mauve], ["onAccent", P.base]])
      if (T[name] !== want) say(`${name} is ${T[name]}, the palette's colour for it is ${want}`);

    // the tokens' floors
    const told = [];
    const floor = (what, ratio, least, how) => { told.push(`${what} ${two(ratio)}`); if (ratio < least) say(`${what}: ${how} is ${two(ratio)}:1, under ${least}:1`); };
    for (const [name, least, what] of ON_BG) floor(what, c(name), least, `${name} ${T[name]} on the background ${T.bg}`);
    floor("on a filled button", contrastOf(t.onAccent, t.accentFill), 4.5, `onAccent ${T.onAccent} on accentFill ${T.accentFill}`);
    floor("on a danger button", contrastOf(t.onDanger, t.dangerFill), 4.5, `onDanger ${T.onDanger} on dangerFill ${T.dangerFill}`);
    for (const [kind, name] of Object.entries(CODE)) floor(`code ${kind}`, contrastOf(t[name], t.panel), 3, `${name} ${T[name]} on a code block ${T.panel}`);
    floor("knob off", contrastOf(t.knob, t.line2), 3, `knob ${T.knob} on line2 ${T.line2}`);
    floor("knob on", contrastOf(t.knobOn, t.accentFill), 3, `knobOn ${T.knobOn} on accentFill ${T.accentFill}`);

    // the chat's page: the background, and what is drawn on it in each of those colours
    const { ctx, page } = await open({ sel: { chat: "c_A6_cards" }, ls: { "aiwb.theme": flavour }, size: SIZE[viewport], still: true,
      wait: `${tidSel("perm", { state: "pending" })} ${tidSel("perm-actions")}` });
    let drawn = [], words = [];
    try {
      const data = await page.evaluate(() => ({ ...document.documentElement.dataset, scheme: getComputedStyle(document.documentElement).colorScheme }));
      if (data.theme !== P.theme || data.flavour !== flavour || data.scheme !== P.theme) say(`<html> has data-theme "${data.theme}", data-flavour "${data.flavour}" and color-scheme ${data.scheme}: a flavour is laid over ${P.theme}`);
      const ground = { html: await colourOf(page, "html", "backgroundColor"), root: await colourOf(page, tidSel("app-root"), "backgroundColor"), main: await colourOf(page, tidSel("chat"), "backgroundColor") };
      if (hex(ground.html) !== P.base || hex(ground.root) !== P.base || hex(ground.main) !== P.base) say(`the page's background is ${hex(ground.html)}, the app's ${hex(ground.root)} and the chat's ${hex(ground.main)}, not Base ${P.base}`);
      // (the thread is virtualized and its rows are laid out in a few frames, hidden until they are: read the page once its last line, the error note the
      // seed's chat ends with, is shown in full, and the page is still)
      await page.waitForFunction((sel) => { const e = document.querySelector(sel); if (!e) return false; let o = 1; for (let x = e; x; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o === 1; }, tidSel("note", { tone: "error" }), { timeout: 15000 });
      if (!await atRest(page, 8)) say("the chat's page did not come to rest");
      // (no text of this chat is a warning on Base: that one is read below, on the card that waits for approval, when it is there)
      const rows = await contrastAudit(page);
      // (a colour with the floor of 3:1 is read on a secondary pane too, where the page has most of its marks: the
      // floor holds there as well. The accent and danger are read on the background only: on a secondary pane
      // Latte's are just under 4.5:1, which the goal accepts)
      for (const [name, least, what] of ON_BG) {
        const mine = rows.filter((r) => r.fg === T[name] && (r.bg === P.base || (least === 3 && r.bg === P.mantle)));
        if (!mine.length) { if (name !== "warn") say(`nothing on the page is drawn in ${name} ${T[name]} on the background: ${what} is not read on an element`); continue; }
        drawn.push(`${what} ${mine.length}`);
        for (const r of mine.filter((r) => r.ratio < least)) say(`${what}: "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${least}:1`);
      }

      // the permission card's Allow button, a filled one
      const allow = await inkOf(page, tidSel("perm-allow"));
      if (!allow.fg || !allow.bg) say(`the permission card's Allow button is not on the page`);
      else {
        if (hex(allow.bg) === hex(ground.main)) say(`the permission card's Allow button is not filled: its background ${hex(allow.bg)} is the pane's`);
        if (hex(allow.bg) !== T.dangerFill || hex(allow.fg) !== T.onDanger) say(`the permission card's Allow button is ${hex(allow.fg)} on ${hex(allow.bg)}, not onDanger ${T.onDanger} on dangerFill ${T.dangerFill}`);
        floor("the permission card's Allow button", contrastOf(allow.fg, allow.bg), 4.5, `its text ${hex(allow.fg)} on its fill ${hex(allow.bg)}`);
      }

      // the code block: every kind of word the page colours is in the seed's code
      words = await page.evaluate(codeInPage);
      for (const [kind, name] of Object.entries(CODE)) {
        const mine = words.filter((w) => w.tone === name);
        if (!mine.length) { say(`the seed's code has no word of the kind "${kind}"`); continue; }
        for (const w of mine) {
          if (hex(w.fg) !== T[name]) say(`code ${kind}: "${w.word}" is drawn in ${hex(w.fg)}, not in ${name} ${T[name]}`);
          if (hex(w.bg) !== P.mantle) say(`the code block's background is ${hex(w.bg)}, not Mantle ${P.mantle}`);
          const q = contrastOf(w.fg, w.bg);
          if (q < 3) say(`code ${kind}: "${w.word}" is ${hex(w.fg)} on ${hex(w.bg)}, ${two(q)}:1, under 3:1`);
        }
      }
    } finally { await ctx.close(); }

    // the sidebar's page: nothing selected (on the phone this is the first screen)
    const { ctx: ctx2, page: page2 } = await open({ sel: {}, ls: { "aiwb.theme": flavour }, still: true, wait: tidSel("side-foot") });
    try {
      const side = await colourOf(page2, tidSel("side"), "backgroundColor"), main = await colourOf(page2, tidSel("app-root"), "backgroundColor");
      if (hex(side) !== P.mantle) say(`the sidebar's background is ${hex(side)}, not Mantle ${P.mantle}`);

      // the filled button
      const plus = await inkOf(page2, tidSel("side-new"));
      if (!plus.fg || !plus.bg) say("the sidebar's New button is not on the page");
      else {
        if (hex(plus.bg) === hex(main) || hex(plus.bg) === hex(side)) say(`the sidebar's New button is not filled: its background ${hex(plus.bg)} is the pane's`);
        if (hex(plus.bg) !== T.accentFill || hex(plus.fg) !== T.onAccent) say(`the sidebar's New button is ${hex(plus.fg)} on ${hex(plus.bg)}, not onAccent ${T.onAccent} on accentFill ${T.accentFill}`);
        floor("the sidebar's New button", contrastOf(plus.fg, plus.bg), 4.5, `its text ${hex(plus.fg)} on its fill ${hex(plus.bg)}`);
      }

      // the switch, off and on
      const SWITCH = byTid(page2, "side-archived");
      const knob = async (on) => {
        const track = await colourOf(page2, tidSel("side-switch"), "backgroundColor"), k = await colourOf(page2, tidSel("side-knob"), "backgroundColor");
        if (hex(k) !== (on ? T.knobOn : T.knob) || hex(track) !== (on ? T.accentFill : T.line2)) say(`the Show archived switch ${on ? "on" : "off"} draws a knob ${hex(k)} on a track ${hex(track)}, not ${on ? "knobOn" : "knob"} ${on ? T.knobOn : T.knob} on ${on ? "accentFill" : "line2"} ${on ? T.accentFill : T.line2}`);
        return contrastOf(k, track);
      };
      if (await SWITCH.isChecked()) say("the Show archived switch is on in a page that never set it");
      floor("the switch off", await knob(false), 3, "the knob of Show archived on its track");
      await press(page2, SWITCH);
      if (!await until(() => SWITCH.isChecked(), 5000)) say("a press did not turn the Show archived switch on");
      floor("the switch on", await knob(true), 3, "the knob of Show archived on its track");

      // the state of this computer's section when its server did not start, and the reason it gave
      await mockEval('setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine." });', url);
      const state = tidSel("side-section-state", { server: "local", tone: "bad" });
      await page2.waitForSelector(state, { timeout: 15000 });
      await page2.waitForSelector(tidSel("side-section-reason"), { timeout: 15000 });
      const behind = await colourOf(page2, tidSel("side"), "backgroundColor");
      if (hex(behind) !== P.mantle) say(`the sidebar behind "Not started" is ${hex(behind)}, not Mantle`);
      const bad = await inkOf(page2, state), why = await inkOf(page2, tidSel("side-section-reason"));
      for (const [what, fg, back] of [['"Not started"', bad.fg, behind], ["the reason a start gave", why.fg, why.bg]]) {
        if (!fg || !back) { say(`${what} is not on the page`); continue; }
        const q = contrastOf(fg, back);
        if (q < 3) say(`${what} is ${hex(fg)} on ${hex(back)}, ${two(q)}:1, under 3:1`);
      }
    } finally {
      await mockEval("setServerState('local', 'connected');", url);
      await ctx2.close();
    }

    note(`${flavour}: ${told.join(", ")}; on the page: ${drawn.join(", ")}, ${words.length} words of code`);
  }
}, { viewports, page: false });
