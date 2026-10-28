// ME.1 (new; plans/model-effort-menu/design.md 2.2 to 2.5): the wide toolbar's model and effort menu from the keyboard, at the desktop, on the mock's
// section A2. The model and its effort are one chip ("Opus 5.5 · High", its title "Model and effort (⌘E): …", or "(Ctrl+E)" off the Mac: the key is
// the one of the platform the page reports, navigator.platform, as the app's keyPlatform reads it). What it proves:
//   1 open     ⌘E with the focus in the composer's box opens the menu (model-menu) with its search field focused, the chat's choice as the draft
//              (opus, high), the effort line and the key hints; the chip says it is open (aria-expanded).
//   2 search   typing filters the rows ("son": Sonnet 5.5 alone) and moves the draft to the first listed model when its own is not listed (the effort
//              kept where the new model offers it); clearing the search lists every model again and keeps the draft. A search that lists nothing
//              (Done disabled, the field the overlay's first control): Tab and Shift+Tab leave the focus in the search.
//   3 ↑ ↓      move the drafted model through the listed rows in their order, around the ends; a model with no efforts (Haiku 4.5) says "This model has
//              no effort setting." and Tab and Shift+Tab change nothing there, the focus staying in the search (the field is the overlay's last
//              control there: its Tab is the field's, not the overlay's trap's).
//   4 Tab      Tab and Shift+Tab step the drafted effort through the model's efforts, around the ends, the focus staying in the search.
//   5 Esc      closes the menu and applies nothing: no PATCH of the chat, the chip as it was; the next ⌘E opens on the chat's choice again (the draft
//              made anew), and ⌘E while the menu is open closes it, applying nothing.
//   6 Enter    applies the draft in ONE PATCH carrying both fields ({ model: "sonnet", effort: "medium" }), closes the menu; the mock's chat has them,
//              the chip says "Sonnet 5.5 · Medium" with data-effort "medium".
//   7 more     where the fit has put the model chip into the "more" popup (a board's panel of 300 px), ⌘E opens the menu hanging from the "more" chip
//              and leaves that popup closed; Esc closes it.
//   8 fixed    on a started chat (the model a fixed chip) ⌘E opens nothing and leaves the key alone (not defaultPrevented).
// Run: `cd web && npm run uicheck -- ME.1`, or alone: node web/dev/checks/ME.1-modelmenu.mjs (DIST=… as README.md says).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MENU, chip, menuOf, openAt, openState, placesOf } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop"];

const J = JSON.stringify;

await check("ME.1 the model and effort menu from the keyboard: ⌘E, search, ↑ ↓, Tab, Esc, Enter", async ({ url, layout, open, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const modelChip = (page) => chip(page, "model", { fixed: false }).first();
  /** The key that opens the menu on the page's platform, and its name in titles. */
  const keyOf = async (page) => {
    const mac = /Mac|iPhone|iPad/.test(await page.evaluate(() => navigator.platform));
    return { press: mac ? "Meta+KeyE" : "Control+KeyE", name: mac ? "⌘E" : "Ctrl+E" };
  };
  const isOpen = (page) => page.locator(MENU).count().then((n) => n > 0);
  const opened = async (page, what) => {
    if (!await until(async () => (await menuOf(page))?.focused, 5000)) { fail(`${what}: the menu ${await isOpen(page) ? "has no focus in its search field" : "did not open"}`); return null; }
    return menuOf(page);
  };
  const closed = async (page, what) => { if (!await until(async () => !await isOpen(page), 5000)) fail(`${what}: the menu stays open`); };
  /** Presses a key and waits until the menu's draft is what `ok` wants; answers the menu as it is then. */
  const key = async (page, k, ok, what) => {
    await page.keyboard.press(k);
    const m = await until(async () => { const m = await menuOf(page); return m && ok(m) ? m : null; }, 5000);
    if (!m) fail(`${what}: after ${k} the menu is ${J(await menuOf(page))}`);
    else if (!m.focused) fail(`${what}: ${k} took the focus out of the search field`);
    return m ?? await menuOf(page);
  };

  // ---- a new chat in a wide page: every row of the menu's keys
  {
    const { page, ctx } = await openState(open, state("plain-new"), layout, 0, { size: [1400, 800] });
    const calls = callsOf(page);
    const patches = (from = 0) => calls.slice(from).filter((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path));
    const k = await keyOf(page);
    await modelChip(page).waitFor({ state: "visible", timeout: 15000 });
    const title = (await modelChip(page).getAttribute("title")) ?? "";
    if (!title.startsWith(`Model and effort (${k.name}): Opus 5.5 · High`)) fail(`the model chip's title is ${J(title)}, not "Model and effort (${k.name}): Opus 5.5 · High — …"`);
    if (await chip(page, "effort").count()) fail("the toolbar has an effort chip");
    await press(page, byTid(page, "composer-input").first());

    // 1 open
    await page.keyboard.press(k.press);
    let m = await opened(page, `${k.name} in the box`);
    if (m) {
      if (m.query !== "" || m.model !== "opus" || m.effort !== "high") fail(`${k.name} opened the menu on ${J({ query: m.query, model: m.model, effort: m.effort })}, not the chat's choice (opus, high) with no search`);
      if (J(m.rows) !== J(["opus", "sonnet", "haiku", "long"])) fail(`the menu lists ${J(m.rows)}`);
      if (!/More effort/.test(m.line)) fail(`the effort line says ${J(m.line)}`);
      if (!/Tab Effort/.test(m.keys) || !/Esc Cancel/.test(m.keys)) fail(`the key hints say ${J(m.keys)}`);
      if (await modelChip(page).getAttribute("aria-expanded") !== "true") fail("the model chip does not say that its menu is open");

      // 2 search
      await page.keyboard.type("son");
      m = await key(page, "n", (x) => x.query === "sonn", "the search"); // (one more letter: the field takes typing)
      if (J(m.rows) !== J(["sonnet"]) || m.model !== "sonnet" || m.effort !== "high") fail(`the search "sonn" leaves ${J({ rows: m.rows, model: m.model, effort: m.effort })}, not Sonnet 5.5 alone, drafted, the effort high kept`);
      for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
      m = await until(async () => { const x = await menuOf(page); return x?.query === "" && x.rows.length === 4 ? x : null; }, 5000);
      if (!m || m.model !== "sonnet") fail(`the search cleared: the menu is ${J(await menuOf(page))}, not every model with Sonnet 5.5 still drafted`);
      // a search that lists nothing: Done is off, and Tab / Shift+Tab stay in the field
      await page.keyboard.type("q");
      m = await key(page, "q", (x) => x.query === "qq" && x.rows.length === 0, "a search that lists nothing");
      m = await key(page, "Tab", (x) => x.query === "qq", "Tab with no model listed");
      m = await key(page, "Shift+Tab", (x) => x.query === "qq", "Shift+Tab with no model listed");
      for (let i = 0; i < 2; i++) await page.keyboard.press("Backspace");
      m = await until(async () => { const x = await menuOf(page); return x?.query === "" && x.rows.length === 4 ? x : null; }, 5000);
      if (!m || m.model !== "sonnet") fail(`the empty search cleared: the menu is ${J(await menuOf(page))}, not every model with Sonnet 5.5 still drafted`);

      // 3 ↑ ↓
      m = await key(page, "ArrowDown", (x) => x.model === "haiku", "↓ from Sonnet 5.5");
      if (m.efforts.length || m.line !== "This model has no effort setting.") fail(`Haiku 4.5 drafted: the effort section is ${J({ efforts: m.efforts, line: m.line })}`);
      m = await key(page, "Tab", (x) => x.model === "haiku", "Tab on a model with no efforts");
      if (m.effort) fail(`Tab on Haiku 4.5 drafted the effort ${m.effort}`);
      m = await key(page, "Shift+Tab", (x) => x.model === "haiku", "Shift+Tab on a model with no efforts");
      if (m.effort) fail(`Shift+Tab on Haiku 4.5 drafted the effort ${m.effort}`);
      m = await key(page, "ArrowUp", (x) => x.model === "sonnet", "↑ from Haiku 4.5");
      if (m.effort !== "medium") fail(`back on Sonnet 5.5 from a model with no efforts the drafted effort is ${J(m.effort)}, not its default, medium`);
      await key(page, "ArrowUp", (x) => x.model === "opus", "↑ from Sonnet 5.5");
      await key(page, "ArrowUp", (x) => x.model === "long", "↑ from the first row (around the end)");
      m = await key(page, "ArrowDown", (x) => x.model === "opus", "↓ from the last row (around the end)");

      // 4 Tab, Shift+Tab, around the ends
      const efforts = m.efforts;
      if (J(efforts) !== J(["low", "medium", "high", "max"])) fail(`Opus 5.5's efforts are ${J(efforts)}`);
      let at = efforts.indexOf(m.effort);
      for (let i = 0; i < efforts.length && at >= 0; i++) { const want = efforts[(at + 1) % efforts.length]; m = await key(page, "Tab", (x) => x.effort === want, `Tab from ${efforts[at]}`); at = efforts.indexOf(m.effort); }
      for (let i = 0; i < 2 && at >= 0; i++) { const want = efforts[(at - 1 + efforts.length) % efforts.length]; m = await key(page, "Shift+Tab", (x) => x.effort === want, `Shift+Tab from ${efforts[at]}`); at = efforts.indexOf(m.effort); }

      // 5 Esc: nothing applied
      await page.keyboard.press("Escape");
      await closed(page, "Esc");
      await page.waitForTimeout(300);
      if (patches().length) fail(`the menu wrote while it was open, or on Esc: ${J(patches().map((c) => c.body))}`);
      if ((await modelChip(page).textContent())?.replace(/▾/g, "").trim() !== "Opus 5.5 · High") fail(`after Esc the chip says ${J(await modelChip(page).textContent())}`);
      await page.keyboard.press(k.press);
      m = await opened(page, `${k.name} after Esc`);
      if (m && (m.model !== "opus" || m.effort !== "high" || m.query !== "")) fail(`${k.name} after Esc opened on ${J({ query: m.query, model: m.model, effort: m.effort })}: the draft is not made anew from the chat's choice`);
      await page.keyboard.press(k.press);
      await closed(page, `${k.name} with the menu open`);
      await page.waitForTimeout(300);
      if (patches().length) fail(`${k.name} that closed the menu applied ${J(patches().map((c) => c.body))}`);

      // 6 Enter: one write with both fields
      await page.keyboard.press(k.press);
      if (await opened(page, `${k.name} again`)) {
        await key(page, "ArrowDown", (x) => x.model === "sonnet" && x.effort === "high", "↓ to Sonnet 5.5 (high kept)");
        await key(page, "Shift+Tab", (x) => x.effort === "medium", "Shift+Tab to medium");
        const from = calls.length;
        await page.keyboard.press("Enter");
        await closed(page, "Enter");
        if (!await until(() => patches(from).length, 10000)) fail("Enter made no PATCH");
        await page.waitForTimeout(500);
        const made = patches(from).map((c) => c.body);
        if (made.length !== 1 || made[0]?.model !== "sonnet" || made[0]?.effort !== "medium") fail(`Enter wrote ${J(made)}, not one PATCH { model: "sonnet", effort: "medium" }`);
        const kept = await mockEval(`return [chats.c_A2_new.model, chats.c_A2_new.effort];`, url);
        if (J(kept) !== J(["sonnet", "medium"])) fail(`the mock's chat has ${J(kept)} after Enter`);
        const says = await until(async () => { const t = (await modelChip(page).textContent())?.replace(/▾/g, "").trim(); return t === "Sonnet 5.5 · Medium" ? t : null; }, 5000);
        if (!says) fail(`after Enter the chip says ${J(await modelChip(page).textContent())}, not "Sonnet 5.5 · Medium"`);
        if (await modelChip(page).getAttribute("data-effort") !== "medium") fail(`after Enter the chip's data-effort is ${J(await modelChip(page).getAttribute("data-effort"))}`);
      }
    }
    await ctx.close();
    note(`${k.name} opens the menu with its search focused on the chat's choice; the search filters and moves the draft; ↑ ↓ move the model and Tab / Shift+Tab the effort around the ends; Esc and ${k.name} again apply nothing; Enter makes one PATCH with both fields and the chip says them`);
  }

  // ---- 7 the model chip in the "more" popup: the menu hangs from the "more" chip, the popup stays closed
  {
    await seed(url, "A2");
    const p = await openAt(open, state("board-new"), layout, 300), page = p.page;
    const k = await keyOf(page);
    const at = await placesOf(page);
    if (at?.chips.some((c) => c.kind === "model" && c.where === "row") || !await byTid(page, "more-chip").count()) fail(`board-new in a panel of 300 px has its model chip in the row: ${J(at?.chips)}`);
    else {
      await press(page, byTid(page, "composer-input").first());
      await page.keyboard.press(k.press);
      if (await opened(page, `${k.name} with the model chip in "more"`)) {
        if (await byTid(page, "more-pop").count()) fail(`${k.name} opened the "more" popup`);
        const [menu, more] = [await page.locator(MENU).first().boundingBox(), await byTid(page, "more-chip").first().boundingBox()];
        if (!menu || !more || menu.y + menu.height > more.y + 1) fail(`the menu does not hang above the "more" chip: the menu ${J(menu)}, the chip ${J(more)}`);
        await page.keyboard.press("Escape");
        await closed(page, `Esc in the menu hung from "more"`);
        if (await byTid(page, "more-pop").count()) fail(`Esc in the menu hung from "more" left the "more" popup open`);
      }
    }
    await p.ctx.close();
    note(`${k.name} with the model chip in "more": the menu hangs from the "more" chip, the popup stays closed`);
  }

  // ---- 8 a started chat: the model is fixed, ⌘E opens nothing and is not taken
  {
    await seed(url, "A2");
    const { page, ctx } = await openState(open, state("plain-started"), layout, 0, { size: [1400, 800] });
    const k = await keyOf(page);
    await page.locator(tidSel("tchip", { kind: "model", fixed: true })).first().waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate(() => { window.__meKeys = []; window.addEventListener("keydown", (e) => { if (e.code === "KeyE") window.__meKeys.push(e.defaultPrevented); }, true); }); // (after the app's own window listeners, as the keys port's: a box's own handler may stop it before the bubble)
    await press(page, byTid(page, "composer-input").first());
    await page.keyboard.press(k.press);
    await page.waitForTimeout(500);
    if (await isOpen(page)) fail(`${k.name} on a started chat opened the menu`);
    const seen = await page.evaluate(() => window.__meKeys);
    if (J(seen) !== J([false])) fail(`${k.name} on a started chat: the page saw ${J(seen)} (defaultPrevented per key), not the key once and left alone`);
    await ctx.close();
    note(`${k.name} on a started chat (a fixed chip): no menu, the key left alone`);
  }
}, { viewports, page: false });
