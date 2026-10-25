// P7.1 ported (AD-80; packages K3, S6, S8, S9 and the shell): what needs two goals together (the composer, the tool cards, the sidebar's rail, and the
// flavours of goal 6), on the new build.
//   The composer: every state of seed A2 at its least width, "more" open where the toolbar has one; each popup a control opens (a picker's list,
//   the folder's browser, the usage popover), from the toolbar or from "more"; and a branch send on its way: the message in its pending look,
//   the line under it, the banner, the spinner in Send.
//   The tool cards: the threads of seed A5 with every card open, in a chat page and in the panel beside a board of 300 px, and in a subagent's drawer.
//   The rail (the desktop and the tablet: the phone has no sidebar to hide, AD-71): beside a chat, a board with its panel and Home; with the pointer
//   on its control, with the keyboard's focus on it, and with its dot while the page is not connected.
// Readable is measured as A6.3 measures it, on computed colours: every text and every icon of the part has 3:1 against what is behind it. One that
// has less passes only if it has no less than the same element has in the theme the flavour is laid over, or if the goal accepts it (in Latte, the
// Claude agent's glyph). A mark that is no text (the spinner, the focus ring, the dot) is held to the same.
// A flavour changes colours and nothing else: in each one the composer fits its box, no card passes its thread, and the toolbar's controls, the
// cards' parts and the rail are of the same sizes as in the theme under it, so what the other checks measured in Light holds in a flavour. And the
// part is in the flavour: the lines of a change are told apart by their ground, their signs are the flavour's ok and danger and have 3:1 on their own
// line's ground, a command's words are in the flavour's code colours (the tokens of app/src/ui/tokens.ts, which the page draws from), and the rail
// is on Mantle from the first frame of a reload, with no frame of the sidebar or of another theme.
// A state's page is opened once in each theme (the choice saved, `aiwb.theme`), where the old check put one page in the six by the picker in the
// sidebar's foot (a page of 300 px has no sidebar on the new build: a window under 700 px is the phone layout). So the cards are opened in each page,
// and the branch send is made in each (the mock is seeded and the call held anew). The clock is not pinned as the old check pinned it (a pinned
// clock stops the sheets' animation; neither the composer nor the cards tell a time).
// On the phone the choice is made in Settings > Appearance (A6.1, A6.2 and UX.S1 prove that); this check opens each page with the saved value, as it
// does at the other two viewports, and waits for the app by its own signs, not for the sidebar's foot.
// At the phone (ux-improvements C2) the choices are the chips of the chip row and the popups are their sheets: the row's chips (kind, label, width) are the
// facts a flavour must leave as they are, and each chip's sheet (agent-sheet, folder-sheet, model-sheet with the effort control, sub-sheet) is a stage of its
// own, opened with composer.mjs' openChoice and closed with closeChoice; the usage popover opens from the ring.
// OUT=/tmp/x keeps a screenshot of every stage in every flavour there, for a person's look. PART=composer (or cards, rail) runs one of the three.
// Ports dev/checks/P7.1-flavours.mjs. Deviations: the pages as said above; the windows are the desktop's (a pane of 300 px is a window of 300, a
// panel beside a board is the panel at its minimum of 300 in a wide window) and the tablet's and the phone's own; at those two the stages of the
// composer are the states that have a popup and a few more (the popups are sheets there), the desktop reads every state.
import fs from "node:fs";
import path from "node:path";
import { atRest, check, colourOf, contrastAudit, contrastOf, holds, mockEval, paneSize, release, sampleFrames, seed, until } from "../shot.mjs";
import { cardsFit, openCards, openSubSteps, toolCards } from "./cards.mjs";
import { MORE, POP, SEES, chip, closeChoice, countOf, frame, measureComposer, openAt, openChoice, openState, phoneChip, placesOf, playable, toolbarWidths } from "./composer.mjs";
import { startMove, typeAndSend, waitsSeen } from "./fork.mjs";
import { editHere } from "./boarddraw.mjs";
import { act, byTid, hover, layoutNow, press, tidSel } from "./sel.mjs";
import { tokensFor } from "../../../app/src/ui/tokens.ts";

// Alone on a free machine one run of the three viewports takes about 980 s (phone 255, tablet 298, desktop 425: 8 themes of every composer
// state and tool-card thread); twice that for a loaded machine. (The runner's 600 s was the cause of "it had not ended after 600 s".)
export const limit = 2000;

export const viewports = ["desktop", "tablet", "phone"];

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
// What opens a popup of the composer: [name, the chip's kind ("meter": the context ring), the popup's testID]
const OPENERS = [
  ["the agent's list", "agent", "picker"],
  ["the folder's browser", "folder", "dirs"],
  ["the model's list", "model", "picker"],
  ["the effort's list", "effort", "picker"],
  ["the usage popover", "meter", "usage-pop"],
];
// The phone's: [name, the chip's kind ("meter": the context ring), the sheet's or popup's testID]
const PHONE_OPENERS = [
  ["the agent's sheet", "agent", "agent-sheet"],
  ["the folder's sheet", "folder", "folder-sheet"],
  ["the model's sheet", "model", "model-sheet"],
  ["the subagents' sheet", "subagents", "sub-sheet"],
  ["the Context and usage sheet", "meter", "usage-sheet"], // (the phone's ring opens T3's sheet)
];
/** The control of a kind under a row or a popup: a chip, or the context ring. */
const opener = (from, kind) => (kind === "meter" ? byTid(from, "ctx-meter") : chip(from, kind, { fixed: false }));
const POPUPS = ["plain-new", "plain-started"]; // the states whose popups are opened: an unstarted chat has every picker, a started one the meter's popover
const FEW = ["plain-new", "plain-started", "plain-new-long", "plain-ctxerr", "plain-noagent", "plain-off-new", "plain-remote-new", "board-new", "board-started", "board-longname"]; // (the tablet and the phone)

const SEND = "c_A4_turns"; // the chat whose branch send is held
// The threads of seed A5: [the state, the thread's root]. A pane of 300 px at the desktop is a window of 300 px (a page) or the panel at its minimum
// in a wide window (the panel); a drawer is read in a wide window, where it lies beside the page. The tablet and the phone have the device's own.
const CARDS = [["claude"], ["cursor"], ["pi"], ["gaps"], ["big"], ["wide"], ["panel"], ["junk"], ["sub", "sub-drawer-body"]];
const CARD_WINDOWS = { page: { size: [300, 900] }, panel: { size: [1280, 900], ls: { "aiwb.widths": JSON.stringify({ side: 264, panel: 300 }) } }, sub: { size: [1200, 900] } };
const VIEWS = [
  ["a chat", { chat: "c_plain" }, "chat-head"],
  ["a board with its panel", { board: "b_arch", chat: "c_board" }, "chat-head"],
  ["Home", {}, "home"],
];
const SYNTAX = ["synKeyword", "synString", "synNumber", "synTitle", "synType", "synAttr"];

const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");
const two = (n) => Math.floor(n * 100) / 100;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** In the page: the rail and its control. hit: the control is the element at its own centre. */
function railInPage() {
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  const R = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const rail = q("side-rail"), ctl = q("side-show"), pane = q("side-pane");
  if (!rail || !ctl) return null;
  const c = ctl.getBoundingClientRect(), at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2), cs = getComputedStyle(ctl);
  return { rail: R(rail), ctl: R(ctl), hit: at === ctl || ctl.contains(at), pane: !!pane && pane.getClientRects().length > 0, h: innerHeight,
    focused: document.activeElement === ctl && ctl.matches(":focus-visible"), ring: `${cs.outlineStyle} ${cs.outlineWidth}`, dot: !!q("side-rail-dot") };
}

/** For sampleFrames: null until React has drawn the window; then the frame's theme, whether the rail is there, whether the sidebar's pane is
 *  drawn, and the rail's ground. */
function railProbe() {
  const app = document.querySelector('[data-testid="app"]');
  if (!app) return null;
  const d = document.documentElement.dataset, rail = app.querySelector(':scope > [data-testid="side-rail"]'), pane = app.querySelector('[data-testid="side-pane"]');
  return { theme: d.theme ?? null, flavour: d.flavour ?? null, rail: !!rail, pane: !!pane && pane.getClientRects().length > 0, bg: rail ? getComputedStyle(rail).backgroundColor : "" };
}

await check("P7.1 the composer, the tool cards and the sidebar's rail in each flavour", async ({ url, viewport, layout, open, fail, note }) => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  // (every state is opened at 300 px, the phone layout, where a chat on a server with no agent installed has no composer: V1's no-agent bar stands in
  // the box's place, goal 3.7.1, and UX.V1 · 1 and R1's `composer.v1-no-agent` read it; there is no box here to measure)
  const NO_BOX = ["plain-noagent-installed"];
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout) && !NO_BOX.includes(s.id) && (layout === "desktop" || FEW.includes(s.id)));
  const gone = (page, id) => until(async () => !await byTid(page, id).count(), 5000);
  const part = async (name, body) => { if (!PART || PART === name) await body(); };

  /** What was read: { [theme]: { [stage]: { rows: Map(element → its least ratio), facts } } }. facts: the sizes a flavour must leave as they are. */
  const found = Object.fromEntries(THEMES.map((t) => [t, {}]));
  /** Reads a stage in the theme the page is in: the texts and icons inside `only`, and `marks`, each { what, fg, bg } of [r, g, b]. */
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
    if (OUT && P) await page.screenshot({ path: path.join(OUT, `${viewport}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${theme}.png`) });
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
    for (const s of states) {
      const name = `the composer, ${s.id}`;
      for (const theme of THEMES) {
        const at = `${theme}, ${name}`;
        // (a board opens as a reader's, in view mode, until "Edit here" (board-take, since 848862a); the state that selects every shape on the canvas
        // needs the writer's canvas, so the window takes the board once the page is open, before the state's act)
        const openState = s.act === "select" ? async (o) => { const r = await open(o); await editHere(r.page); return r; } : open;
        const { page, ctx } = await openAt(openState, s, layout, 300, { ls: { "aiwb.theme": theme }, still: true });
        try {
          await frame(page);
          const m = await fits(page, at), phone = (await placesOf(page))?.phone, bar = phone ? null : await toolbarWidths(page);
          // (the phone's row of chips: kind, label and width of each; no "more" chip)
          const facts = { box: m?.boxW, row: bar ? bar.controls.map((c) => `${c.kind} "${c.label}" ${c.w}`) : await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-chip-row"] [data-testid="tchip"]')].map((c) => `${c.dataset.kind} "${c.textContent.replace(/[⌄▾]/g, "").trim()}" ${Math.round(c.getBoundingClientRect().width * 10) / 10}`)) };
          const more = await page.locator(MORE).count() > 0;
          if (more) {
            await press(page, page.locator(MORE));
            await page.waitForSelector(POP, { timeout: 5000 });
            facts.held = await byTid(page, "more-row").count();
          }
          await stage(theme, name, page, [tidSel("composer"), tidSel("more-pop")], facts);
          if (more) { await page.keyboard.press("Escape"); if (!await gone(page, "more-pop")) fail(`${at}: Esc did not close the "more" popup`); }
          if (!POPUPS.includes(s.id)) continue;
          if (phone) { // the chips' sheets (a started chat has no chip: its ring's popover)
            for (const [what, kind, popup] of PHONE_OPENERS) {
              const target = kind === "meter" ? byTid(page, "composer-phone-tools").locator(tidSel("ctx-meter")) : phoneChip(page, kind);
              if (!await target.count()) continue; // (the state has no such choice)
              if (kind === "meter") await press(page, target.first()); else await openChoice(page, kind);
              await page.waitForSelector(tidSel(popup), { timeout: 5000 });
              if (kind === "folder") await byTid(page, "dir-use").first().waitFor({ state: "visible", timeout: 8000 });
              await stage(theme, `${name}: ${what}`, page, [tidSel(popup)]);
              if (kind === "meter") await page.keyboard.press("Escape"); else await closeChoice(page);
              if (!await gone(page, popup)) fail(`${at}: ${what} did not close`);
            }
            continue;
          }
          for (const [what, kind, opens] of OPENERS) {
            // (a ring in a window under 700 px opens T3's "Context and usage" sheet, not the popover: A2.4-usage says which; here it is held in each flavour)
            let popup = opens;
            const inRow = await opener(byTid(page, "composer-tools"), kind).count() > 0;
            if (!inRow && !more) continue; // (the state has no such choice)
            if (!inRow) { await press(page, page.locator(MORE)); await page.waitForSelector(POP, { timeout: 5000 }); }
            const target = opener(inRow ? byTid(page, "composer-tools") : byTid(page, "more-pop"), kind);
            if (await target.count()) {
              await press(page, target.first());
              if (kind === "meter") popup = await until(async () => (await byTid(page, "usage-sheet").count() ? "usage-sheet" : await byTid(page, opens).count() ? opens : null), 5000) ?? opens;
              await page.waitForSelector(tidSel(popup), { timeout: 5000 });
              if (what === "the folder's browser") await byTid(page, "dir-use").first().waitFor({ state: "visible", timeout: 8000 });
              await stage(theme, `${name}: ${what}`, page, [tidSel(popup)]);
              await page.keyboard.press("Escape");
              if (!await gone(page, popup)) fail(`${at}: ${what} did not close`);
            }
            if (!inRow) { await page.keyboard.press("Escape"); if (!await gone(page, "more-pop")) fail(`${at}: Esc did not close the "more" popup after ${what}`); }
          }
        } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
        finally { await ctx.close(); }
      }
    }

    // a branch send on its way, at 300 px: the call is held in the mock, so the wait is read for as long as it takes. A page is made in each theme, with
    // the mock seeded and the call held anew.
    {
      const name = "the composer and the thread, a branch send on its way", said = "Try it another way", win = layout === "desktop" ? paneSize("page", 300) : {};
      for (const theme of THEMES) {
        const at = `${theme}, ${name}`;
        await seed(url, "A4");
        await mockEval(`flags.send = { chat: "${SEND}", hold: true, noReply: true };`, url);
        const { ctx, page } = await open({ sel: { chat: SEND }, wait: tidSel("msg"), ...win, ls: { ...win.ls, "aiwb.theme": theme }, still: true });
        try {
          await startMove(page);
          await typeAndSend(page, said);
          if (!await until(() => holds(url, "send"))) fail(`${at}: the page's call did not reach the mock`);
          let seen;
          // (at the phone layout the box emptied by the send shows Talk, its one primary, and no Send with a spinner (ux-improvements C1): the wait is
          // the message's pending look, the line and the banner, as A4.2 reads it there)
          if (!await until(async () => { seen = await waitsSeen(page, { composer: true }); return seen.msgs.some((x) => x.sending) && (seen.phone ? !!seen.talk : seen.send?.spin) && seen.lines.length === 1 && seen.banner; })) fail(`${at}: the page does not show the wait: ${JSON.stringify(seen)}`);
          const m = await fits(page, at);
          const spin = seen.phone ? [] : [{ what: "the spinner in Send", fg: await colourOf(page, `${tidSel("send")} svg circle`, "stroke"), bg: await colourOf(page, tidSel("send"), "backgroundColor") }];
          await stage(theme, name, page, [tidSel("thread"), tidSel("composer")], { box: m?.boxW, lines: seen.lines, banner: seen.banner, send: seen.phone ? seen.talk?.label : seen.send?.title }, spin);
          await release(url, "send");
          if (!await until(async () => !(await waitsSeen(page)).banner)) fail(`${at}: let go, the send did not end`);
        } catch (e) { fail(`${at}: ${e.message.split("\n")[0]}`); }
        finally { await mockEval("delete flags.send;", url); await ctx.close(); }
      }
    }
  });

  // ---- the tool cards
  await part("cards", async () => {
    const a5 = await seed(url, "A5");
    /** Reads the open cards under root: what passes the thread, and the cards' parts as facts. */
    const cardsOf = async (theme, name, page, root) => {
      const fit = await cardsFit(page, root), cards = await toolCards(page, root);
      if (!fit || !cards?.length) return fail(`${theme}, ${name}: no card under ${root}`);
      if (fit.bad) fail(`${theme}, ${name}: ${[...fit.wide, ...fit.out, ...fit.sideways].join("; ") || `the thread scrolls ${fit.scroll} px sideways`}`);
      if (cards.some((c) => !c.open)) fail(`${theme}, ${name}: ${cards.filter((c) => !c.open).length} of ${cards.length} cards are not open`);
      await stage(theme, name, page, [`${tidSel(root)} ${tidSel("tool-card")}`], { width: fit.width, cards: cards.map((c) => `${c.label} | ${c.hint} | ${c.parts.map((p) => [p.part, p.title ?? p.text ?? p.path, p.box?.join("x")].filter(Boolean).join(" ")).join(", ")}`) });
    };
    /** The thread of Claude's items is in the theme: a change's lines by their ground and their signs, a command's words, a failed output's box. The
     *  theme's colours are the page's own tokens (app/src/ui/tokens.ts). */
    const inTheme = async (theme, name, page) => {
      const P = FLAVOURS[theme], say = (line) => fail(`${theme}, ${name}: ${line}`), t = tokensFor(P?.under ?? theme, P ? theme : null);
      const tone = (sel, prop) => colourOf(page, sel, prop).then(hex);
      const thread = tidSel("thread"), line = (kind) => `${thread} ${tidSel("diff-row", { kind })}`;
      // At the phone the card is T2's step (screens/tools/StepCard.tsx), not the wide card: its change is `step-diff` rows over the step's own ground (the panel), its counts
      // `step-counts`, a failed step's title in danger, its output boxes `step-output` and its command a box of plain text. The checks below name what each layout draws.
      // (the window of the desktop run is 300 px wide: the page there is the phone layout, so the layout is the page's own, not the viewport's)
      const phone = layoutNow(page) === "phone", card = phone ? tidSel("step") : tidSel("tool-card");
      const ground = { add: await tone(line("add"), "backgroundColor"), del: await tone(line("del"), "backgroundColor"), same: await tone(phone ? line("same") : `${thread} ${tidSel("tool-diff")}`, "backgroundColor") };
      if (new Set(Object.values(ground)).size !== 3) say(`an added line (${ground.add}), a removed one (${ground.del}) and one that stays (${ground.same}) are not told apart by their ground`);
      if (ground.same !== (phone ? t.panel : t.bg)) say(`a change is on ${ground.same}, not on the ${phone ? "step's ground, the panel" : "background"} ${phone ? t.panel : t.bg}`);
      for (const [what, sel, token] of [["an added line's sign", `${line("add")} ${tidSel("diff-sign")}`, "ok"], ["a removed line's sign", `${line("del")} ${tidSel("diff-sign")}`, "danger"],
        ["the count of added lines", `${thread} ${tidSel(phone ? "step-counts" : "tool-counts")} > span:nth-of-type(1)`, "ok"], ["the count of removed lines", `${thread} ${tidSel(phone ? "step-counts" : "tool-counts")} > span:nth-of-type(2)`, "danger"],
        ["a failed output's flag", phone ? `${thread} ${tidSel("step", { failed: "true" })} ${tidSel("tool-label")}` : `${thread} ${tidSel("tool-part", { failed: "true" })} ${tidSel("tool-sub")} > span`, "danger"]])
        if (await tone(sel, "color") !== t[token]) say(`${what} is drawn in ${await tone(sel, "color")}, not in ${token} ${t[token]}`);
      // (in a flavour a sign has its floor on its own line's ground, with no leave for what Light has: ok and danger are the flavour's)
      if (P) for (const [what, kind] of [['the "+" of an added line', "add"], ['the "−" of a removed line', "del"]]) {
        const q = contrastOf(await colourOf(page, `${line(kind)} ${tidSel("diff-sign")}`, "color"), await colourOf(page, line(kind), "backgroundColor"));
        if (q < FLOOR) say(`${what} is ${two(q)}:1 on its line's ground, under ${FLOOR}:1`);
      }
      const edges = await page.evaluate((phone) => phone
        ? [...document.querySelectorAll('[data-testid="thread"] [data-testid="step-output"]')].map((o) => [o.closest('[data-testid="step"]')?.dataset.failed === "true", getComputedStyle(o).borderTopColor])
        : [...document.querySelectorAll('[data-testid="thread"] [data-testid="tool-part"]')].filter((p) => /^Output/.test(p.querySelector('[data-testid="tool-sub"]')?.textContent ?? "") && p.querySelector('[data-testid="tool-text"]'))
          .map((p) => [p.dataset.failed === "true", getComputedStyle(p.querySelector('[data-testid="tool-text"]')).borderTopColor]), phone);
      if (!edges.some(([failed]) => failed) || edges.filter(([failed]) => failed).some(([, c]) => edges.some(([failed, d]) => !failed && d === c))) say(`a failed output's box has the border of one that did not fail: ${JSON.stringify(edges)}`);
      // (a word of a command is a span of its text with a colour of its own; the phone's step draws a command and an output as plain text in the theme's text colour, no run
      // coloured: what it asserts instead is that every such text is drawn in the text colour, so a command is as readable in a flavour as the page)
      if (phone) {
        const inks = await page.evaluate(() => [...document.querySelectorAll('[data-testid="thread"] [data-testid="step-command"] > *:first-child, [data-testid="thread"] [data-testid="step-output"] [data-testid="tool-pre"]')].map((e) => getComputedStyle(e).color));
        if (!inks.length) say("the phone's steps show no command and no output");
        for (const c of new Set(inks)) if (hex(c.match(/[\d.]+/g).slice(0, 3).map(Number)) !== t.text) say(`a command or an output is drawn in ${hex(c.match(/[\d.]+/g).slice(0, 3).map(Number))}, not in the text colour ${t.text}`);
      } else {
      const words = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid="thread"] [data-testid="tool-pre"]')].flatMap((pre) => [...pre.querySelectorAll("span")].map((e) => getComputedStyle(e).color).filter((c) => c !== getComputedStyle(pre).color)))].map((c) => c.match(/[\d.]+/g).slice(0, 3).map(Number)));
      const code = new Set([...SYNTAX, "faint", "muted", "danger"].map((n) => t[n]));
      if (!words.length) say("no word of a command is coloured as code");
      for (const w of words) if (!code.has(hex(w))) say(`a word of a command is drawn in ${hex(w)}, which is none of the theme's code colours`);
      }
      if (P && (t.bg !== P.base || await tone(`${thread} ${card}`, "backgroundColor") !== P.mantle)) say(`a card is on ${await tone(`${thread} ${card}`, "backgroundColor")} and its parts on ${t.bg}, not on Mantle ${P.mantle} and Base ${P.base}`);
    };
    for (const [id, root = "thread"] of CARDS) {
      const s = a5.find((x) => x.id === id) ?? (() => { throw new Error(`the seed has no state A5.${id}`); })(), name = `the tool cards, ${id}`;
      const win = layout !== "desktop" ? {} : id === "sub" ? CARD_WINDOWS.sub : id === "panel" ? CARD_WINDOWS.panel : CARD_WINDOWS.page;
      for (const theme of THEMES) {
        const { ctx, page } = await open({ sel: s.sel, wait: tidSel("chat-head"), ...win, ls: { ...win.ls, "aiwb.theme": theme }, still: true });
        try {
          await act(page, s.act);
          if (layoutNow(page) === "phone" && id === "sub") await openSubSteps(page); // (an ended subagent's steps are one row at the phone until a tap)
          await byTid(page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 });
          await openCards(page, root);
          await cardsOf(theme, name, page, root);
          if (id === "claude") await inTheme(theme, name, page);
        } catch (e) { fail(`${theme}, ${name}: ${e.message.split("\n")[0]}`); }
        finally { await ctx.close(); }
      }
    }
  });

  // ---- the rail: the sidebar is hidden, and its picker with it, so the page is opened in each theme. The phone has no sidebar to hide (a stack, AD-71).
  await part("rail", async () => {
    if (layout === "phone") return;
    await seed(url);
    for (const theme of THEMES) for (const [view, sel, see] of VIEWS) {
      const P = FLAVOURS[theme], name = `the rail beside ${view}`, say = (line) => fail(`${theme}, ${name}: ${line}`), t = tokensFor(P?.under ?? theme, P ? theme : null);
      const { ctx, page } = await open({ sel, ls: { "aiwb.side": "hidden", "aiwb.theme": theme }, wait: tidSel("side-show"), still: true });
      try {
        await byTid(page, see).first().waitFor({ state: "visible", timeout: 15000 });
        const r = await page.evaluate(railInPage);
        const ground = await colourOf(page, tidSel("side-rail"), "backgroundColor"), line = hex(await colourOf(page, tidSel("side-rail"), "borderRightColor"));
        if (r.pane) say("the sidebar's pane is drawn");
        if (!r.hit) say("the rail's control is not the element at its own centre");
        if (r.rail[0] !== 0 || r.rail[1] !== 0 || r.rail[3] !== r.h) say(`the rail is at ${r.rail[0]}, ${r.rail[1]} and ${r.rail[3]} px tall in a window of ${r.h}`);
        if (hex(ground) !== t.panel || line !== t.line) say(`the rail is on ${hex(ground)} with a line of ${line}, not on panel ${t.panel} with line ${t.line}`);
        if (P && hex(ground) !== P.mantle) say(`the rail is on ${hex(ground)}, not on Mantle ${P.mantle}`);
        const facts = { rail: r.rail, ctl: r.ctl };
        await stage(theme, name, page, [tidSel("side-rail")], facts);
        if (view === "Home") {
          // the keyboard's focus: the rail's control is the first stop of the page
          await page.keyboard.press("Tab");
          const f = await page.evaluate(railInPage);
          if (!f.focused || !/^solid [1-9]/.test(f.ring)) say(`after Tab the control ${f.focused ? "has" : "has not"} the keyboard's focus, and its ring is "${f.ring}"`);
          await stage(theme, `${name}, the focus on its control`, page, [tidSel("side-rail")], facts, [{ what: "the focus ring of the rail's control", fg: await colourOf(page, tidSel("side-show"), "outlineColor"), bg: ground }]);
          await page.evaluate(() => document.activeElement?.blur());
          // the dot: the page is not connected
          try {
            await mockEval("flags.streamDown = true; dropStreams();", url);
            await page.waitForSelector(tidSel("side-rail-dot"), { timeout: 30000 });
            const dot = await colourOf(page, tidSel("side-rail-dot"), "backgroundColor");
            if (hex(dot) !== t.warn) say(`the dot is ${hex(dot)}, not warn ${t.warn}`);
            await stage(theme, `${name}, not connected`, page, [tidSel("side-rail")], facts, [{ what: "the rail's dot", fg: dot, bg: ground }]);
          } finally { await mockEval("delete flags.streamDown;", url); }
        }
        await hover(page, byTid(page, "side-show"));
        await stage(theme, `${name}, the pointer on its control`, page, [tidSel("side-rail")], facts);
        if (view !== "a chat") continue;
        // a reload: the rail, on its ground, in the theme, from the first frame React draws
        const want = await page.evaluate(railProbe), sampler = await sampleFrames(page, railProbe, { fromLoad: true });
        await page.reload({ waitUntil: "domcontentloaded" });
        await byTid(page, see).first().waitFor({ state: "visible", timeout: 15000 });
        await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 });
        const frames = await sampler.stop(), bad = frames.values.filter((v) => !same(v, want));
        if (!frames.values.length) say("after a reload the sampler saw no frame with the window drawn");
        if (bad.length) say(`after a reload ${bad.length} of the ${frames.values.length} frames React drew were not ${JSON.stringify(want)}, the first ${JSON.stringify(bad[0])}`);
      } catch (e) { say(e.message.split("\n")[0]); }
      finally { await ctx.close(); }
    }
  });

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
  void SEES; void countOf; void colourOf;
}, { viewports, page: false });
