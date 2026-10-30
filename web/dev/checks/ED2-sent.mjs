// ED2 (new; the composer's code-editor editing, what the thread shows of it): a user's own message with indented lines (Tab and Enter keep
// an indent in the composer, ED1) shows them as typed (app/src/screens/markdown/indent.ts), at desktop, tablet and phone:
//   each line's indent is kept and drawn (a tab `tabWidth` wide: `aiwb.composer.settings` at 4 in localStorage), so the indented line's text
//   starts to the right of the line above it; a run of indented lines is text, no code block; the lists are still lists;
//   the bubble is as wide as its text needs, never a column narrower than its longest word: no word of it breaks over two lines
//   (a list item's text, whose box was `flex: 1`, counted as no width in the bubble that fits its content: iOS drew one letter a line).
// The messages are sent from elsewhere (another window, the mock's `elsewhere`) into a chat that is open.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid } from "./sel.mjs";
import { WAIT } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const SETTINGS = "aiwb.composer.settings";
const MESSAGES = [
  "a:\n\tone\n\ttwo\n- three\n- four",
  "if x:\n    y = 1\n    z = 2",
  "- three\n- four",
  "    indented = 1\n    run = 2",
];

/** In the page: for the user's message `item`, each word's rectangles (a word broken over lines has more than one), the left of each
 *  line's first word, the bubble's width, and its indents (their text and white-space, tab-size). */
const measure = (item) => {
  const msg = document.querySelector(`[data-testid="msg"][data-role="user"][data-item="${item}"]`);
  if (!msg) return null;
  const md = msg.querySelector('[data-testid="md"]');
  const words = [], lines = [];
  const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('[data-testid="md-marker"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const m of n.data.matchAll(/\S+/g)) {
      const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
      const rects = [...r.getClientRects()].filter((x) => x.width > 0);
      words.push({ word: m[0], rects: rects.length, width: r.getBoundingClientRect().width, left: rects[0]?.left ?? 0, top: rects[0]?.top ?? 0 });
    }
  }
  // the first word of each line (by its top)
  for (const w of words) if (!lines.some((l) => Math.abs(l.top - w.top) < 3)) lines.push(w);
  const indents = [...md.querySelectorAll('[data-testid="md-indent"]')].map((e) => ({ text: e.textContent, ws: getComputedStyle(e).whiteSpace, tab: getComputedStyle(e).tabSize }));
  return {
    words, lines: lines.map((l) => ({ word: l.word, left: l.left })), indents, width: msg.getBoundingClientRect().width,
    code: md.querySelectorAll('[data-testid="md-code"]').length, lists: md.querySelectorAll('[data-testid="md-li"]').length,
  };
};

await check("ED2 a user's message shows its indented lines as typed, in a bubble as wide as its text", async ({ url, viewport, open, fail }) => {
  const say = (line) => fail(`${viewport}: ${line}`);
  await seed(url, "A1", "A4", "SEC");
  await mockEval(`chats.c_indent = chat("c_indent", { name: "c_indent", group: "g_shop" }); items.c_indent = []; send({ type: "snapshot", ...snapshot() });`, url);
  const { page, ctx } = await open({ sel: { chat: "c_indent" }, wait: '[data-testid="chat-head"]', ls: { [SETTINGS]: J({ tabInserts: "tab", tabWidth: 4 }) } });
  for (const text of MESSAGES) {
    const before = await mockEval("return items.c_indent.length;", url);
    await mockEval(`await elsewhere("local", "POST", "/chats/c_indent/messages", ${J({ text })}); return true;`, url);
    // (each message gets the canned reply: wait for its end before the next is sent)
    await until(() => mockEval(`return items.c_indent.length > ${before + 1} && items.c_indent.at(-1)?.kind === "end";`, url), WAIT);
  }
  const users = await mockEval(`return items.c_indent.map((x, i) => x.kind === "user" ? i : -1).filter((i) => i >= 0);`, url);
  if (users.length !== MESSAGES.length) { say(`the chat has ${users.length} messages of the user, not ${MESSAGES.length}`); await ctx.close(); return; }
  await byTid(page, "msg", { role: "user", item: users.at(-1) }).first().waitFor({ state: "attached", timeout: WAIT });
  await page.evaluate(() => document.fonts.ready);

  const at = async (i) => {
    const loc = byTid(page, "msg", { role: "user", item: users[i] }).first();
    await loc.scrollIntoViewIfNeeded();
    return page.evaluate(measure, users[i]);
  };
  const space = await page.evaluate(() => { // the width of a space in the thread's text, for the indents' sizes
    const p = document.querySelector('[data-testid="md-p"]'); const s = document.createElement("span");
    s.style.whiteSpace = "pre"; s.textContent = "    "; p.appendChild(s); const w = s.getBoundingClientRect().width / 4; s.remove(); return w;
  });

  /** No word broken over lines, and the bubble wider than its widest word. */
  const fits = (m, name) => {
    const broken = m.words.filter((w) => w.rects > 1).map((w) => w.word);
    if (broken.length) say(`${name}: the words ${J(broken)} are broken over lines (the bubble is ${Math.round(m.width)} px wide)`);
    const widest = Math.max(...m.words.map((w) => w.width));
    if (!(m.width > widest + 20)) say(`${name}: the bubble is ${Math.round(m.width)} px wide, not wider than its widest word (${Math.round(widest)} px) and a list's marker`);
  };
  const shift = (m, a, b) => (m.lines.find((l) => l.word === b)?.left ?? 0) - (m.lines.find((l) => l.word === a)?.left ?? 0);

  {
    const m = await at(0), name = "\"a:\\n\\tone\\n\\ttwo\\n- three\\n- four\"";
    if (!m) say(`${name} is not drawn`);
    else {
      fits(m, name);
      if (J(m.indents.map((x) => x.text)) !== J(["\t", "\t"])) say(`${name}: its indents are ${J(m.indents.map((x) => x.text))}, not two tabs`);
      if (m.indents.some((x) => x.ws !== "pre" || x.tab !== "4")) say(`${name}: an indent is drawn with white-space ${J(m.indents.map((x) => x.ws))} and tab-size ${J(m.indents.map((x) => x.tab))}, not pre and 4`);
      const d = shift(m, "a:", "one");
      if (Math.abs(d - 4 * space) > 2) say(`${name}: "one" starts ${d.toFixed(1)} px right of "a:", not a tab of 4 spaces (${(4 * space).toFixed(1)} px)`);
      if (Math.abs(shift(m, "one", "two")) > 1) say(`${name}: "two" does not start under "one"`);
      if (m.lists !== 2) say(`${name}: ${m.lists} list items drawn, not 2`);
      for (const w of ["three", "four"]) if (!m.lines.some((l) => l.word === w)) say(`${name}: "${w}" is not on a line of its own`);
    }
  }
  {
    const m = await at(1), name = "\"if x:\\n    y = 1\\n    z = 2\"";
    if (!m) say(`${name} is not drawn`);
    else {
      fits(m, name);
      if (J(m.indents.map((x) => x.text)) !== J(["    ", "    "])) say(`${name}: its indents are ${J(m.indents.map((x) => x.text))}, not four spaces twice`);
      const d = shift(m, "if", "y");
      if (Math.abs(d - 4 * space) > 2) say(`${name}: "y = 1" starts ${d.toFixed(1)} px right of "if x:", not 4 spaces (${(4 * space).toFixed(1)} px)`);
    }
  }
  {
    const m = await at(2), name = "\"- three\\n- four\" (a list alone)";
    if (!m) say(`${name} is not drawn`);
    else { fits(m, name); if (m.lists !== 2) say(`${name}: ${m.lists} list items drawn, not 2`); }
  }
  {
    const m = await at(3), name = "\"    indented = 1\\n    run = 2\"";
    if (!m) say(`${name} is not drawn`);
    else {
      fits(m, name);
      if (m.code) say(`${name}: a run of indented lines is drawn as a code block`);
      if (J(m.indents.map((x) => x.text)) !== J(["    ", "    "])) say(`${name}: its indents are ${J(m.indents.map((x) => x.text))}, not four spaces twice`);
    }
  }
  await ctx.close();
}, { viewports, page: false });
