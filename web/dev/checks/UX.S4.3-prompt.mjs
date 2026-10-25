// UX.S4.3 (package S4, ux-improvements goal 3.6 "Prompt", mockup "04 Insert a prompt"): the composer's insert popup on the phone is a search sheet.
//   tablet, desktop  the popup is the dialog it was: its key legend (`insert-foot`) and "Edit the library", no `insert-library`, no section heads.
//   phone, light     the sheet: a head with Cancel, "Insert a prompt" and Library (each 44 pt at least); under it a search 44 pt high at 17 px, full width; no Recent at
//                    first; the prompts by folder under 13 px section heads ("git › pull requests", "git", "review"; the top of the library last, under "Top level"), in the tree's order,
//                    rows without the path prefix, two lines (the name 17 px, the first line of the text 13 px), 50 pt at least; no text under 13 px, no target under 44 pt.
//                    The keys of the web build: the arrows tint a row (only after one was pressed), Enter inserts the tinted row or, with none, the first.
//                    Enter inserts the first row ("PR title"), a tap on "Plain words" its text at the caret, and the sheet is gone; opened again: Recent first with them (recent="true"), gone while a search is typed,
//                    back when it is emptied; a search shows the ranked hits under their path heads, and says so when it finds none. Cancel leaves the box as it was;
//                    Library does too and pushes the `library` screen. An empty library says so, with a 44 pt button to the library. A second server's prompts are under
//                    heads with its name, its offline ones marked and insertable. A reload keeps this computer's recent prompts and drops the remote server's.
//   phone, dark      the sizes and the screens again.
// OUT=/tmp/x (default web/out/s4-shots) keeps screenshots of the sheet with Recent, searching and empty, light and dark.
import fs from "node:fs";
import { check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const KEY = "ControlOrMeta+p";
const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT ?? new URL("../../out/s4-shots/", import.meta.url).pathname;
const bare = (v) => v.replace(/\n+$/, "");
const T = {
  PR_TITLE: "Suggest three titles for this pull request.\nKeep each under 60 characters.",
  PR_DESC: "Write a pull request description for this branch.",
  COMMIT: "Write a commit message for the staged changes.",
  MERGE: "Resolve the merge conflicts in the working tree.",
  TESTS: "Find the tests this change is missing.",
  TOP: "Reply in plain words.",
};
const LIBRARY = {
  groups: [{ id: "g_git", name: "git", parent: "" }, { id: "g_pr", name: "pull requests", parent: "g_git" }, { id: "g_rev", name: "review", parent: "" }],
  prompts: [
    { id: "p_top", name: "Plain words", parent: "", text: T.TOP },
    { id: "p_title", name: "PR title", parent: "g_pr", text: T.PR_TITLE },
    { id: "p_desc", name: "Pull request description", parent: "g_pr", text: T.PR_DESC },
    { id: "p_commit", name: "Commit message", parent: "g_git", text: T.COMMIT },
    { id: "p_merge", name: "Resolve merge conflicts", parent: "g_git", text: T.MERGE },
    { id: "p_tests", name: "Find missing tests", parent: "g_rev", text: T.TESTS },
  ],
};
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [{ id: "g_team", name: "team", parent: "" }], prompts: [{ id: "p_stand", name: "standup", parent: "g_team", text: "What did you do yesterday?" }] };
// the sheet from top to bottom: the folders in the tree's order, then the top of the library under "Top level"
const SHEET = [["head", "git › pull requests"], ["row", "PR title"], ["row", "Pull request description"], ["head", "git"], ["row", "Commit message"], ["row", "Resolve merge conflicts"], ["head", "review"], ["row", "Find missing tests"], ["head", "Top level"], ["row", "Plain words"]];

/** In the page: what the Prompt sheet or the dialog shows, measured. */
function seenNow() {
  const Q = (id) => `[data-testid="${id}"]`;
  const pop = document.querySelector(Q("insert-popup"));
  if (!pop) return null;
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right }; };
  const text = (e) => e?.textContent?.trim() ?? "", size = (e) => (e ? parseFloat(getComputedStyle(e).fontSize) : 0);
  const at = document.activeElement;
  const items = [...pop.querySelectorAll(`${Q("insert-section")}, ${Q("insert-row")}`)].map((e) => e.dataset.testid === "insert-section"
    ? { head: text(e), font: size(e), box: box(e) }
    : { row: text(e.querySelector(Q("lib-pname"))), line: text(e.querySelector(Q("insert-text"))), recent: e.dataset.recent === "true", key: e.dataset.key, server: e.dataset.server, on: e.getAttribute("aria-selected") === "true",
        path: !!e.querySelector(Q("lib-path")), off: text(e.querySelector(Q("lib-off"))), nameFont: size(e.querySelector(Q("lib-pname"))), lineFont: size(e.querySelector(Q("insert-text"))),
        tint: getComputedStyle(e).backgroundColor, box: box(e) });
  const leaves = [...pop.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim());
  const targets = [...pop.querySelectorAll('[role="button"], [role="option"], input, button')].map((e) => ({ id: e.dataset.testid ?? e.tagName.toLowerCase(), box: box(e) }));
  const search = pop.querySelector(Q("insert-search"));
  return {
    sheet: box(pop), items, targets, minFont: Math.min(...leaves.map(size)),
    title: text(pop.querySelector(Q("sheet-title"))), cancel: text(pop.querySelector(Q("insert-cancel"))), library: text(pop.querySelector(Q("insert-library"))), cancelBox: box(pop.querySelector(Q("insert-cancel"))), libraryBox: box(pop.querySelector(Q("insert-library"))),
    foot: !!pop.querySelector(Q("insert-foot")), edit: !!pop.querySelector(Q("insert-edit-library")), search: search ? { ...box(search), font: size(search), label: search.getAttribute("aria-label"), placeholder: search.getAttribute("placeholder"), value: search.value } : null,
    empty: text(pop.querySelector(Q("insert-empty"))), none: text(pop.querySelector(Q("insert-none"))), open: box(pop.querySelector(Q("insert-open-library"))),
    focus: !at || at === document.body ? "nothing" : at.matches(Q("insert-search")) ? "search" : at.matches(Q("composer-input")) ? "box" : at.tagName.toLowerCase() + "[" + (at.dataset.testid ?? "") + "]",
  };
}

await check("UX.S4.3 the Prompt sheet: the insert popup as a search sheet on the phone; the wide dialog unchanged", async ({ url, layout, open, fail, note }) => {
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const servers = (list) => mockEval(`setServers(${J(list)});`, url);
  const setLocal = (lib) => mockEval(`setLibrary("local", ${J(lib)});`, url);
  await servers([]);
  await setLocal(LIBRARY);

  /** A page with the chat's box (the light theme or the dark). */
  const openBox = async (dark) => {
    const p = await open({ sel, wait: tidSel("composer-input"), ls: dark ? { "aiwb.theme": "dark" } : {} });
    const { page } = p, box = byTid(page, "composer-input").first();
    const read = () => page.evaluate(seenNow);
    const shows = async (what, want, timeout = WAIT) => {
      let s;
      if (!await until(async () => want((s = await read())), timeout)) fail(`${what}: the page shows ${J(s)}`);
      return s;
    };
    const boxText = () => box.evaluate((e) => e.innerText);
    /** The box's text is `want`: the sheet is gone and the box has the focus. */
    const closed = async (what, want) => {
      const ok = await until(async () => (await read()) === null && bare(await boxText()) === bare(want), WAIT);
      if (!ok) fail(`${what}: the sheet is ${(await read()) ? "still open" : "gone"} and the box holds ${J(bare(await boxText()))}, not ${J(bare(want))}`);
      return ok;
    };
    const sheet = async (what) => {
      await page.keyboard.press(KEY);
      return shows(`${what}: ⌘P`, (x) => !!x && x.items.length + (x.empty ? 1 : 0) > 0 || !!x?.none);
    };
    const type = async (text) => { await press(page, box); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); if (text) await page.keyboard.type(text); };
    return { ...p, box, read, shows, boxText, sheet, type, closed };
  };
  const lines = (s) => s.items.map((i) => (i.head !== undefined ? ["head", i.head] : [i.recent ? "recent" : "row", i.row]));
  const stack = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="pushed-screen"]')].map((e) => e.dataset.screen));
  const shoot = async (c, name) => { await c.page.waitForTimeout(500); await c.page.screenshot({ path: `${OUT}/${name}.png` }); }; // (after the sheet has risen)

  // ---- the wide layouts: the dialog it was
  if (layout !== "phone") {
    const c = await openBox(false);
    try {
      await c.type("Hi ");
      const s = await c.sheet("the wide popup");
      if (!s.foot) fail("the wide popup has no key legend (insert-foot)");
      if (s.library) fail(`the wide popup has an insert-library control: ${J(s.library)}`);
      if (s.items.some((i) => i.head !== undefined)) fail("the wide popup has section heads");
      if (!s.edit) fail("the wide popup has no \"Edit the library\"");
      if (s.search.font >= 17) fail(`the wide popup's search is ${s.search.font} px`);
      if (s.items.filter((i) => i.row !== undefined && i.path).length !== 5) fail("the rows of the wide popup do not carry their paths (all but the top one's)");
      await page_esc(c);
      note("the wide layout keeps the dialog: the key legend, \"Edit the library\", the rows with their paths, no sheet");
    } catch (e) { fail(`wide: ${e.message.split("\n")[0]}`); }
    await c.ctx.close();
    return;
  }
  async function page_esc(c) { await c.page.keyboard.press("Escape"); await c.shows("Esc", (x) => x === null); }

  fs.mkdirSync(OUT, { recursive: true });

  /** The sizes and the order of the open sheet, whatever the theme. */
  const prove = (tag, s) => {
    if (s.title !== "Insert a prompt" || s.cancel !== "Cancel" || s.library !== "Library") fail(`${tag}: the head says ${J([s.cancel, s.title, s.library])}`);
    for (const [n, b] of [["Cancel", s.cancelBox], ["Library", s.libraryBox]]) if (!b || b.h < 43.5 || b.w < 43.5) fail(`${tag}: ${n} is ${b?.w} × ${b?.h}, under 44`);
    if (!s.cancelBox || !s.libraryBox || s.cancelBox.x > s.sheet.x + 40 || s.libraryBox.right < s.sheet.right - 40) fail(`${tag}: Cancel and Library are not at the two ends of the head`);
    if (s.foot || s.edit) fail(`${tag}: the key legend or "Edit the library" is drawn`);
    const q = s.search;
    if (!q) return fail(`${tag}: no search`);
    if (q.h < 43.5) fail(`${tag}: the search is ${q.h} px high, under 44`);
    if (q.font !== 17) fail(`${tag}: the search's text is ${q.font} px, not 17`);
    if (q.w < s.sheet.w - 40 || q.right > s.sheet.right) fail(`${tag}: the search is ${q.w} px wide in a sheet of ${s.sheet.w}`);
    if (q.label !== "Search prompts" || q.placeholder !== "Search prompts") fail(`${tag}: the search's label is ${J(q.label)} and its placeholder ${J(q.placeholder)}`);
    if (s.minFont < 13) fail(`${tag}: some text is ${s.minFont} px, under 13`);
    for (const t of s.targets) if (t.box.h < 43.5 || t.box.w < 43.5) fail(`${tag}: ${t.id} is ${t.box.w} × ${t.box.h}, under 44`);
  };
  const proveList = (tag, s) => {
    const want = SHEET, got = s.items.map((i) => (i.head !== undefined ? ["head", i.head] : ["row", i.row]));
    if (J(got) !== J(want)) fail(`${tag}: the sheet shows ${J(got)}, not ${J(want)}`);
    for (const i of s.items) {
      if (i.head !== undefined) { if (i.font !== 13) fail(`${tag}: the head ${J(i.head)} is ${i.font} px, not 13`); continue; }
      if (i.path) fail(`${tag}: the row ${J(i.row)} has a path prefix`);
      if (i.nameFont !== 17 || i.lineFont !== 13) fail(`${tag}: the row ${J(i.row)} has its name at ${i.nameFont} px and its line at ${i.lineFont}`);
      if (i.box.h < 50) fail(`${tag}: the row ${J(i.row)} is ${i.box.h} px high, under 50`);
      if (i.recent) fail(`${tag}: ${J(i.row)} is marked recent`);
    }
    const line = (n) => s.items.find((i) => i.row === n)?.line;
    if (line("PR title") !== "Suggest three titles for this pull request.") fail(`${tag}: the line of "PR title" is ${J(line("PR title"))}`);
    for (let k = 1; k < s.items.length; k++) if (s.items[k].box.y < s.items[k - 1].box.y) fail(`${tag}: the items are not drawn top to bottom in order`);
  };

  // ---- light
  {
    const c = await openBox(false), { page } = c;
    try {
      await c.type("Hi ");
      let s = await c.sheet("the first time");
      prove("light", s);
      proveList("light", s);
      if (s.items.some((i) => i.recent || i.head === "Recent")) fail("light: Recent is drawn before anything was inserted");
      if (s.focus !== "search") fail(`light: the focus is ${s.focus}, not the search (the web build's keys)`);
      if (s.items.some((i) => i.on || (i.row !== undefined && i.tint !== "rgba(0, 0, 0, 0)"))) fail(`light: a row is tinted before an arrow was pressed (${J(s.items.map((i) => i.tint))})`);

      // Enter with no row tinted inserts the first row
      await page.keyboard.press("Enter");
      let text = "Hi " + T.PR_TITLE;
      if (!await c.closed("Enter with no tinted row", text)) return;
      s = await c.sheet("again after Enter");
      if (J(lines(s).slice(0, 2)) !== J([["head", "Recent"], ["recent", "PR title"]])) fail(`light: after one insertion the sheet starts with ${J(lines(s).slice(0, 3))}`);

      // the arrows tint a row; Enter inserts it
      await page.keyboard.press("ArrowDown");
      s = await c.read();
      if (s.items.filter((i) => i.on).length !== 1 || !s.items.find((i) => i.row !== undefined).on) fail(`light: ArrowDown did not tint the first row (${J(s.items.map((i) => i.on))})`);
      const tint = s.items.find((i) => i.on).tint;
      if (tint === "rgba(0, 0, 0, 0)") fail("light: the tinted row has no tint");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      s = await c.read();
      const rows = s.items.filter((i) => i.row !== undefined);
      if (J(rows.map((r) => r.on)) !== J(rows.map((_, k) => k === 2))) fail(`light: after three arrows the tinted rows are ${J(rows.map((r) => r.on))}`);
      await page.keyboard.press("ArrowUp");
      s = await c.read();
      if (J(s.items.filter((i) => i.row !== undefined).map((r) => r.on)) !== J(rows.map((_, k) => k === 1))) fail("light: ArrowUp did not move the tint up");
      await page.keyboard.press("Escape");
      if (!await c.closed("Esc", text)) return;

      // a tap on "Plain words" puts its text at the caret
      s = await c.sheet("before a tap");
      await press(page, byTid(page, "insert-row", { key: "local/p_top" }).last());
      text = text + T.TOP;
      if (!await c.closed("a tap on \"Plain words\"", text)) return;
      s = await c.sheet("with Recent");
      if (J(lines(s).slice(0, 3)) !== J([["head", "Recent"], ["recent", "Plain words"], ["recent", "PR title"]])) fail(`light: Recent shows ${J(lines(s).slice(0, 4))}`);
      if (s.items.filter((i) => i.recent).some((i) => i.path || i.box.h < 50)) fail("light: a Recent row has a path or is under 50 px");
      if (s.items.length !== 13) fail(`light: with Recent the sheet has ${s.items.length} items, not 13`);
      await shoot(c, "prompt-recent-light");

      // a search: no Recent, ranked hits under their path heads
      await page.keyboard.type("pull");
      s = await c.shows("a search for pull", (x) => x && x.search.value === "pull" && !x.items.some((i) => i.recent || i.head === "Recent"));
      if (J(lines(s)) !== J([["head", "git › pull requests"], ["row", "Pull request description"], ["row", "PR title"]])) fail(`light: the search for "pull" shows ${J(lines(s))}`);
      if (s.items.some((i) => i.path)) fail("light: a hit has a path prefix");
      await shoot(c, "prompt-search-light");
      await page.keyboard.type("x");
      s = await c.shows("a search that finds nothing", (x) => x && x.none);
      if (s.none !== "No prompts match “pullx”") fail(`light: no match says ${J(s.none)}`);
      await shoot(c, "prompt-none-light");
      // emptied: Recent is back
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      s = await c.shows("the search emptied", (x) => x && x.search.value === "" && x.items[0]?.head === "Recent");
      prove("light, emptied", s);

      // Cancel: the box as it was
      await press(page, byTid(page, "insert-cancel"));
      if (!await c.closed("Cancel", text)) return;
      s = await c.sheet("before a swipe");
      // a press on the dimmed page: as Cancel
      await press(page, byTid(page, "overlay-backdrop").first(), { position: { x: 8, y: 8 } });
      if (!await c.closed("a press on the dimmed page", text)) return;

      // Library: the box as it was, the library screen pushed
      await c.sheet("before Library");
      await press(page, byTid(page, "insert-library"));
      if (!await until(async () => (await stack(page)).at(-1) === "library" && (await c.read()) === null, WAIT)) fail(`light: Library left the stack as ${J(await stack(page))}`);
      await back(page);
      if (!await c.closed("Library, back to the chat", text)) return;
      note("light: the head, the search, the order, the sizes, Recent, the search, Enter/arrows/Esc, Cancel, the dimmed page and Library are right");
    } catch (e) { fail(`light: ${e.message.split("\n")[0]}`); }
    await c.ctx.close();
  }

  // ---- an empty library, a second server (offline), the reload
  {
    const c = await openBox(false), { page } = c;
    try {
      await c.type("Hi ");
      await setLocal({ groups: [], prompts: [] });
      await c.shows("the empty library reached the page", async (x) => x === null);
      await page.keyboard.press(KEY);
      let s = await c.shows("an empty library", (x) => x && x.empty);
      if (!s.empty.startsWith("The library has no prompts yet.")) fail(`empty: the sheet says ${J(s.empty)}`);
      if (!s.open || s.open.h < 43.5) fail(`empty: "Open the library" is ${s.open?.h} px high`);
      prove("empty", s);
      await shoot(c, "prompt-empty-light");
      await press(page, byTid(page, "insert-open-library"));
      if (!await until(async () => (await stack(page)).at(-1) === "library" && (await c.read()) === null, WAIT)) fail(`empty: Open the library left the stack as ${J(await stack(page))}`);
      await back(page);
      if (!await c.closed("Open the library, back to the chat", "Hi ")) return;
    } catch (e) { fail(`empty: ${e.message.split("\n")[0]}`); }
    await c.ctx.close();
    await setLocal(LIBRARY);
  }
  {
    const c = await openBox(false), { page } = c;
    try {
      await c.type("Hi ");
      await servers([STUDIO]);
      await mockEval(`setLibrary("s_studio", ${J(THEIRS)});`, url);
      await page.keyboard.press(KEY);
      let s = await c.shows("a second server", (x) => x && x.items.some((i) => i.head === "Studio › team"));
      const heads = s.items.filter((i) => i.head !== undefined).map((i) => i.head);
      if (J(heads) !== J(["This computer › git › pull requests", "This computer › git", "This computer › review", "This computer", "Studio › team"])) fail(`servers: the heads are ${J(heads)}`);
      await page.keyboard.press("Escape");
      await c.closed("Esc", "Hi ");
      // it drops: its prompts stay, marked, and can be inserted
      await mockEval(`setServerState("s_studio", "unreachable");`, url);
      await page.keyboard.press(KEY);
      s = await c.shows("a server that dropped", (x) => x && x.items.some((i) => i.off));
      const off = s.items.filter((i) => i.off);
      if (J(off.map((i) => i.row)) !== J(["standup"]) || !/not connected/.test(off[0].off)) fail(`servers: the offline rows are ${J(off.map((i) => [i.row, i.off]))}`);
      prove("servers", s);
      if (off[0].box.h < 50) fail("servers: the offline row is under 50 px");
      await press(page, byTid(page, "insert-row", { key: "s_studio/p_stand" }).last());
      if (!await c.closed("a prompt of a server that dropped", "Hi " + THEIRS.prompts[0].text)) return;
      s = await c.sheet("with a remote prompt in Recent");
      if (J(lines(s).slice(0, 2)) !== J([["head", "Recent"], ["recent", "standup"]])) fail(`servers: Recent shows ${J(lines(s).slice(0, 3))}`);
      await page.keyboard.press("Escape");
      await c.closed("Esc", "Hi " + THEIRS.prompts[0].text);
      // a local one, then a reload: this computer's recent is kept, the remote one is gone
      await c.sheet("a local prompt");
      await press(page, byTid(page, "insert-row", { key: "local/p_merge" }).last());
      await c.closed("a local prompt", "Hi " + THEIRS.prompts[0].text + T.MERGE);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(tidSel("composer-input"), { timeout: WAIT });
      await press(page, c.box);
      await page.keyboard.press(KEY);
      s = await c.shows("after a reload", (x) => x && x.items.some((i) => i.head === "Recent") && x.items.length > 8);
      const recent = s.items.filter((i) => i.recent).map((i) => i.row);
      if (J(recent) !== J(["Resolve merge conflicts"])) fail(`reload: Recent shows ${J(recent)}, not this computer's "Resolve merge conflicts" alone`);
      const stored = await page.evaluate(() => localStorage.getItem("aiwb.prompts.recent"));
      if (!stored || J(JSON.parse(stored)) !== J(["p_merge"])) fail(`reload: the storage holds ${J(stored)} under aiwb.prompts.recent`);
      note("a second server's prompts are under its name, its offline ones marked and insertable; a reload keeps this computer's recent prompts and drops the remote one's");
    } catch (e) { fail(`servers: ${e.message.split("\n")[0]}`); }
    await c.ctx.close();
    await servers([]);
  }

  // ---- dark: the sizes and the screens again (this computer's recent is kept from the pages above)
  {
    const c = await openBox(true), { page } = c;
    try {
      const dark = await page.evaluate(() => document.documentElement.dataset.theme);
      if (dark !== "dark") fail(`dark: the page's theme is ${J(dark)}`);
      await c.type("Hi ");
      let s = await c.sheet("dark");
      await press(page, byTid(page, "insert-row", { key: "local/p_title" }).last());
      await c.closed("dark, a tap on \"PR title\"", "Hi " + T.PR_TITLE);
      s = await c.sheet("dark, again");
      prove("dark", s);
      if (s.items[0]?.head !== "Recent") fail(`dark: the sheet starts with ${J(lines(s).slice(0, 2))}, not Recent`);
      await shoot(c, "prompt-recent-dark");
      await page.keyboard.type("commit");
      s = await c.shows("dark search", (x) => x && x.search.value === "commit" && !x.items.some((i) => i.recent));
      if (J(lines(s)) !== J([["head", "git"], ["row", "Commit message"]])) fail(`dark: the search for "commit" shows ${J(lines(s))}`);
      await shoot(c, "prompt-search-dark");
      await page.keyboard.type("zzz");
      await c.shows("dark none", (x) => x && x.none);
      await shoot(c, "prompt-none-dark");
      await page.keyboard.press("Escape");
      await c.closed("Esc", "Hi " + T.PR_TITLE);
      await setLocal({ groups: [], prompts: [] });
      await c.shows("the empty library reached the page", async (x) => x === null);
      await page.keyboard.press(KEY);
      await c.shows("dark, empty", (x) => x && x.empty);
      s = await c.read();
      prove("dark empty", s);
      await shoot(c, "prompt-empty-dark");
    } catch (e) { fail(`dark: ${e.message.split("\n")[0]}`); }
    await c.ctx.close();
    await setLocal(LIBRARY);
  }
}, { viewports, page: false });
