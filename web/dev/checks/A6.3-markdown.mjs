// Proves, on the new build, the chat part of A6.3 (it ports dev/checks/A6.3-readable.mjs, the part "a chat with code"; B-MD-05, B-MD-12): the
// chat `c_A6_cards` of the mock, whose answer has four code blocks, a table, a quote and a link, is readable in each Catppuccin flavour:
// every text and icon of the chat view (its header and its thread) has 3:1 against what is behind it, the weakest floor the goal has. One that
// has less passes only if it has no less than the same element has in the theme the flavour is laid over (Light under Latte, Dark under the
// others: a code block's header and its Copy button are that faint today), or if the goal accepts it: in Latte, the Claude agent's glyph. What
// passed that way is printed. The count of code blocks is the old check's: four.
// Package S5 ran it on the gallery's section "Markdown" (`/?gallery`), the chat view did not exist; S4 moves it onto the chat, opened as the old
// check opened it, a page for each theme with the choice saved (`aiwb.theme`) and the clock pinned.
// S6 adds the old stage's other half: every tool card of the chat is opened first (as the old stage clicked each row), so its parts and the
// permission cards (one waits, two are decided) are read with the rest (B-TC-33, B-PM-11). S8 adds the old check's tree popup (a stage of its own:
// `c_A6_tree`, the Tree button pressed, the popup read).
// And the old check's last stage, the picker's menu (S1: the foot's `theme-btn` pressed on the list, the menu `theme-menu` read; a popover, a sheet on the
// phone). The other parts of the old check have a port of their own: the board is A6.3-board.mjs, the Servers dialog L7, the library popups L20, and the
// composer's states and the tool cards of every kind P7.1.
import { atRest, check, contrastAudit, mockEval, seed } from "../shot.mjs";
import { openCards } from "./cards.mjs";
import { byTid, openFoot, press } from "./sel.mjs";
import { openTree } from "./fork.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// Base and Text of @catppuccin/palette 1.8.0, and the theme each flavour is laid over
const FLAVOURS = { latte: "light", frappe: "dark", macchiato: "dark", mocha: "dark" };
const FLOOR = 3;
const CLAUDE = "#d97757"; // the Claude agent's colour in the light theme, which a flavour keeps
const PART = '[data-testid="chat"]';

async function body({ url, viewport, open, fail, note }) {
  const phone = viewport === "phone"; // (the phone has no sidebar: Home is its list, and the theme is chosen on the Appearance screen of Settings)
  await seed(url, "A1", "A6");
  // (the pages' clock stands a second after the mock's start: a label that tells a time is the same in every theme)
  const clock = await mockEval("return T0;", url) + 1000;
  /** One stage in one theme: { element → its least ratio }. */
  const read = async (theme, stage) => {
    const { ctx, page } = await open({ sel: stage.chat ? { chat: stage.chat } : {}, ls: { "aiwb.theme": theme }, clock, still: true, wait: stage.chat ? '[data-testid="chat-head"]' : phone ? '[data-testid="home"]' : '[data-testid="side-tree"]' });
    try {
      await stage.show(page, theme);
      if (!await atRest(page, 8)) fail(`${theme}, ${stage.name}: the page did not come to rest`);
      const rows = await contrastAudit(page, { only: [stage.part] });
      const least = new Map();
      for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
      return least;
    } finally { await ctx.close(); }
  };
  // The stages: the chat with code (S5, S4), the tree popup of a chat with two branches, labels and a fork (S8: the old check's "tree" part) and the picker's menu (S1).
  const STAGES = [
    { name: "a chat with code", chat: "c_A6_cards", part: PART, min: 10, async show(page, theme) {
      await byTid(page, "md-code").first().waitFor({ state: "visible", timeout: 15000 });
      const blocks = await byTid(page.locator(PART), "md-code").count();
      if (blocks !== 4) fail(`${theme}, a chat with code: ${blocks} elements match the code blocks, not 4`);
      // the open tool cards and the permission cards: the old stage's `see` and wait
      await openCards(page);
      if (!await byTid(page.locator(PART), "tool-detail").count()) fail(`${theme}, a chat with code: no tool card is open`);
      if (await byTid(page.locator(PART), "perm", { state: "pending" }).count() !== 1 || await byTid(page.locator(PART), "perm").count() !== 3) fail(`${theme}, a chat with code: the chat does not show its three permission cards, one of them waiting`);
    } },
    { name: "the tree popup", chat: "c_A6_tree", part: '[data-testid="tree-popup"]', min: 10, async show(page) { await openTree(page); } },
    { name: "the picker's menu", part: phone ? '[data-testid="appearance-screen"]' : '[data-testid="theme-menu"]', min: 10, async show(page) {
      // (phone: the choice is the screen Home's gear > Appearance pushes, which openFoot brings to rest; the wide layouts press the foot's button for the menu)
      if (phone) { await openFoot(page, "theme-btn"); return; }
      await press(page, byTid(page, "theme-btn").first());
      await byTid(page, "theme-menu").first().waitFor({ state: "visible", timeout: 15000 });
    } },
  ];
  const found = async (theme) => Object.fromEntries(await Promise.all(STAGES.map(async (st) => [st.name, await read(theme, st)])));
  const under = { light: await found("light"), dark: await found("dark") };
  for (const [flavour, over] of Object.entries(FLAVOURS)) {
    const now = await found(flavour);
    let audited = 0, least = null;
    const asToday = new Map(), accepted = new Map();
    for (const st of STAGES) {
      const rows = now[st.name], base = under[over][st.name];
      if (rows.size < st.min) fail(`${flavour}, ${st.name}: only ${rows.size} texts were read: the part is not on screen`);
      audited += rows.size;
      for (const [key, r] of rows) {
        if (!least || r.ratio < least.ratio) least = r;
        if (r.ratio >= FLOOR) continue;
        const was = base.get(key);
        if (flavour === "latte" && r.kind === "icon" && r.fg === CLAUDE) accepted.set(`${r.fg} on ${r.bg}`, r.ratio);
        else if (was && r.ratio >= was.ratio - 0.005) asToday.set(`${r.kind} ${r.where.split(" > ").pop()}`, `${r.ratio} (${over} ${was.ratio})`);
        else fail(`${flavour}, ${st.name}: ${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${over}` : ` (${over} has no such element)`}`);
      }
    }
    const list = (m) => [...m].map(([k, v]) => `${k} ${v}`).join(", ") || "nothing";
    note(`${flavour}: ${audited} texts in ${STAGES.length} stages; the weakest ${least?.ratio}:1; under ${FLOOR}:1 and no weaker than in ${over}: ${list(asToday)}; accepted by the goal (the Claude glyph): ${list(accepted)}`);
  }
}

await check("A6.3 the chat with code is readable in each flavour", body, { viewports, page: false });
