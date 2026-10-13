// Proves that every state of the seed (dev/mock-ui.js) is on screen where its entry says (its selector, its text,
// its count, and each part of its `also`), with no page error, one thrown a moment after the state showed among
// them: each section seeded alone on a mock of its own, then all of them together.
import { act, check, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const SECTIONS = ["A1", "A2", "A3", "A4", "A5", "A6", "SEC"];
const UNDO = "delete flags.streamDown; delete flags.hello;"; // what a state's `mock` may have set
const MOMENT = 1000; // ms a page stays open after its state showed, so that an error thrown after the load is seen
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

await check("P0.3 every seeded state renders", async ({ url, browser, mock, fail, note }) => {
  const version = await fetch(url + "/version.json").then((r) => r.json()).then((v) => v.version, () => "");
  if (!version || version === "dev") fail(`the build's version is "${version}": the update notice needs one of its own (buildDist of dev/shot.mjs gives it)`);
  // The pages whose state showed, the oldest first. Each stays open for its moment while the next ones are opened,
  // so the moment costs no time; done(true) waits for all of them, before the mock changes under them.
  const shown = [];
  const done = async (all) => {
    while (shown.length && (all || Date.now() - shown[0].at >= MOMENT)) {
      const p = shown.shift();
      await sleep(Math.max(0, MOMENT - (Date.now() - p.at)));
      for (const e of p.errors) fail(`${p.name}: page error: ${e}`);
      await p.ctx.close();
    }
  };
  // One part of a state: its selector is on screen, its first match says the text, and it matches that many elements.
  const onScreen = async (page, name, { see, text, count }) => {
    const all = page.locator(see), el = all.first();
    await el.waitFor({ state: "visible", timeout: 8000 }).catch(() => { throw new Error(`nothing on screen matches ${see}`); });
    if (text) { const said = await el.textContent(); if (!said.includes(text)) fail(`${name}: ${see} says "${said.slice(0, 80)}", not "${text}"`); }
    if (count !== undefined && !await until(async () => await all.count() === count, 5000)) fail(`${name}: ${await all.count()} elements match ${see}, not ${count}`);
  };
  const show = async (s, tag) => {
    const errors = [], name = `${tag}: ${s.section}.${s.id}`;
    if (s.mock) await done(true); // (its knob would reach the pages still open)
    // (a pane no narrower than 480 px: the state is looked for, not measured)
    const { ctx, page } = await openPage({ url, browser, sel: s.sel, errors, ...(s.pane ? paneSize(s.pane[0], Math.max(s.pane[1], 480)) : {}) });
    try {
      if (s.mock) await mockEval(s.mock, url);
      await act(page, s.act);
      for (const part of [s, ...(s.also ?? [])]) await onScreen(page, name, part);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    shown.push({ ctx, errors, name, at: Date.now() });
    await done(!!s.mock);
    if (s.mock) await mockEval(UNDO, url);
  };
  let n = 0;
  for (const section of mock ? SECTIONS : []) { // a mock that runs already cannot be started anew: all together only
    await mock.restart();
    const states = await seed(url, section);
    if (!states.length || states.some((s) => s.section !== section)) fail(`seedUI("${section}") answered ${states.length} states, ${states.filter((s) => s.section !== section).length} of another section`);
    for (const s of states) await show(s, "alone");
    await done(true);
    n += states.length;
  }
  await mock?.restart();
  const all = await seed(url);
  for (const section of SECTIONS) if (!all.some((s) => s.section === section)) fail(`seedUI() made no state of section ${section}`);
  for (const s of all) await show(s, "together");
  await done(true);
  note(`${n} states alone, ${all.length} together`);
});
