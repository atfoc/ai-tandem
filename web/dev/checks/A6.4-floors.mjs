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
//  - the parts of the sidebar (the New button, the switch, the state "Not started") are read on a page of their own with nothing selected. The phone has
//    no sidebar (H1) and no "Show archived" switch (H2): its page is Home (the filled "+ New", the problem card of a server that did not start) and Settings ›
//    Archived (its own screen: the foot line is muted text on the background, and there is no switch); the switch's knob is the wide layouts' alone. The chat's page is as tall as the old one (1500 px) so the thread is drawn whole.
//  - the code words are told apart by the `dataSet` `tone` the markdown renderer puts on each run (the old check took the highlight.js class), and the
//    switch's knob by the testID `side-knob` (the old one read its `::after`).
//  - R1 added the phone's NEW parts (`phoneParts`), in each flavour, on `contrastAudit` of the part alone (every text and icon the part draws, on what is
//    behind it): Home's rows and server chips; a P1 sheet (a row's: its rows and the red Delete chat… row); a P2 (Move to…, the accent ✓ row); a P4 (the red
//    button and its words); the content bar's title and its 13 pt sub-line; a state word in each tone (ok, wait, warn, bad: Settings › Servers); the toast;
//    the composer's chips and box. Floors (goal 3.1): 4.5:1 for text (all of it is under 18 pt but the large titles, read at 4.5 too), 3:1 for an icon or a
//    control's edge. The permission card's Allow (X2) is read above, as before.
// The floors are the same at every width, and the parity rows say "all": the check runs at the three viewports.
import { atRest, check, colourOf, contrastAudit, contrastOf, mockEval, seed, until } from "../shot.mjs";
import { tokensFor } from "../../../app/src/ui/tokens.ts";
import { byTid, openFoot, press, showHome, tidSel } from "./sel.mjs";
import { openRowSheet, pickAction, rowIn, swipeLeft } from "./rows.mjs";
import { openServersScreen } from "./srv.mjs";

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

/** The phone's page of the sidebar's parts (see its call): Home's filled "+ New", Settings › Archived's foot line, the problem card of a server that did not start. */
async function phoneHome({ flavour, P, T, t, open, say, floor, url }) {
  const { ctx, page } = await open({ sel: {}, ls: { "aiwb.theme": flavour }, still: true, wait: tidSel("home") });
  try {
    const main = await colourOf(page, tidSel("app-root"), "backgroundColor");
    if (hex(main) !== P.base) say(`the phone's page background is ${hex(main)}, not Base ${P.base}`);

    // the filled button
    const plus = await inkOf(page, tidSel("home-new"));
    if (!plus.fg || !plus.bg) say("Home's + New button is not on the page");
    else {
      if (hex(plus.bg) === hex(main)) say(`Home's + New button is not filled: its background ${hex(plus.bg)} is the page's`);
      if (hex(plus.bg) !== T.accentFill || hex(plus.fg) !== T.onAccent) say(`Home's + New button is ${hex(plus.fg)} on ${hex(plus.bg)}, not onAccent ${T.onAccent} on accentFill ${T.accentFill}`);
      floor("Home's + New button", contrastOf(plus.fg, plus.bg), 4.5, `its text ${hex(plus.fg)} on its fill ${hex(plus.bg)}`);
    }

    // the disclosure chevron of a row that opens a screen (the kit's DisclosureChevron; X2 c3): a graphic the row needs, so the non-text floor of 3:1 on its
    // ground. It is `muted` on the phone (the kit swaps the `faint` it is asked in, which is 2.59:1 on Light's white); the wide layouts keep `faint`. Home's
    // rows of a group or a board carry one, as the seed's Home lists a group
    const chev = await page.evaluate(() => {
      const nums = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const out = [];
      for (const path of document.querySelectorAll('[data-testid="home"] svg path[d="M3 1.5 8.5 6.5 3 11.5"]')) {
        const svg = path.closest("svg"), stroke = getComputedStyle(svg).stroke;
        let ground = null;
        for (let e = svg.parentElement; e && !ground; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(.*, 0\)|transparent/.test(c)) ground = nums(c); }
        out.push({ stroke: nums(stroke), ground });
      }
      return out;
    });
    if (!chev.length) say("Home draws no disclosure chevron: the seed's Home has no row that opens a screen");
    for (const c of chev) {
      if (hex(c.stroke) !== T.muted) say(`Home's disclosure chevron is drawn in ${hex(c.stroke)}, not muted ${T.muted}`);
      floor("Home's disclosure chevron", contrastOf(c.stroke, c.ground ?? t.bg), 3, `its ${hex(c.stroke)} on ${hex(c.ground ?? t.bg)}`);
    }

    // Settings › Archived: its own screen, on the background, with no switch; the foot line is muted text
    await openFoot(page, "side-archived");
    await atRest(page, 8);
    if (await byTid(page, "archived-screen").last().locator('[role="switch"]').count()) say("Settings › Archived draws a switch: the phone has no Show archived");
    const screen = await colourOf(page, tidSel("archived-screen"), "backgroundColor"), foot = await colourOf(page, tidSel("archived-foot"), "color");
    if (hex(screen) !== P.base) say(`Settings › Archived's background is ${hex(screen)}, not Base ${P.base}`);
    if (hex(foot) !== T.muted) say(`Archived's foot line is drawn in ${hex(foot)}, not muted ${T.muted}`);
    floor("Archived's foot line", contrastOf(foot, screen), 4.5, `its ${hex(foot)} on the background ${hex(screen)}`);
    await showHome(page);

    // a server that did not start: the problem card above the list, its words read on it
    await mockEval('setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine." });', url);
    await page.waitForSelector(tidSel("problem-card"), { timeout: 15000 });
    const card = await inkOf(page, tidSel("problem-card"));
    if (!card.fg || !card.bg) say("the problem card's words are not on the page");
    else floor("the problem card's words", contrastOf(card.fg, card.bg), 3, `its words ${hex(card.fg)} on the card ${hex(card.bg)}`);
  } finally {
    await mockEval("setServerState('local', 'connected');", url);
    await ctx.close();
  }
}

const AGENTS = /^(Claude Code|Cursor|Pi)$/, MARK = /^[✓✕×‹›]$/;

/** What `contrastAudit` finds under the floors in the part with the selector `only`: text 4.5:1, icons 3:1. Answers the number of rows read (0: the part is not on the page). */
async function auditPart(page, say, what, only, { text = 4.5, icon = 3 } = {}) {
  const rows = await contrastAudit(page, { only: [only] });
  if (!rows.length) { say(`${what}: nothing of it is on the page (${only})`); return 0; }
  for (const r of rows) {
    // (a text drawn in the colour of its ground is one at opacity 0: the title's cross-fade keeps a copy of it in the bar, not on the screen)
    if (r.fg === r.bg) continue;
    // (the agent's mark, in the agent's brand colour, stands beside the agent's name in words: Claude's orange is 2.7:1 on Light's grounds, a brand colour that
    // the lead is told of; a ✓ is a mark, not a word)
    if (r.kind === "icon" && AGENTS.test(r.what)) continue;
    const least = r.kind === "icon" || MARK.test(r.what) ? icon : text;
    if (r.ratio < least) say(`${what}: ${r.kind} "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${least}:1`);
  }
  return rows.length;
}

/** The phone's new parts of R1 (see the header): Home, a P1, a P2, a P4, the toast (Home of the seed UXH2), the content bar, the composer's chips and box
 *  (UXC2.new), a state word in each tone (Settings › Servers of UXS2). Each read in the flavour, on the colours the browser computes. */
async function phoneParts({ flavour, open, say, url, note }) {
  const read = [];
  const part = async (page, what, only, o) => { const n = await auditPart(page, (line) => say(line), what, only, o); if (n) read.push(`${what} ${n}`); };
  const hold = { "aiwb.uicheck.nolocal": "1", "aiwb.home": JSON.stringify({ server: "h2_studio", groups: [] }), "aiwb.theme": flavour };

  // Home, its rows and chips; a row's sheet (P1), Move to… (P2), Delete chat… asks (P4), a full swipe's toast
  await seed(url, "UXH2");
  await mockEval('uxh1Show(["h2_studio", "h2_build"]);', url);
  {
    const { ctx, page } = await open({ ls: hold, still: true, wait: "" });
    try {
      await byTid(page, "home").first().waitFor({ state: "visible", timeout: 15000 });
      await byTid(page, "home-row").first().waitFor({ state: "visible", timeout: 15000 });
      await atRest(page, 8);
      await part(page, "Home's rows and chips", tidSel("home"));
      const row = rowIn(page, "chat", "h2_studio~c_env");
      const sheet = await openRowSheet(page, row, "chat", "h2_studio~c_env");
      await part(page, "a P1 sheet (a row's)", tidSel("row-sheet"));
      await pickAction(page, sheet, "move");
      const picker = byTid(page, "move-sheet").last();
      await picker.waitFor({ state: "visible", timeout: 15000 });
      await part(page, "a P2 (Move to…, the accent ✓ row)", tidSel("move-sheet"));
      await press(page, byTid(picker, "picker-row").first());
      await picker.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
      await until(async () => !await byTid(page, "move-sheet").count(), 8000);
      const sheet2 = await openRowSheet(page, rowIn(page, "chat", "h2_studio~c_flaky"), "chat", "h2_studio~c_flaky");
      await pickAction(page, sheet2, "delete");
      await byTid(page, "confirm-dialog").last().waitFor({ state: "visible", timeout: 15000 });
      await part(page, "a P4 (Delete chat: the red button)", tidSel("confirm-dialog"));
      await press(page, byTid(page, "confirm-cancel").first());
      await until(async () => !await byTid(page, "confirm-dialog").count(), 8000);
      await swipeLeft(page, rowIn(page, "chat", "h2_studio~c_regex"), { full: true });
      await byTid(page, "toast").first().waitFor({ state: "visible", timeout: 15000 });
      // (the toast fades in: it is read once it is whole)
      await page.waitForFunction((sel) => { const e = document.querySelector(sel); if (!e) return false; let o = 1; for (let x = e; x; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o === 1; }, tidSel("toast"), { timeout: 15000 });
      await part(page, "the toast", tidSel("toast"));
    } finally { await ctx.close(); }
  }

  // the content bar (title, 13 pt sub-line) and the composer's chips and box, in a new chat
  await seed(url, "UXC2");
  {
    const { ctx, page } = await open({ sel: { chat: "c_UXC2_new" }, ls: { "aiwb.theme": flavour }, still: true, wait: tidSel("composer-chip-row") });
    try {
      await atRest(page, 8);
      await part(page, "the content bar's title and sub-line", tidSel("chat-head"));
      await part(page, "the composer's chips", tidSel("composer-chip-row"));
      await part(page, "the composer's box", tidSel("composer"));
    } finally { await ctx.close(); }
  }

  // a state word in each tone: Settings › Servers lists connected (ok), connecting (wait), too old (warn) and unreachable, certificate changed (bad)
  await seed(url, "UXS2");
  {
    const { ctx, page } = await open({ sel: {}, ls: { "aiwb.theme": flavour }, still: true, wait: tidSel("home") });
    try {
      await openServersScreen(page);
      await atRest(page, 8);
      const tones = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid="state-word"]')].map((e) => e.dataset.tone))].sort());
      for (const tone of ["bad", "ok", "wait", "warn"]) if (!tones.includes(tone)) say(`Settings › Servers shows no state word of the tone ${tone} (it shows ${tones.join(", ") || "none"})`);
      await part(page, "the state words (ok, wait, warn, bad)", tidSel("state-word"));
    } finally { await ctx.close(); }
  }
  note(`${flavour}: the phone's parts: ${read.join(", ")}`);
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
        // (the phone's card, PermCardPhone, answers with Allow as the accent's filled button (goal 3.5: the accent, not red; T2): onAccent on accentFill.
        // The wide layouts' card (PermCardWide) is unchanged and keeps its danger button: onDanger on dangerFill)
        const [fill, ink] = viewport === "phone" ? ["accentFill", "onAccent"] : ["dangerFill", "onDanger"];
        if (hex(allow.bg) !== T[fill] || hex(allow.fg) !== T[ink]) say(`the permission card's Allow button is ${hex(allow.fg)} on ${hex(allow.bg)}, not ${ink} ${T[ink]} on ${fill} ${T[fill]}`);
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

    // the sidebar's page: nothing selected. The phone has no sidebar: Home is its first screen, with "+ New" and the problem card in place of the
    // sidebar's New button and its section's state, and Settings › Archived (H2's own screen, no "Show archived" switch) in place of the switch
    if (viewport === "phone") { await phoneHome({ flavour, P, T, t, open, say, floor, url }); await phoneParts({ flavour, open, say, url, note }); await seed(url, "A6"); }
    else {
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
    }

    note(`${flavour}: ${told.join(", ")}; on the page: ${drawn.join(", ")}, ${words.length} words of code`);
  }

  // the phone's new parts again in the plain light and dark themes (the loop above is the four flavours; these two are what most people have)
  if (viewport === "phone") for (const theme of ["light", "dark"]) await phoneParts({ flavour: theme, open, say: (line) => fail(`${theme}: ${line}`), url, note });
}, { viewports, page: false });
