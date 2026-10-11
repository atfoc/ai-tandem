// Proves, on the build that has all six goals, what needs two of them together: the composer (goal 2, and a wait of
// goal 4 in it), the tool cards (goal 5) and the sidebar's rail (goal 1) in each Catppuccin flavour (goal 6).
//   The composer: every state of seed A2 at its least width, "more" open where the toolbar has one; each popup a
//   control opens (a picker's list, the folder's browser, the usage popover), from the toolbar or from "more"; and a
//   branch send on its way: the message in its pending look, the line under it, the banner, the spinner in Send.
//   The tool cards: the threads of seed A5 with every card open, in a chat page and in the panel beside a board of
//   300 px, in a subagent's drawer and in the pane of a run's agent.
//   The rail: beside a chat, a board with its panel, a run and Home; with the pointer on its control, with the
//   keyboard's focus on it, and with its dot while the page is not connected.
// Readable is measured as A6.3 measures it, on computed colours: every text and every icon of the part has 3:1
// against what is behind it. One that has less passes only if it has no less than the same element has in the theme
// the flavour is laid over, or if the goal accepts it (in Latte, the Claude agent's glyph). A mark that is no text
// (the spinner, the focus ring, the dot) is held to the same.
// A flavour changes colours and nothing else: in each one the composer fits its box, no card passes its thread, and
// the toolbar's controls, the cards' parts and the rail are of the same sizes as in the theme under it, so what the
// other goals measured in Light holds in a flavour. And the part is in the flavour: the lines of a change are told
// apart by their ground, their signs are the flavour's ok and danger and have 3:1 on their own line's ground, a
// command's words are in the flavour's code colours, and the rail is on Mantle from the first frame of a reload, with
// no frame of the sidebar or of another theme.
// A state's page is opened once and put in one theme after the other by the picker in the sidebar's foot, as a user
// does it, so the same pending move, the same message on its way and the same open cards are read in all six; the
// rail's pages, whose picker is hidden with the sidebar, are opened in each theme.
// OUT=/tmp/x keeps a screenshot of every stage in every flavour there, for a person's look. PART=composer (or cards,
// rail) runs one of the three.
import fs from "node:fs";
import path from "node:path";
import { act, atRest, cardsFit, check, colourOf, contrastAudit, contrastOf, holds, measureComposer, mockEval, openCards, openPage, paneSize, release, sampleFrames, seed, startMove, toolbarWidths, toolCards, until, waitsSeen } from "../shot.mjs";

// Base and Mantle of @catppuccin/palette 1.8.0, and the theme each flavour is laid over
const FLAVOURS = {
  latte: { under: "light", base: "#eff1f5", mantle: "#e6e9ef" },
  frappe: { under: "dark", base: "#303446", mantle: "#292c3c" },
  macchiato: { under: "dark", base: "#24273a", mantle: "#1e2030" },
  mocha: { under: "dark", base: "#1e1e2e", mantle: "#181825" },
};
const THEMES = ["light", "dark", ...Object.keys(FLAVOURS)];
const FLOOR = 3, OUT = process.env.OUT, PART = process.env.PART;
const CLAUDE = "#d97757"; // the Claude agent's colour in the light theme, which a flavour keeps
const BTN = ".side-foot .theme-btn", MENU = '.side-foot [role="menu"][aria-label="Theme"]';
const MORE = ".composer .more-chip", POP = ".composer .more-pop", ROW = ".composer .composer-tools";
// What opens a popup of the composer: [name, the chip's selector under the row or under "more", the popup's under the composer]
const OPENERS = [
  ["the server's list", ".server-pick > button.tchip", ".server-pick > .menu.up"],
  ["the agent's list", 'button.tchip[title^="Agent"]', '.menu-wrap:has(> button.tchip[title^="Agent"]) > .menu.up'],
  ["the folder's browser", 'button.tchip[title^="Working directory"], button.tchip[title^="Folder on"]', ".menu.up.dirs"],
  ["the model's list", 'button.tchip[title^="Model"]', ".model-pick > .menu.up"],
  ["the effort's list", 'button.tchip[title^="Effort"]', '.menu-wrap:has(> button.tchip[title^="Effort"]) > .menu.up'],
  ["the usage popover", "button.ctx-meter", ".menu.up.usage-pop"],
];
const POPUPS = ["plain-new", "plain-started"]; // the states whose popups are opened: an unstarted chat has every picker, a started one the meter's popover
const SEND = "c_A4_turns"; // the chat whose branch send is held
// The threads of seed A5: [the state, the thread's root]
const CARDS = [["claude"], ["cursor"], ["pi"], ["gaps"], ["big"], ["wide"], ["panel", ".board-panel .thread"], ["junk"], ["sub", ".sub-drawer-body"]];
const VIEWS = [
  ["a chat", { chat: "c_plain" }, ".chat-page .chat-head"],
  ["a board with its panel", { board: "b_arch", chat: "c_board" }, ".board-panel .chat-head"],
  ["a run", { run: "r_live" }, ".run-stage .tl"],
  ["Home", {}, "main.home h2"],
];
const SYNTAX = ["--syn-keyword", "--syn-string", "--syn-number", "--syn-title", "--syn-type", "--syn-attr"];
const TOKENS = ["--bg", "--panel", "--line", "--muted", "--faint", "--accent", "--ok", "--warn", "--danger", ...SYNTAX];

const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");
const two = (n) => Math.floor(n * 100) / 100;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** In the page: the computed colour of each token, read on an element that is drawn in it. */
function tokensInPage(names) {
  const probe = document.createElement("span");
  document.body.append(probe);
  const out = {};
  for (const n of names) { probe.style.color = `var(${n})`; out[n] = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); }
  probe.remove();
  return out;
}

/** In the page: the rail and its control. hit: the control is the element at its own centre. */
function railInPage() {
  const R = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const rail = document.querySelector(".app > .side-rail"), ctl = rail?.querySelector(".side-show"), pane = document.querySelector(".app > .side-pane");
  if (!rail || !ctl) return null;
  const c = ctl.getBoundingClientRect(), at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2), cs = getComputedStyle(ctl);
  return { rail: R(rail), ctl: R(ctl), hit: at === ctl || ctl.contains(at), pane: !!pane && pane.getClientRects().length > 0, h: innerHeight,
    focused: document.activeElement === ctl && ctl.matches(":focus-visible"), ring: `${cs.outlineStyle} ${cs.outlineWidth}`, dot: !!ctl.querySelector(".side-rail-dot") };
}

/** For sampleFrames: null until React has drawn the window; then the frame's theme, whether the rail is the window's
 *  first pane, whether the sidebar's pane is drawn, and the rail's ground. */
function railProbe() {
  const d = document.documentElement, app = document.querySelector(".app");
  if (!app) return null;
  const first = app.firstElementChild, rail = first?.matches(".side-rail") && first.getClientRects().length ? first : null, pane = app.querySelector(":scope > .side-pane");
  return { theme: d.dataset.theme ?? null, flavour: d.dataset.flavour ?? null, rail: !!rail, pane: !!pane && pane.getClientRects().length > 0, bg: rail ? getComputedStyle(rail).backgroundColor : "" };
}

await check("P7.1 the composer, the tool cards and the sidebar's rail in each flavour", async ({ url, browser, fail, note }) => {
  // (the pages' clock stands a second after the mock's start: a label that tells a time is the same in every theme,
  // so an element of a flavour is found again in the theme under it)
  const clock = await mockEval("return T0;", url) + 1000;
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const states = await seed(url), errors = [];
  const state = (section, id) => states.find((s) => s.section === section && s.id === id) ?? (() => { throw new Error(`the seed has no state ${section}.${id}`); })();
  const gone = (page, sel) => until(async () => !await page.locator(sel).count(), 5000);
  const open = (o) => openPage({ url, browser, errors, clock, still: true, ...o });
  const part = async (name, body) => { if (!PART || PART === name) await body(); };

  /** What was read: { [theme]: { [stage]: { rows: Map(element → its least ratio), facts } } }. facts: the sizes a
   *  flavour must leave as they are. */
  const found = Object.fromEntries(THEMES.map((t) => [t, {}]));
  /** Reads a stage in the theme the page is in: the texts and icons inside `only`, and `marks`, each { what, fg, bg }
   *  of [r, g, b]. */
  const stage = async (theme, name, page, only, facts = {}, marks = []) => {
    const P = FLAVOURS[theme], dark = (P?.under ?? theme) === "dark";
    // (still for three frames: no animation runs in these pages, and what a press opened is drawn in the next one)
    if (!await atRest(page, 3)) fail(`${theme}, ${name}: the page did not come to rest`);
    const rows = await contrastAudit(page, { only, canvas: dark ? [18, 18, 18] : [255, 255, 255] });
    for (const m of marks) rows.push({ kind: "mark", what: m.what, where: "", fg: hex(m.fg), bg: hex(m.bg), ratio: m.fg && m.bg ? two(contrastOf(m.fg, m.bg)) : 0 });
    const least = new Map();
    for (const r of rows) { const key = `${r.kind} "${r.what}"${r.where ? ` (${r.where})` : ""}`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
    if (found[theme][name]) fail(`${theme}, ${name}: the check names two stages alike`);
    found[theme][name] = { rows: least, facts };
    if (OUT && P) await page.screenshot({ path: path.join(OUT, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${theme}.png`) });
  };
  /** Puts the page in a theme as a user does, by the picker in the sidebar's foot: what is on the page stays as it
   *  is (a pending move, a message on its way, the open cards) and is read in one theme after the other. */
  const pick = async (page, theme) => {
    const P = FLAVOURS[theme];
    await page.locator(BTN).click();
    await page.locator(`${MENU} [data-theme-pref="${theme}"]`).click();
    const took = await until(() => page.evaluate(([t, f]) => { const d = document.documentElement.dataset; return d.theme === t && (d.flavour ?? null) === f && !document.querySelector('[role="menu"][aria-label="Theme"]'); }, [P?.under ?? theme, P ? theme : null]), 10000);
    if (!took) throw new Error(`a pick of ${theme} in the theme's menu did not put the page in it`);
  };
  /** The composer on the page fits its box. Answers its measure. */
  const fits = async (page, name) => {
    const all = (await measureComposer(page)).filter((c) => !c.none), m = all[0];
    if (all.length !== 1) { fail(`${name}: ${all.length} composers on the page`); return null; }
    if (m.past) fail(`${name}: ${m.past} past the box, the furthest by ${m.furthest} px: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
    if (m.send !== "ok" && m.send !== "none") fail(`${name}: Send is ${m.send}`);
    if (m.docScroll > 0) fail(`${name}: the document scrolls ${m.docScroll} px sideways`);
    return m;
  };

  // ---- the composer
  await part("composer", async () => {
    for (const s of states.filter((x) => x.section === "A2")) {
      const name = `the composer, ${s.id}`;
      const { ctx, page } = await open({ sel: s.sel, ...paneSize(s.pane[0], s.pane[1]), wait: ".composer-box .send" });
      try {
        await act(page, s.act);
        await page.evaluate(() => document.fonts.ready);
        for (const theme of THEMES) {
          const at = `${theme}, ${name}`;
          await pick(page, theme);
          const m = await fits(page, at), bar = await toolbarWidths(page);
          const facts = { box: m?.boxW, row: bar.controls.map((c) => `${c.kind} "${c.label}" ${c.w}`) };
          const more = await page.locator(MORE).count() > 0;
          if (more) {
            await page.locator(MORE).click();
            await page.waitForSelector(POP, { timeout: 5000 });
            facts.held = await page.locator(`${POP} > .more-row`).count();
          }
          await stage(theme, name, page, [".composer"], facts);
          if (more) { await page.keyboard.press("Escape"); if (!await gone(page, POP)) fail(`${at}: Esc did not close the "more" popup`); }
          if (!POPUPS.includes(s.id)) continue;
          for (const [what, chip, popup] of OPENERS) {
            const under = (from) => chip.split(", ").map((c) => `${from} ${c}`).join(", ");
            const inRow = await page.locator(under(`${ROW} >`) + ", " + under(`${ROW} > .menu-wrap >`)).count() > 0;
            if (!inRow && !more) continue; // (the state has no such choice)
            if (!inRow) { await page.locator(MORE).click(); await page.waitForSelector(POP, { timeout: 5000 }); }
            const target = page.locator(under(inRow ? ROW : POP)), sel = `.composer ${popup}`;
            if (await target.count()) {
              await target.first().click();
              await page.waitForSelector(sel, { timeout: 5000 });
              if (what === "the folder's browser") await page.waitForSelector(`${sel} .dir-foot`, { timeout: 8000 });
              await stage(theme, `${name}: ${what}`, page, [sel]);
              // (the folder's browser in the toolbar has no Esc of its own: a press outside closes it)
              if (inRow && what === "the folder's browser") await page.mouse.click(5, 5); else await page.keyboard.press("Escape");
              if (!await gone(page, sel)) fail(`${at}: ${what} did not close`);
            }
            if (!inRow) { await page.keyboard.press("Escape"); if (!await gone(page, POP)) fail(`${at}: Esc did not close the "more" popup after ${what}`); }
          }
        }
      } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
      finally { await ctx.close(); }
    }

    // a branch send on its way, at 300 px: the call is held in the mock, so the wait is read for as long as it takes
    const name = "the composer and the thread, a branch send on its way";
    await mockEval(`flags.send = { chat: "${SEND}", hold: true, noReply: true };`, url);
    const { ctx, page } = await open({ sel: { chat: SEND }, ...paneSize("page", 300), wait: ".thread .msg.assistant" });
    try {
      await startMove(page);
      await page.locator(".composer .composer-input").click();
      await page.keyboard.type("Try it another way");
      await page.keyboard.press("Enter");
      if (!await until(() => holds(url, "send"))) fail(`${name}: the page's call did not reach the mock`);
      for (const theme of THEMES) {
        await pick(page, theme);
        const seen = await waitsSeen(page);
        if (!seen.msgs.some((x) => x.sending) || !seen.send?.spin || seen.lines.length !== 1 || !seen.banner) fail(`${theme}, ${name}: the page does not show the wait: ${JSON.stringify(seen)}`);
        const m = await fits(page, `${theme}, ${name}`);
        const spin = { what: "the spinner in Send", fg: await colourOf(page, ".composer .send .spin", "borderTopColor"), bg: await colourOf(page, ".composer .send", "backgroundColor") };
        await stage(theme, name, page, [".thread", ".composer"], { box: m?.boxW, lines: seen.lines, banner: seen.banner, send: seen.send?.title }, [spin]);
      }
      await release(url, "send");
      if (!await until(async () => !(await waitsSeen(page)).banner)) fail(`${name}: let go, the send did not end`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    finally { await mockEval("delete flags.send;", url); await ctx.close(); }
  });

  // ---- the tool cards
  await part("cards", async () => {
    /** Reads the open cards under root: what passes the thread, and the cards' parts as facts. */
    const cardsOf = async (theme, name, page, root) => {
      const fit = await cardsFit(page, root), cards = await toolCards(page, root);
      if (!fit || !cards?.length) return fail(`${theme}, ${name}: no card under ${root}`);
      if (fit.bad) fail(`${theme}, ${name}: ${[...fit.wide, ...fit.out, ...fit.sideways].join("; ") || `the thread scrolls ${fit.scroll} px sideways`}`);
      if (cards.some((c) => !c.open)) fail(`${theme}, ${name}: ${cards.filter((c) => !c.open).length} of ${cards.length} cards are not open`);
      await stage(theme, name, page, [`${root} .tool`], { width: fit.width, cards: cards.map((c) => `${c.label} | ${c.hint} | ${c.parts.map((p) => [p.part, p.title ?? p.text ?? p.path, p.box?.join("x")].filter(Boolean).join(" ")).join(", ")}`) });
    };
    /** The thread of Claude's items is in the theme: a change's lines by their ground and their signs, a command's
     *  words, a failed output's box. */
    const inTheme = async (theme, name, page) => {
      const P = FLAVOURS[theme], say = (line) => fail(`${theme}, ${name}: ${line}`);
      const t = await page.evaluate(tokensInPage, TOKENS), tone = (sel, prop) => colourOf(page, `.thread ${sel}`, prop).then(hex);
      const ground = { add: await tone(".diff-row.add", "backgroundColor"), del: await tone(".diff-row.del", "backgroundColor"), same: await tone(".diff-row:not(.add, .del, .skip)", "backgroundColor") };
      if (new Set(Object.values(ground)).size !== 3) say(`an added line (${ground.add}), a removed one (${ground.del}) and one that stays (${ground.same}) are not told apart by their ground`);
      if (ground.same !== hex(t["--bg"])) say(`a change is on ${ground.same}, not on the background ${hex(t["--bg"])}`);
      for (const [what, sel, token] of [["an added line's sign", ".diff-row.add .diff-sign", "--ok"], ["a removed line's sign", ".diff-row.del .diff-sign", "--danger"], ["the count of added lines", ".tool-add", "--ok"], ["the count of removed lines", ".tool-del", "--danger"], ["a failed output's flag", ".tool-flag", "--danger"]])
        if (await tone(sel, "color") !== hex(t[token])) say(`${what} is drawn in ${await tone(sel, "color")}, not in ${token} ${hex(t[token])}`);
      // (in a flavour a sign has its floor on its own line's ground, with no leave for what Light has: ok and danger are the flavour's)
      if (P) for (const [what, row] of [['the "+" of an added line', ".diff-row.add"], ['the "−" of a removed line', ".diff-row.del"]]) {
        const q = contrastOf(await colourOf(page, `.thread ${row} .diff-sign`, "color"), await colourOf(page, `.thread ${row}`, "backgroundColor"));
        if (q < FLOOR) say(`${what} is ${two(q)}:1 on its line's ground, under ${FLOOR}:1`);
      }
      const edges = await page.evaluate(() => [...document.querySelectorAll(".thread .tool-part")].filter((p) => /^Output/.test(p.querySelector(".tool-sub")?.textContent ?? "")).map((p) => [p.matches(".failed"), getComputedStyle(p.querySelector(".tool-text")).borderTopColor]));
      if (!edges.some(([failed]) => failed) || edges.filter(([failed]) => failed).some(([, c]) => edges.some(([failed, d]) => !failed && d === c))) say(`a failed output's box has the border of one that did not fail: ${JSON.stringify(edges)}`);
      const words = await page.evaluate(() => [...new Set([...document.querySelectorAll('.thread .tool-text code.hljs span[class^="hljs-"]')].map((e) => getComputedStyle(e).color))].map((c) => c.match(/[\d.]+/g).slice(0, 3).map(Number)));
      const code = new Set([...SYNTAX, "--faint", "--muted", "--danger"].map((n) => hex(t[n])));
      if (!words.length) say("no word of a command is coloured as code");
      for (const w of words) if (!code.has(hex(w))) say(`a word of a command is drawn in ${hex(w)}, which is none of the theme's code colours`);
      if (P && (hex(t["--bg"]) !== P.base || await tone(".tool", "backgroundColor") !== P.mantle)) say(`a card is on ${await tone(".tool", "backgroundColor")} and its parts on ${hex(t["--bg"])}, not on Mantle ${P.mantle} and Base ${P.base}`);
    };
    for (const [id, root = ".thread"] of CARDS) {
      const s = state("A5", id), name = `the tool cards, ${id}`;
      // (a subagent's drawer lies over the right of the window: in a wide one it leaves the picker free)
      const { ctx, page } = await open({ sel: s.sel, ...(id === "sub" ? { size: [1200, 900] } : paneSize(s.pane?.[0] ?? "page", 300, 900)), wait: s.act ? ".thread .msg" : s.see });
      try {
        await act(page, s.act);
        await page.waitForSelector(s.see, { timeout: 8000 });
        await openCards(page, root);
        for (const theme of THEMES) {
          await pick(page, theme);
          await cardsOf(theme, name, page, root);
          if (id === "claude") await inTheme(theme, name, page);
        }
      } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
      finally { await ctx.close(); }
    }
    // the pane of a run's agent: the merge agent of T27, whose command failed
    const name = "the tool cards, a run agent's pane";
    const { ctx, page } = await open({ sel: { run: "r_live" }, size: [1400, 900], wait: ".tl-row" });
    try {
      await page.locator(".tl-row", { has: page.locator(".tl-id", { hasText: /^T27$/ }) }).first().click();
      const link = page.locator('button[data-agent$="T27-merge"]').first();
      await link.waitFor({ timeout: 8000 });
      await link.click();
      await page.waitForSelector(".thread.read-only .tool", { timeout: 8000 });
      await openCards(page, ".thread.read-only");
      for (const theme of THEMES) { await pick(page, theme); await cardsOf(theme, name, page, ".thread.read-only"); }
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    finally { await ctx.close(); }
  });

  // ---- the rail: the sidebar is hidden, and its picker with it, so the page is opened in each theme
  await part("rail", async () => {
    for (const theme of THEMES) for (const [view, sel, see] of VIEWS) {
      const P = FLAVOURS[theme], name = `the rail beside ${view}`, say = (line) => fail(`${theme}, ${name}: ${line}`);
      const { ctx, page } = await open({ sel, size: [1280, 800], ls: { "aiwb.side": "hidden", "aiwb.theme": theme }, wait: ".app > .side-rail .side-show" });
      try {
        await page.waitForSelector(see, { timeout: 15000 });
        const r = await page.evaluate(railInPage), t = await page.evaluate(tokensInPage, TOKENS);
        const ground = await colourOf(page, ".side-rail", "backgroundColor"), line = hex(await colourOf(page, ".side-rail", "borderRightColor"));
        if (r.pane) say("the sidebar's pane is drawn");
        if (!r.hit) say("the rail's control is not the element at its own centre");
        if (r.rail[0] !== 0 || r.rail[1] !== 0 || r.rail[3] !== r.h) say(`the rail is at ${r.rail[0]}, ${r.rail[1]} and ${r.rail[3]} px tall in a window of ${r.h}`);
        if (hex(ground) !== hex(t["--panel"]) || line !== hex(t["--line"])) say(`the rail is on ${hex(ground)} with a line of ${line}, not on --panel ${hex(t["--panel"])} with --line ${hex(t["--line"])}`);
        if (P && hex(ground) !== P.mantle) say(`the rail is on ${hex(ground)}, not on Mantle ${P.mantle}`);
        const facts = { rail: r.rail, ctl: r.ctl };
        await stage(theme, name, page, [".side-rail"], facts);
        if (view === "Home") {
          // the keyboard's focus: the rail's control is the first stop of the page
          await page.keyboard.press("Tab");
          const f = await page.evaluate(railInPage);
          if (!f.focused || !/^solid [1-9]/.test(f.ring)) say(`after Tab the control ${f.focused ? "has" : "has not"} the keyboard's focus, and its ring is "${f.ring}"`);
          await stage(theme, `${name}, the focus on its control`, page, [".side-rail"], facts, [{ what: "the focus ring of the rail's control", fg: await colourOf(page, ".side-rail .side-show", "outlineColor"), bg: ground }]);
          await page.evaluate(() => document.activeElement?.blur());
          // the dot: the page is not connected
          try {
            await mockEval("flags.streamDown = true; dropStreams();", url);
            await page.waitForSelector(".side-rail .side-show .side-rail-dot", { timeout: 30000 });
            const dot = await colourOf(page, ".side-rail .side-rail-dot", "backgroundColor");
            if (hex(dot) !== hex(t["--warn"])) say(`the dot is ${hex(dot)}, not --warn ${hex(t["--warn"])}`);
            await stage(theme, `${name}, not connected`, page, [".side-rail"], facts, [{ what: "the rail's dot", fg: dot, bg: ground }]);
          } finally { await mockEval("delete flags.streamDown;", url); }
        }
        await page.locator(".side-rail .side-show").hover();
        await stage(theme, `${name}, the pointer on its control`, page, [".side-rail"], facts);
        if (view !== "a chat") continue;
        // a reload: the rail, on its ground, in the theme, from the first frame React draws
        const want = await page.evaluate(railProbe), sampler = await sampleFrames(page, railProbe, { fromLoad: true });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(see, { timeout: 15000 });
        await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 });
        const frames = await sampler.stop(), bad = frames.values.filter((v) => !same(v, want));
        if (!frames.values.length) say("after a reload the sampler saw no frame with the window drawn");
        if (bad.length) say(`after a reload ${bad.length} of the ${frames.values.length} frames React drew were not ${JSON.stringify(want)}, the first ${JSON.stringify(bad[0])}`);
      } catch (e) { say(e.message.split("\n")[0]); }
      finally { await ctx.close(); }
    }
  });
  for (const e of errors) fail(`page error: ${e}`);

  for (const [flavour, P] of Object.entries(FLAVOURS)) {
    const mine = found[flavour], base = found[P.under];
    let audited = 0;
    const asToday = new Map(), accepted = new Map(), parts = {};
    for (const stage of Object.keys(base)) if (!mine[stage]) fail(`${flavour}: no stage "${stage}", which ${P.under} has`);
    for (const [stage, { rows, facts }] of Object.entries(mine)) {
      if (!rows.size) fail(`${flavour}, ${stage}: no text and no icon was read: the part is not on screen`);
      audited += rows.size;
      const of = /^the (composer|tool cards|rail)/.exec(stage)?.[1] ?? stage;
      parts[of] = (parts[of] ?? 0) + rows.size;
      if (!base[stage]) { fail(`${flavour}: the stage "${stage}" is not in ${P.under}`); continue; }
      if (!same(facts, base[stage].facts)) fail(`${flavour}, ${stage}: its sizes are not those of ${P.under}: ${JSON.stringify(facts)} and ${JSON.stringify(base[stage].facts)}`);
      for (const [key, r] of rows) {
        if (r.ratio >= FLOOR) continue;
        const was = base[stage].rows.get(key);
        if (flavour === "latte" && r.kind === "icon" && r.fg === CLAUDE) accepted.set(`${r.fg} on ${r.bg}`, r.ratio);
        else if (was && r.ratio >= was.ratio - 0.005) asToday.set(`${r.kind} ${r.where ? r.where.split(" > ").pop() : `"${r.what}"`}`, `${r.ratio} (${P.under} ${was.ratio})`);
        else fail(`${flavour}, ${stage}: ${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${P.under}` : ` (${P.under} has no such element)`}`);
      }
    }
    const list = (m) => [...m].map(([k, v]) => `${k} ${v}`).join(", ") || "nothing";
    note(`${flavour}: ${audited} texts, icons and marks in ${Object.keys(mine).length} stages (${Object.entries(parts).map(([k, n]) => `${k} ${n}`).join(", ")}), each stage of the sizes it has in ${P.under}; under ${FLOOR}:1 and no weaker than in ${P.under}: ${list(asToday)}; accepted by the goal (the Claude glyph): ${list(accepted)}`);
  }
});
