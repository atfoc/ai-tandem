// Proves A5.3: a card of a call that is still running, was denied, or ended with no result shows what it has and says
// what is missing, and no item breaks the page. The incomplete items of G4 §5: closed by a copy of the thread (an
// empty result, an error), denied, nothing but its id, never written (it draws nothing), running with its input,
// running with an input that is still arriving. That last card, open, follows the item as it arrives: the content
// grows, then the input and the result come, and it stays open. A subagent's call that was cut with its subagent says
// that it was stopped. Items with fields of other types than the page reads are cards all the same: each opens, none
// is the line of a part that could not be drawn. No page error.
import { act, check, mockEval, openCards, openPage, paneSize, seed, toolCards, until } from "../shot.mjs";

const brief = (card) => card.parts.map((p) => (p.part === "path" ? ["path", p.path, p.counts, p.lines].filter(Boolean).join(" ") : p.part === "text" || p.part === "change" ? `${p.part} ${p.title}` : `${p.part} ${p.text}`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DOC = "/Users/demo/projects/shop/internal/calc/doc.go";
// The incomplete items' cards: [the label, the line beside it, the classes it has of "running" and "err", its parts]
const GAPS = [
  ["Build", "go build ./...", ["err"], ["text Command", "note Ended with no output."]],
  ["Editing sum.go — denied", "internal/calc/sum.go", ["err"], ["path internal/calc/sum.go +1 −1", "change Change", "note Denied: the file was not changed."]],
  ["…", "", ["running"], ["text tool", "note The input was not recorded.", "note Still running: no result yet."]],
  ["Run the tests…", "go test ./...", ["running"], ["text Command", "note Still running: no output yet."]],
  ["Writing a file…", "internal/calc/doc.go", ["running"], ["path internal/calc/doc.go 1 line", "text Content", "note The input is still arriving.", "note Still running: no result yet."]],
];

await check("A5.3 an incomplete tool item says what is missing, and no item breaks the page", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const open = async (id) => {
    const errors = [], s = state(id), size = paneSize("page", 700, 900);
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...size });
    await act(page, s.act);
    await page.waitForSelector(s.see, { timeout: 8000 });
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const guards = (page) => page.locator(".guard-fail").allTextContents();

  // ---- the incomplete items
  {
    const p = await open("gaps"), name = "the incomplete items";
    try {
      const closed = await toolCards(p.page);
      if (closed.length !== GAPS.length) fail(`${name}: ${closed.length} cards, not ${GAPS.length}: the item that was never written draws nothing`);
      await openCards(p.page);
      const cards = await toolCards(p.page);
      for (const [i, [label, hint, cls, parts]] of GAPS.entries()) {
        const c = cards[i], at = `${name}, card ${i + 1} ("${label}")`;
        if (!c) continue;
        if (c.label !== label || c.hint !== hint) fail(`${at}: its row says "${c.label}" and "${c.hint}", not "${label}" and "${hint}"`);
        if (!same(c.cls.filter((x) => x === "running" || x === "err"), cls)) fail(`${at}: its classes are ${c.cls.join(" ")}, not ${cls.join(" ")}`);
        if (!c.open || !same(brief(c), parts)) fail(`${at}: open it shows ${JSON.stringify(brief(c))}, not ${JSON.stringify(parts)}`);
      }
      const content = () => toolCards(p.page).then((all) => all[4]?.parts.find((x) => x.title === "Content")?.text);
      if (!same(await content(), ["// Package calc adds num"])) fail(`${name}: of the input that is arriving the card shows ${JSON.stringify(await content())}`);

      // the input goes on arriving, then it is whole and the call is done: the open card follows
      const put = (item) => mockEval(`const list = items.c_A5_gaps, i = list.findIndex((x) => x && x.toolId === "i5"); list[i] = ${JSON.stringify(item)};
        send({ type: "chat_items", chat: "c_A5_gaps", branch: "main", version: (versions.c_A5_gaps = (versions.c_A5_gaps ?? 1) + 1), updates: [{ index: i, item: list[i] }] });`, url);
      const TEXT = "// Package calc adds numbers.\npackage calc\n";
      await put({ kind: "tool", toolId: "i5", name: "Write", partial: `{"file_path": "${DOC}", "content": "// Package calc adds numbers.\\npackage ca` });
      if (!await until(async () => same(await content(), ["// Package calc adds numbers.\npackage ca"]), 8000)) fail(`${name}: after more of the input arrived the open card shows ${JSON.stringify(await content())}`);
      await put({ kind: "tool", toolId: "i5", name: "Write", partial: JSON.stringify({ file_path: DOC, content: TEXT }), input: { file_path: DOC, content: TEXT }, result: `File created successfully at: ${DOC}` });
      const done = ["path internal/calc/doc.go 2 lines", "text Content"];
      if (!await until(async () => { const c = (await toolCards(p.page))[4]; return c?.open && same(brief(c), done) && c.label === "Wrote doc.go" && !c.cls.includes("running"); }, 8000)) {
        const c = (await toolCards(p.page))[4];
        fail(`${name}: with its input and its result the card is "${c?.label}" (${c?.cls.join(" ")}), ${c?.open ? "open" : "closed"}, and shows ${JSON.stringify(c && brief(c))}, not ${JSON.stringify(done)}`);
      }
      for (const g of await guards(p.page)) fail(`${name}: a part could not be drawn: ${g}`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  note(`${GAPS.length} incomplete items: each says what is missing, and the one whose input arrives follows it`);

  // ---- a call cut with its subagent: the subagent ended, and one of its calls has no result
  {
    await mockEval(`subItems["c_A5_sub/s1"].splice(2, 0, tool("s1x", "Bash", { command: "go test ./internal/calc/", description: "Run the tests" })); versions["c_A5_sub/s1"] = (versions["c_A5_sub/s1"] ?? 1) + 1;`, url);
    const p = await open("sub"), name = "the subagent's drawer";
    try {
      if (!await until(async () => (await toolCards(p.page, ".sub-drawer-body"))?.length === 3)) fail(`${name}: ${(await toolCards(p.page, ".sub-drawer-body"))?.length} cards, not 3`);
      await openCards(p.page, ".sub-drawer-body");
      const c = (await toolCards(p.page, ".sub-drawer-body"))[1];
      if (c?.label !== "Run the tests — stopped" || c.cls.includes("running") || !same(brief(c), ["text Command", "note Stopped before the command gave its output."])) fail(`${name}: the call that was cut is "${c?.label}" (${c?.cls.join(" ")}) and shows ${JSON.stringify(c && brief(c))}`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }

  // ---- items with fields of other types than the page reads
  {
    const p = await open("junk"), name = "the malformed items", want = state("junk").count;
    try {
      const closed = await toolCards(p.page);
      if (closed.length !== want) fail(`${name}: ${closed.length} cards, not ${want}`);
      await openCards(p.page);
      const cards = await toolCards(p.page);
      for (const [i, c] of cards.entries()) if (!c.open || !c.parts.length) fail(`${name}, card ${i + 1} ("${c.label}"): ${c.open ? "is open and empty" : "did not open"}`);
      for (const g of await guards(p.page)) fail(`${name}: a part could not be drawn: ${g}`);
      // (the rest of the thread is there: the reply after the cards)
      if (!await p.page.locator(".thread .msg.assistant").count()) fail(`${name}: the thread's reply is not drawn`);
      note(`${cards.length} malformed items: ${cards.filter((c) => c.cls.includes("k-other")).length} drawn as any other tool, ${cards.filter((c) => !c.cls.includes("k-other")).length} as their kind; each opens`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
});
