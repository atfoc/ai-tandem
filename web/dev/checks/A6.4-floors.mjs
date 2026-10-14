// Proves A6.4: in each Catppuccin flavour the contrast floors hold, on the colours the browser computes. The floors
// are the goal's (plans/composer-ui-improvements-goals.md, section 8), stated here a second time, apart from
// src/logic/flavours.ts: 4.5:1 on the background for text, muted text, the accent, danger and text on a filled
// button; 3:1 for faint text, ok and warning, for the code colours on a code block, and for a switch's knob on its
// track, on and off. Each is read twice: as the token's computed colour, and on elements of the page that are drawn
// in it (a text of each kind on the background, the filled buttons, the words of a code block, the switch).
// It also proves that the page is in the flavour (its background, panes, text and accent are Base, Mantle, Text and
// Mauve of the palette, the theme under it Latte's light or the others' dark) and that the build carries the
// palette's licence notice.
import fs from "node:fs";
import path from "node:path";
import { check, colourOf, contrastAudit, contrastOf, mockEval, openPage, seed } from "../shot.mjs";

// Base, Mantle, Text and Mauve of @catppuccin/palette 1.8.0
const FLAVOURS = {
  latte: { theme: "light", base: "#eff1f5", mantle: "#e6e9ef", text: "#4c4f69", mauve: "#8839ef" },
  frappe: { theme: "dark", base: "#303446", mantle: "#292c3c", text: "#c6d0f5", mauve: "#ca9ee6" },
  macchiato: { theme: "dark", base: "#24273a", mantle: "#1e2030", text: "#cad3f5", mauve: "#c6a0f6" },
  mocha: { theme: "dark", base: "#1e1e2e", mantle: "#181825", text: "#cdd6f4", mauve: "#cba6f7" },
};
const ON_BG = [["--text", 4.5, "text"], ["--muted", 4.5, "muted text"], ["--accent", 4.5, "the accent"], ["--danger", 4.5, "danger"],
  ["--faint", 3, "faint text"], ["--ok", 3, "ok"], ["--warn", 3, "warning"]];
const CODE = { keyword: "--syn-keyword", string: "--syn-string", number: "--syn-number", title: "--syn-title", type: "--syn-type", attr: "--syn-attr" };
const TOKENS = ["--bg", "--panel", "--text", "--accent", "--accent-fill", "--on-accent", "--danger-fill", "--on-danger", "--line-2", "--knob", "--knob-on",
  ...ON_BG.map((p) => p[0]), ...Object.values(CODE)];

const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const two = (n) => (Math.floor(n * 100) / 100).toFixed(2);

/** In the page: the computed colour of each token, read on an element that is drawn in it. */
function tokensInPage(names) {
  const probe = document.createElement("span");
  document.body.append(probe);
  const out = {};
  for (const n of names) { probe.style.color = `var(${n})`; out[n] = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); }
  probe.remove();
  return out;
}
/** In the page: every word of a code block that has a colour of its own: { kind, fg, bg } by the class highlight.js
 *  gave it, as styles.css groups the classes. */
function codeInPage() {
  const KIND = [["keyword", /^hljs-keyword$/], ["string", /^hljs-string$/], ["number", /^hljs-(number|literal)$/], ["type", /^hljs-(built_in|type)$/], ["attr", /^hljs-(attr|property)$/]];
  const nums = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  return [...document.querySelectorAll(".md-code pre [class*=hljs-]")].map((e) => {
    const cls = [...e.classList];
    const kind = cls.includes("hljs-title") ? (cls.includes("class_") ? "type" : "title") : KIND.find(([, re]) => cls.some((c) => re.test(c)))?.[0];
    return kind && { kind, word: e.textContent.slice(0, 20), fg: nums(getComputedStyle(e).color), bg: nums(getComputedStyle(e.closest(".md-code")).backgroundColor) };
  }).filter(Boolean);
}

await check("A6.4 the contrast floors hold in each flavour, on computed colours", async ({ url, browser, dist, fail, note }) => {
  await seed(url, "A6");
  const css = dist ? fs.readFileSync(path.join(dist, "main.css"), "utf8") : await fetch(url + "/main.css").then((r) => r.text());
  if (!/Copyright \(c\) 2021 Catppuccin/.test(css) || !/The above copyright notice and this permission notice shall be included/.test(css) || !/@catppuccin\/palette 1\.8\.0/.test(css))
    fail("the build's main.css does not carry the palette's licence notice (its copyright line, its permission notice, the package and its version)");

  for (const [flavour, P] of Object.entries(FLAVOURS)) {
    const { ctx, page } = await openPage({ url, browser, sel: { chat: "c_A6_cards" }, size: [1280, 1500], ls: { "aiwb.theme": flavour }, wait: ".thread .perm.pending .perm-actions", still: true });
    const say = (line) => fail(`${flavour}: ${line}`);
    try {
      const data = await page.evaluate(() => ({ ...document.documentElement.dataset, scheme: getComputedStyle(document.documentElement).colorScheme }));
      if (data.theme !== P.theme || data.flavour !== flavour || data.scheme !== P.theme) say(`<html> has data-theme "${data.theme}", data-flavour "${data.flavour}" and color-scheme ${data.scheme}: a flavour is laid over ${P.theme}`);
      const t = await page.evaluate(tokensInPage, TOKENS), c = (name) => contrastOf(t[name], t["--bg"]);
      for (const [name, want] of [["--bg", P.base], ["--panel", P.mantle], ["--text", P.text], ["--accent", P.mauve], ["--accent-fill", P.mauve], ["--on-accent", P.base]])
        if (hex(t[name]) !== want) say(`${name} is ${hex(t[name])}, the palette's colour for it is ${want}`);

      // the tokens
      const told = [];
      const floor = (what, ratio, least, how) => { told.push(`${what} ${two(ratio)}`); if (ratio < least) say(`${what}: ${how} is ${two(ratio)}:1, under ${least}:1`); };
      for (const [name, least, what] of ON_BG) floor(what, c(name), least, `${name} ${hex(t[name])} on the background ${hex(t["--bg"])}`);
      floor("on a filled button", contrastOf(t["--on-accent"], t["--accent-fill"]), 4.5, `--on-accent ${hex(t["--on-accent"])} on --accent-fill ${hex(t["--accent-fill"])}`);
      floor("on a danger button", contrastOf(t["--on-danger"], t["--danger-fill"]), 4.5, `--on-danger ${hex(t["--on-danger"])} on --danger-fill ${hex(t["--danger-fill"])}`);
      for (const [kind, name] of Object.entries(CODE)) floor(`code ${kind}`, contrastOf(t[name], t["--panel"]), 3, `${name} ${hex(t[name])} on a code block ${hex(t["--panel"])}`);
      floor("knob off", contrastOf(t["--knob"], t["--line-2"]), 3, `--knob ${hex(t["--knob"])} on --line-2 ${hex(t["--line-2"])}`);
      floor("knob on", contrastOf(t["--knob-on"], t["--accent-fill"]), 3, `--knob-on ${hex(t["--knob-on"])} on --accent-fill ${hex(t["--accent-fill"])}`);

      // the page: the background, and what is drawn on it in each of those colours
      const ground = { html: await colourOf(page, "html", "backgroundColor"), main: await colourOf(page, ".chat-page", "backgroundColor"), side: await colourOf(page, ".side-pane .side", "backgroundColor") };
      if (hex(ground.html) !== P.base || hex(ground.main) !== P.base) say(`the page's background is ${hex(ground.html)} and the chat's ${hex(ground.main)}, not Base ${P.base}`);
      if (hex(ground.side) !== P.mantle) say(`the sidebar's background is ${hex(ground.side)}, not Mantle ${P.mantle}`);
      // (no text of this chat is a warning: that one is read below, on the notice of a stream that is down)
      const rows = await contrastAudit(page);
      const drawn = [];
      // (a colour with the floor of 3:1 is read on a secondary pane too, where the page has most of its marks: the
      // floor holds there as well. The accent and danger are read on the background only: on a secondary pane
      // Latte's are just under 4.5:1, which the goal accepts)
      for (const [name, least, what] of ON_BG) {
        const mine = rows.filter((r) => r.fg === hex(t[name]) && (r.bg === P.base || (least === 3 && r.bg === P.mantle)));
        if (!mine.length) { if (name !== "--warn") say(`nothing on the page is drawn in ${name} ${hex(t[name])} on the background: ${what} is not read on an element`); continue; }
        drawn.push(`${what} ${mine.length}`);
        for (const r of mine.filter((r) => r.ratio < least)) say(`${what}: "${r.what}" (${r.where}) is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${least}:1`);
      }

      // the filled buttons
      for (const [sel, what, least] of [[".side-head .icon-btn.new", "the sidebar's New button", 4.5], [".thread .perm.pending .btn.danger, .thread .perm.pending .btn.primary", "the permission card's Allow button", 4.5]]) {
        const fg = await colourOf(page, sel, "color"), bg = await colourOf(page, sel, "backgroundColor");
        if (!fg || !bg) { say(`${what} is not on the page (${sel})`); continue; }
        if (hex(bg) === hex(ground.main) || hex(bg) === hex(ground.side)) say(`${what} is not filled: its background ${hex(bg)} is the pane's`);
        floor(what, contrastOf(fg, bg), least, `its text ${hex(fg)} on its fill ${hex(bg)}`);
      }

      // the code block: every kind of word the page colours is in the seed's code
      const words = await page.evaluate(codeInPage);
      for (const [kind, name] of Object.entries(CODE)) {
        const mine = words.filter((w) => w.kind === kind);
        if (!mine.length) { say(`the seed's code has no word of the kind "${kind}"`); continue; }
        for (const w of mine) {
          if (hex(w.fg) !== hex(t[name])) say(`code ${kind}: "${w.word}" is drawn in ${hex(w.fg)}, not in ${name} ${hex(t[name])}`);
          if (hex(w.bg) !== P.mantle) say(`the code block's background is ${hex(w.bg)}, not Mantle ${P.mantle}`);
          const q = contrastOf(w.fg, w.bg);
          if (q < 3) say(`code ${kind}: "${w.word}" is ${hex(w.fg)} on ${hex(w.bg)}, ${two(q)}:1, under 3:1`);
        }
      }

      // the switch, off and on
      const SWITCH = ".side-foot .side-archived .switch";
      const knob = async () => contrastOf(await colourOf(page, SWITCH, "backgroundColor", "::after"), await colourOf(page, SWITCH, "backgroundColor"));
      if (await page.locator(SWITCH).isChecked()) say("the Show archived switch is on in a page that never set it");
      floor("the switch off", await knob(), 3, "the knob of Show archived on its track");
      await page.locator(SWITCH).click();
      if (!await page.locator(SWITCH).isChecked()) say("a click did not turn the Show archived switch on");
      floor("the switch on", await knob(), 3, "the knob of Show archived on its track");

      note(`${flavour}: ${told.join(", ")}; on the page: ${drawn.join(", ")}, ${words.length} words of code`);
    } finally { await ctx.close(); }

    // the state of this computer's section when its server did not start, and the reason it gave
    const { ctx: ctx2, page: page2 } = await openPage({ url, browser, sel: {}, ls: { "aiwb.theme": flavour }, still: true });
    try {
      await mockEval('setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine." });', url);
      const HERE = '.side-section[data-server="local"]';
      await page2.waitForSelector(`${HERE} .side-section-state.bad`, { timeout: 15000 });
      await page2.waitForSelector(`${HERE} .side-section-reason`, { timeout: 15000 });
      const bg = await colourOf(page2, ".side-pane .side", "backgroundColor");
      if (hex(bg) !== P.mantle) fail(`${flavour}: the sidebar behind "Not started" is ${hex(bg)}, not Mantle`);
      for (const [what, sel] of [['"Not started"', `${HERE} .side-section-state.bad`], ["the reason a start gave", `${HERE} .side-section-reason`]]) {
        const fg = await colourOf(page2, sel, "color"), back = what === '"Not started"' ? bg : await colourOf(page2, sel, "backgroundColor"), q = contrastOf(fg, back);
        if (q < 3) fail(`${flavour}: ${what} is ${hex(fg)} on ${hex(back)}, ${two(q)}:1, under 3:1`);
      }
    } finally {
      await mockEval("setServerState('local', 'connected');", url);
      await ctx2.close();
    }
  }
});
