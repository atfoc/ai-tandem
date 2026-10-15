// Proves A5.2: a tool card, closed and open, by its kind, for Claude, Cursor and Pi, in a chat's thread and in a
// subagent's drawer. Closed, a card is one row: the label it had before, and
// beside it the command's first line or the file's path, where the label does not say it already. Open, a shell card
// shows "Command" (the whole command with its real line breaks, coloured, the agent's description before it) and
// "Output", marked when the command failed, and between them what else its input holds (a timeout); an edit the
// path, the lines added and removed, and a change per edit, a whole file's one-line edit as that line with a few
// around it; a write the path and the content; a delete the path and the deleted text as removed lines; any other
// tool its name, input and result. A Cursor edit and delete of a thread from before their texts were kept say that
// the change was not recorded. The colours of a change follow the theme. No page error.
// Ports dev/checks/A5.2-cards.mjs (package S6) at desktop, tablet and phone: the same seed (A5), the same threads, assertions and words; the
// cards are read over testIDs (`cards.mjs`) and a card's row is pressed with `press` (a tap on a touch viewport). The window of 700 px of the
// old check is the desktop's; the tablet and the phone are the devices' own. The subagent's drawer is S7's, the real one, read as the cards of the thread are (`sub-drawer-body`).
// Besides the old check (B-TC-15): a change selected from end to end gives its lines and no sign (the platform's selection, read with getSelection()).
import { check, paneSize, seed, until } from "../shot.mjs";
import { openCards, rowOfCard, toolCards } from "./cards.mjs";
import { act, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const DRAWER_ROOT = "sub-drawer-body";

const SUM = "internal/calc/sum.go", FULL = "/Users/demo/projects/shop/";
const FUNC = [" func Sum(xs []int) int {", " \ttotal := 0", " \tfor _, x := range xs {", "-\t\ttotal += x", "+\t\ttotal += x * 2", " \t}", " \treturn total", " }"];
const SHELL = ["text Command", "text Output"], FAILED = ["text Command", "text Output · failed"];
// Every card of a thread, in order: [the label, the line beside it, the open card's parts in short]
const THREADS = {
  claude: [
    ["Run the calc tests", "go test ./internal/calc/", SHELL],
    ["Vet, then one test", "go vet ./... && …", ["text Command", "note timeout: 120000", "text Output · failed"]],
    ["Rebuild on change", "npm run watch", ["text Command", "note run_in_background: true", "text Output"]],
    ["Edited sum.go", SUM, [`path ${SUM} +1 −1`, "change Change"]],
    ["Edited sum.go", SUM, [`path ${SUM} +1 −1`, "change Change · every occurrence"]],
    ["Edited sum.go", SUM, [`path ${SUM} +2 −2`, "change Edit 1 of 2", "change Edit 2 of 2"]],
    ["Wrote sum_test.go", "internal/calc/sum_test.go", ["path internal/calc/sum_test.go 9 lines", "text Content"]],
    ["Edited sums.ipynb", "", ["text NotebookEdit", "text Result"]],
    ["Delete the old file", "rm internal/calc/old_sum.go", ["text Command", "note No output."]],
  ],
  cursor: [
    ["Ran `go test ./internal/calc/`", "", SHELL],
    ["Ran `go test ./internal/calc/ -run TestSum`", "", FAILED],
    ["Edited sum.go", SUM, [`path ${SUM} +1 −1`, "change Change"]],
    ["Edited doc.go", "internal/calc/doc.go", ["path internal/calc/doc.go +2 −0", "change Change"]],
    ["Edited main.js", "web/dist/main.js", ["path web/dist/main.js", "note The change was too large to keep: its texts were left out."]],
    ["Deleted old_sum.go", "internal/calc/old_sum.go", ["path internal/calc/old_sum.go +0 −10", "change Deleted"]],
    ["Deleted tmp.go", "internal/calc/tmp.go", ["path internal/calc/tmp.go", "note The deleted text was not recorded."]],
    ["Edited sum.go", SUM, [`path ${SUM}`, "note The change was not recorded."]],
    ["Delete `/Users/demo/projects/shop/internal/calc/old_sum.go`", "", ["text Delete `/Users/demo/projects/shop/internal/calc/old_sum.go`", "note No result."]],
    ["Update todos", "", ["text Update todos", "note No result."]],
    ["Read sum.go", "", ["text Read", "text Result"]],
  ],
  pi: [
    ["Ran `go test ./internal/calc/`", "", ["text Command", "note timeout: 120", "text Output"]],
    ["Ran `go test ./internal/calc/ -run TestSum`", "", FAILED],
    ["Edited sum.go", SUM, [`path ${SUM} +2 −2`, "change Edit 1 of 2", "change Edit 2 of 2"]],
    ["Edited sum.go", SUM, [`path ${SUM} +1 −1`, "change Change"]],
    ["Wrote doc.go", "internal/calc/doc.go", ["path internal/calc/doc.go 2 lines", "text Content"]],
    ["Ran `rm internal/calc/old_sum.go`", "", ["text Command", "text Output"]],
  ],
};
/** A card's parts in short: "path internal/calc/sum.go +1 −1", "text Output · failed", "change Change", "note …". */
const brief = (card) => card.parts.map((p) => (p.part === "path" ? ["path", p.path, p.counts, p.lines].filter(Boolean).join(" ") : p.part === "text" || p.part === "change" ? `${p.part} ${p.title}` : `${p.part} ${p.text}`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);


await check("A5.2 a tool card by its kind, for the three agents, in the thread and the drawer", async ({ url, viewport, open, fail, note }) => {
  const states = await seed(url, "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const win = viewport === "desktop" ? paneSize("page", 700, 900) : {};
  const show = async (sel, { theme } = {}) => open({ sel, wait: '[data-testid="chat-head"]', ...win, ls: { ...win.ls, ...(theme ? { "aiwb.theme": theme } : {}) } });
  /** Holds the cards of a thread against their list, closed and then open. Answers the open cards. */
  const holds = async (page, root, name, want) => {
    if (!await until(async () => (await toolCards(page, root))?.length === want.length, 15000)) { fail(`${name}: ${(await toolCards(page, root))?.length} cards, not ${want.length}`); return null; }
    const closed = await toolCards(page, root);
    for (const [i, c] of closed.entries()) {
      const [label, hint] = want[i], at = `${name}, card ${i + 1}`;
      if (c.open) fail(`${at}: is open as the thread is drawn`);
      if (c.label !== label) fail(`${at}: its label is "${c.label}", not "${label}"`);
      if (c.hint !== hint) fail(`${at} ("${label}"): beside the label stands "${c.hint}", not "${hint}"`);
    }
    await openCards(page, root);
    const cards = await toolCards(page, root);
    for (const [i, c] of cards.entries()) {
      const at = `${name}, card ${i + 1} ("${want[i][0]}")`;
      if (!c.open) fail(`${at}: did not open`);
      if (c.label !== want[i][0] || c.hint !== want[i][1]) fail(`${at}: open, its row says "${c.label}" and "${c.hint}"`);
      if (!same(brief(c), want[i][2])) fail(`${at}: open it shows ${JSON.stringify(brief(c))}, not ${JSON.stringify(want[i][2])}`);
    }
    return cards;
  };
  const part = (card, title) => card.parts.find((p) => p.title === title || p.part === title);

  // ---- the three agents' threads
  let seen = 0;
  for (const [id, want] of Object.entries(THREADS)) {
    const s = state(id), p = await show(s.sel), name = `the thread of ${id}`;
    try {
      const cards = await holds(p.page, "thread", name, want);
      if (!cards) { await p.ctx.close(); continue; }
      seen += cards.length;
      const expect = (what, got, wanted) => { if (!same(got, wanted)) fail(`${name}: ${what} is ${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`); };
      if (id === "claude") {
        const [c1, c2, , c4, c5, c6, c7, c8] = cards;
        // a shell card: the whole command with its line breaks, coloured, the description before it; the output apart
        const cmd = part(c2, "Command"), out = part(c2, "Output · failed"), ok = part(c1, "Output");
        expect("the command of the second card", cmd.text, ["go vet ./... &&\n  go test ./internal/calc/ -run TestSum"]);
        expect("its description", cmd.lead, "Vet, then one test");
        if (!cmd.coloured) fail(`${name}: the command of the second card is not coloured as code`);
        if (ok.coloured || out.coloured) fail(`${name}: an output is coloured as code`);
        expect("the output of the second card", out.text, ["--- FAIL: TestSum (0.00s)\n    calc_test.go:12: Sum([1 2 3]) = 12, want 6\nFAIL\nFAIL\tai-whiteboard/internal/calc\t0.288s\nExit code 1"]);
        if (!out.failed || ok.failed) fail(`${name}: the failed command's output is ${out.failed ? "" : "not "}marked, the other's is ${ok.failed ? "" : "not "}`);
        // (the box of an output: the second of a shell card's text boxes; cards by their place on screen)
        const edge = (n) => p.page.evaluate((n) => {
          const cards = [...document.querySelectorAll('[data-testid="thread"] [data-testid="tool-card"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          return getComputedStyle(cards[n].querySelectorAll('[data-testid="tool-text"]')[1]).borderTopColor;
        }, n);
        if (await edge(0) === await edge(1)) fail(`${name}: the failed output's box has the border of one that did not fail (${await edge(1)})`);
        // an edit: the path in full in its title, the change with the lines around it
        expect("the path's title of the fourth card", c4.parts[0].title, FULL + SUM);
        expect("the change of the fourth card", part(c4, "Change").rows, FUNC);
        expect("the change of the fifth card", c5.parts[1].rows, ["-total", "+sum"]);
        expect("the edits of the sixth card", [c6.parts[1].rows, c6.parts[2].rows], [["-Sum adds", "+Sum doubles and adds"], ["-x * 2", "+2 * x"]]);
        // B-TC-15: the sign of a line, and what is not the change's own, is not selected or copied: a copied change is its lines
        const picked = await p.page.evaluate(() => {
          const cards = [...document.querySelectorAll('[data-testid="thread"] [data-testid="tool-card"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          const box = cards[3].querySelector('[data-testid="diff-row"]').parentElement;
          const sel = getSelection(); sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(box); sel.addRange(r);
          return { text: sel.toString(), rows: [...box.querySelectorAll('[data-testid="diff-row"]')].map((e) => [e.dataset.kind, e.querySelector('[data-testid="diff-sign"]')?.textContent, e.querySelector('[data-testid="diff-text"]')?.textContent]) };
        });
        const own = picked.rows.map((r) => r[2]).join("\n");
        if (picked.text !== own) fail(`${name}: a change selected from end to end gives ${JSON.stringify(picked.text)}, not its lines ${JSON.stringify(own)}: the signs (or something else of the card) are selected`);
        if (!picked.rows.some((r) => r[1] === "+") || !picked.rows.some((r) => r[1] === "-")) fail(`${name}: the change selected has no sign on its added and removed lines, so the selection proves nothing: ${JSON.stringify(picked.rows)}`);
        // a write: the content as it is
        expect("the content of the seventh card", part(c7, "Content").text, ["package calc\n\nimport \"testing\"\n\nfunc TestSum(t *testing.T) {\n\tif got := Sum([]int{1, 2, 3}); got != 12 {\n\t\tt.Fatalf(\"Sum = %d\", got)\n\t}\n}"]);
        // any other tool: its input as JSON
        if (!part(c8, "NotebookEdit").text[0]?.includes('"new_source": "sum(x * 2 for x in xs)"')) fail(`${name}: the eighth card's input is ${JSON.stringify(part(c8, "NotebookEdit").text)}`);
      }
      if (id === "cursor") {
        const [, , k7, k8, , k10, , , , , k6] = cards;
        // the file before and after, 124 lines each: the one line that changed, three around it, the rest as numbers
        expect("the change of a whole file's one-line edit", part(k7, "Change").rows, ["@⋯ 60 unchanged lines", ...FUNC, "@⋯ 57 unchanged lines"]);
        expect("the change of a new file", part(k8, "Change").rows, ["+// Package calc adds numbers.", "+package calc"]);
        const gone = part(k10, "Deleted").rows;
        if (gone.length !== 10 || gone.some((r) => r[0] !== "-") || gone[0] !== "-package calc") fail(`${name}: the deleted file's lines are ${JSON.stringify(gone)}`);
        if (!part(k6, "Result").text[0]?.startsWith("package calc\n\n// Sum adds the numbers.\nfunc Sum")) fail(`${name}: the result of Read is ${JSON.stringify(part(k6, "Result").text)}`);
      }
      if (id === "pi") {
        const [, p2, p3, , p5] = cards;
        expect("the output of the failed command", part(p2, "Output · failed").text, ["--- FAIL: TestSum (0.00s)\nFAIL\n\nCommand exited with code 1"]);
        expect("the edits of the third card", [p3.parts[1].rows, p3.parts[2].rows], [FUNC, ["-Sum adds", "+Sum doubles and adds"]]);
        expect("the content of the fifth card", part(p5, "Content").text, ["// Package calc adds numbers.\npackage calc"]);
      }
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }
  note(`${seen} cards of the three agents: each closed with its label and its line, and open with the parts of its kind`);

  // ---- a card closes again, and the colours of a change follow the theme
  const tones = {};
  for (const theme of ["light", "dark"]) {
    const p = await show(state("claude").sel, { theme }), name = `the thread of claude, ${theme}`;
    try {
      await toolCards(p.page); // (the thread is drawn)
      if (!await until(async () => (await toolCards(p.page))?.length === 9, 15000)) fail(`${name}: ${(await toolCards(p.page))?.length} cards, not 9`);
      await press(p.page, await rowOfCard(p.page, 3));
      await p.page.waitForSelector('[data-testid="tool-diff"]', { timeout: 5000 });
      tones[theme] = await p.page.evaluate(() => {
        const one = (kind) => document.querySelector(`[data-testid="diff-row"][data-kind="${kind}"]`);
        const bg = (kind) => getComputedStyle(one(kind)).backgroundColor;
        return { add: bg("add"), del: bg("del"), same: bg("same"), sign: getComputedStyle(one("add").querySelector('[data-testid="diff-sign"]')).color, text: getComputedStyle(one("add").querySelector('[data-testid="diff-text"]')).color };
      });
      const t = tones[theme];
      if (t.add === t.del || t.add === t.same || t.del === t.same) fail(`${name}: an added line (${t.add}), a removed one (${t.del}) and one that stays (${t.same}) are not told apart by their ground`);
      await press(p.page, await rowOfCard(p.page, 3));
      if (!await until(async () => !await p.page.locator('[data-testid="tool-detail"]').count(), 5000)) fail(`${name}: a press on an open card's row did not close it`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }
  if (tones.light && tones.dark && (tones.light.add === tones.dark.add || tones.light.del === tones.dark.del || tones.light.text === tones.dark.text)) fail(`a change has the same colours in the light theme and the dark one: ${JSON.stringify(tones)}`);
  note(`a change's grounds: added ${tones.light?.add} and removed ${tones.light?.del} in light, ${tones.dark?.add} and ${tones.dark?.del} in dark`);

  // ---- a subagent's drawer (S7)
  {
    const s = state("sub"), p = await show(s.sel), name = "the subagent's drawer";
    try {
      await act(p.page, s.act);
      const cards = await holds(p.page, DRAWER_ROOT, name, [
        ["Recent changes", "git log -3 -- internal/calc/sum.go", SHELL],
        ["Edited sum.go", SUM, [`path ${SUM} +1 −1`, "change Change"]],
      ]);
      if (cards && !same(cards[1].parts[1].rows, ["-// Sum adds the numbers.", "+// Sum doubles the numbers and adds them."])) fail(`${name}: the change is ${JSON.stringify(cards[1].parts[1].rows)}`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
    note("the same cards in a subagent's drawer");
  }
}, { viewports, page: false });
