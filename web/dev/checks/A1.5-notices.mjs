// Proves A1.5. The rail's control has its dot while this computer's section has something to say (its server is not
// connected, is of another build than the app, did not start) and at no other time: not for another server that is not
// connected.
// Hiding by the head's control, and by ⌘B with the focus in the sidebar, puts the focus on the rail's control;
// showing from the rail puts it on the head's; a focus outside the sidebar stays where it is through ⌘B. With the sidebar shown its
// head holds its controls inside the pane, down to the pane's least width.
// Ports dev/checks/A1.5-notices.mjs (U3, S1) to the new build, at desktop and tablet (A-LY-10 is this computer's, desktop only in the
// app's own sense, and runs on the tablet's window too where the mock gives it; A-LY-11, A-LY-14 are wide only). Hiding either way ends a
// rename box (a group's, a board's, a chat's) with its text not saved, though a box that loses the focus saves: the check ends with one that
// does, heard by the same listener. And it closes the head's "+" menu, a chat row's and a board row's menu, a group's "+" menu and a group's menu.
// Deviations: the dot is waited for on the rail's control itself (`side-rail-dot`, `data-notice` and the label) while the mock's server changes
// state, with the words of this computer's section that say why (`side-section-state`, `side-section-extra`); the focus moves between the
// rail's control and the head's, with a button of Home standing for the outside and a row of the sidebar for the switch of its foot; the version
// of the build is read from the script the page loads. A menu is drawn in a layer over the page, which a press outside closes, so the head's
// control cannot hide the sidebar with a menu open (that press is the layer's: it closes the menu, and the next one hides): a menu is closed
// by the key, and by that press.
// Besides the old check (A-SB-08): the Servers button draws its dot while a server of the list is not connected.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { sideMenu } from "./side.mjs";

export const viewports = ["desktop", "tablet"];

const UNDO = "delete flags.streamDown; delete flags.hello; setServerState('local', 'connected');";
const tid = (id) => `[data-testid="${id}"]`;

await check("A1.5 the rail's dot, the focus, and what hiding the sidebar closes", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "A1");
  const index = await fetch(url + "/").then((r) => r.text(), () => "");
  const script = /<script src="([^"]*_expo[^"]+)"/.exec(index)?.[1];
  const bundle = script ? await fetch(new URL(script, url + "/").href).then((r) => r.text(), () => "") : "";
  if (!/["']uicheck["']/.test(bundle)) fail('the build\'s version is not "uicheck": a server of another build needs a version of the page to differ from (buildAppDist of dev/shot.mjs gives it)');
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** Every timer the page had set for the next moments has fired: a timer set now, with a later end, fires after them. */
  const timers = (page) => page.evaluate(() => new Promise((ok) => setTimeout(ok, 60)));
  const isHidden = (page) => page.evaluate(() => document.querySelector('[data-testid="app"]').dataset.side === "hidden");
  const focus = (page) => page.evaluate(() => {
    const a = document.activeElement, id = a?.closest?.("[data-testid]")?.dataset.testid;
    return !a || a === document.body ? "nothing" : id === "side-show" ? "rail" : id === "side-hide" ? "head" : id === "home-new-chat" ? "outside" : id === "composer-input" ? "composer" : id === "side-row" ? "row" : a.tagName.toLowerCase() + "[" + id + "]";
  });
  const focusIs = async (page, name, want) => { if (!await until(async () => await focus(page) === want, 10000)) fail(`${name}: the focus is on ${await focus(page)}, not on ${want === "rail" ? "the rail's control" : want === "head" ? "the head's control" : "the " + want}`); };
  const HOW = { key: "⌘B", control: "the head's control" };
  const hide = async (page, name, how) => {
    if (how === "key") await page.keyboard.press("ControlOrMeta+b"); else await press(page, byTid(page, "side-hide").first());
    if (!await until(() => isHidden(page), 10000)) fail(`${name}: ${HOW[how]} did not hide the sidebar`);
  };
  const show = async (page, name) => {
    await press(page, byTid(page, "side-show").first());
    if (!await until(async () => !await isHidden(page), 10000)) fail(`${name}: the rail's control did not show the sidebar`);
  };
  const run = async (o, body) => { const { ctx, page } = await open({ wait: tid("app"), ...o }); try { await body(page); } finally { await ctx.close(); } };

  // ---- the dot
  await run({ sel: { chat: "c_plain" }, ls: { "aiwb.side": "hidden" } }, async (page) => {
    const dot = () => page.evaluate(() => {
      const d = document.querySelector('[data-testid="side-rail"] [data-testid="side-show"] [data-testid="side-rail-dot"]') ?? document.querySelector('[data-testid="side-rail"] [data-testid="side-rail-dot"]');
      const c = document.querySelector('[data-testid="side-rail"] [data-testid="side-show"]');
      const r = d?.getBoundingClientRect(), b = c?.getBoundingClientRect();
      return { dot: !!d && r.width >= 5 && r.left >= b.left - 3 && r.right <= b.right + 3 && r.top >= b.top - 3 && r.bottom <= b.bottom + 3 && getComputedStyle(d).backgroundColor !== "rgba(0, 0, 0, 0)",
        notice: c?.dataset.notice, label: c?.getAttribute("aria-label") ?? "" };
    });
    /** The words this computer's section says: its state, and the line under it that says why. */
    const says = () => page.evaluate(() => {
      const sec = [...document.querySelectorAll('[data-testid="side-section"]')].find((x) => x.dataset.server === "local");
      const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
      return { state: text(sec?.querySelector('[data-testid="side-section-state"]')), extra: text(sec?.querySelector('[data-testid="side-section-extra"]')) };
    });
    /** Waits for the dot to be as it should, then holds the control's name and mark against it: they were read together. */
    const at = async (name, { state, extra }, want) => {
      const ok = await until(async () => { const s = await dot(), w = await says(); return s.dot === want && w.state === state && w.extra.includes(extra) && !!w.extra === !!extra ? s : null; }, 30000);
      const s = ok || await dot();
      if (!ok) fail(`the dot, ${name}: the control has ${s.dot ? "a" : "no"} dot while this computer's section says ${JSON.stringify(await says())}`);
      else if (s.label.includes("notice") !== want || (s.notice === "true") !== want) fail(`the dot, ${name}: the control is named "${s.label}" and marked notice=${s.notice}`);
    };
    if (!await isHidden(page)) return fail("the dot: the page did not open with the sidebar hidden");
    if (!await page.locator('[data-testid="servers-btn"][title*="not connected"]').count()) fail("the dot: the seed's server that is not connected is not told by the Servers button");
    if (!await page.locator('[data-testid="servers-btn"] [data-testid="servers-dot"]').count()) fail("the dot: the Servers button, with a server of the list not connected, draws no dot"); // (A-SB-08)
    await at("connected, a server of the list not connected", { state: "Connected", extra: "" }, false);
    try {
      await mockEval("flags.streamDown = true; dropStreams();", url);
      await at("the stream closed for good: every server is connecting", { state: "Connecting…", extra: "" }, true);
      await mockEval("delete flags.streamDown;", url);
      await at("connected again", { state: "Connected", extra: "" }, false);
      await mockEval('flags.hello = { version: "old" }; dropStreams();', url);
      await at("the server is of another build", { state: "Connected", extra: "another build" }, true);
      await mockEval("delete flags.hello; dropStreams();", url);
      await at("the builds the same again", { state: "Connected", extra: "" }, false);
      await mockEval('setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine." });', url);
      await at("the start failed", { state: "Not started", extra: "not set up" }, true);
      await mockEval("setServerState('local', 'connected');", url);
      await at("started", { state: "Connected", extra: "" }, false);
      await mockEval('setServerState("local", "too_old", { version: "0.9.1" });', url);
      await at("the server is too old", { state: "Too old", extra: "Restart server" }, true);
      await mockEval("setServerState('local', 'connected');", url);
      await at("restarted", { state: "Connected", extra: "" }, false);
      // another server of the list that is not connected is the Servers button's dot, not this one (the seed has one)
      if (!await page.locator('[data-testid="servers-btn"][title*="not connected"]').count()) fail("the dot: the Servers button lost its own dot");
    } finally { await mockEval(UNDO, url); }
    note("the dot: on while this computer's server was connecting, of another build, not started and too old; off when connected with a server of the list down, and after each");
  });

  // ---- the head of a sidebar that shows: the controls stay inside the pane and can be hit
  for (const w of [200, 264]) await run({ sel: { chat: "c_plain" }, ls: { "aiwb.widths": JSON.stringify({ side: w, panel: 400 }) } }, async (page) => {
    const head = () => page.evaluate((ids) => {
      const pane = document.querySelector('[data-testid="side-pane"]').getBoundingClientRect(), box = document.querySelector('[data-testid="side-head"]');
      const ctl = (id) => { const e = document.querySelector(`[data-testid="${id}"]`), r = e.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { id, w: r.width, past: Math.round((r.right - pane.right) * 10) / 10, hit: at === e || e.contains(at) }; };
      return { controls: ids.map(ctl), scroll: box.scrollWidth - box.clientWidth };
    }, ["side-hide", "side-new"]);
    const h = await head();
    for (const c of h.controls) if (c.past > 0 || !c.hit || c.w < 26) fail(`the head at ${w} px, connected: ${c.id} is ${c.w} px wide, ends ${c.past} px past the pane and ${c.hit ? "is" : "is not"} what is at its centre`);
    if (h.scroll > 0) fail(`the head at ${w} px, connected: its content is ${h.scroll} px wider than it`);
  });

  // ---- the focus in the composer's box: ⌘B leaves it there; the head's control takes it to the rail's, which gives it to the head's
  await run({ sel: { chat: "c_plain" } }, async (page) => {
    const box = byTid(page, "composer-input").first();
    await press(page, box);
    await focusIs(page, "before anything", "composer");
    await hide(page, "the focus", "key");
    await timers(page); await frames(page);
    await focusIs(page, "hidden by ⌘B with the focus in the composer", "composer");
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: ⌘B did not show the sidebar");
    await timers(page); await frames(page);
    await focusIs(page, "shown by ⌘B with the focus in the composer", "composer");
    await hide(page, "the focus", "control");
    await focusIs(page, "hidden by the head's control, the focus in the composer before", "rail");
    await show(page, "the focus");
    await focusIs(page, "shown from the rail", "head");
    note("the focus: left in the composer's box by ⌘B; to the rail's control when the head's control hid the sidebar");
  });

  // ---- the focus
  await run({ sel: {} }, async (page) => {
    const outside = byTid(page, "home-new-chat").first();
    await outside.focus();
    await focusIs(page, "before anything", "outside");
    await hide(page, "the focus", "key");
    await timers(page); await frames(page);
    await focusIs(page, "hidden by ⌘B with the focus outside the sidebar", "outside");
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: ⌘B did not show the sidebar");
    await timers(page); await frames(page);
    await focusIs(page, "shown by ⌘B with the focus outside the sidebar", "outside");

    await outside.focus();
    await hide(page, "the focus", "control");
    await focusIs(page, "hidden by the head's control, the focus outside before", "rail");
    await show(page, "the focus");
    await focusIs(page, "shown from the rail", "head");

    await byTid(page, "side-archived").first().focus();
    await hide(page, "the focus", "key");
    await focusIs(page, "hidden by ⌘B with the focus in the sidebar", "rail");
    await page.keyboard.press("Enter");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: Enter on the rail's control did not show the sidebar");
    await focusIs(page, "shown by Enter on the rail's control", "head");
    await page.keyboard.press("Enter");
    if (!await until(() => isHidden(page), 10000)) fail("the focus: Enter on the head's control did not hide the sidebar");
    await focusIs(page, "hidden by Enter on the head's control", "rail");
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: ⌘B on the rail's control did not show the sidebar");
    await focusIs(page, "shown by ⌘B with the focus on the rail's control", "head");
    note("the focus: to the rail's control when the head's control hid the sidebar and when ⌘B did with the focus in it; to the head's control when the rail showed it; left outside by ⌘B");
  });
  // ---- what hiding closes
  /** Every call the page makes that is not a read, as the page makes it. */
  const spy = (page) => page.evaluate(() => {
    window.__calls = [];
    const f = window.fetch;
    window.fetch = (u, o) => { // (a call goes to the host as POST /host/call, with the call's own method in the query)
      const q = new URL(u, location.href), m = q.searchParams.get("method");
      if (q.pathname === "/host/call" && m && m !== "GET") window.__calls.push(`${m} ${q.searchParams.get("path")} ${o?.body ?? ""}`);
      return f(u, o);
    };
  });
  const calls = (page) => page.evaluate(() => window.__calls.splice(0));
  const sideInputs = (page) => page.locator('[data-testid="side"] [data-testid="name-input"]').count();
  const sideMenus = (page) => byTid(page, "menu").count();
  /** Puts a row in rename mode by its menu and types a name into its box; answers the name it had. */
  const rename = async (page, name, row, nameId, text) => {
    const was = (await byTid(row, nameId).first().textContent()).trim();
    await sideMenu(page, row, "More", "Rename");
    const input = byTid(row, "name-input");
    // (the box is ready when it has the focus and its name is selected: react-native-web selects it in a timer after the focus, and a select that came
    // after the first keys would replace them)
    const ready = (i) => document.activeElement === i && i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value.length > 0;
    if (!await until(() => input.evaluate(ready).catch(() => false), 10000)) { fail(`${name}: "Rename" opened no box with the focus and the name selected`); return null; }
    await page.keyboard.type(text);
    if (await input.inputValue() !== text) { fail(`${name}: the box holds "${await input.inputValue()}" after "${text}" was typed`); return null; }
    await calls(page);
    return was;
  };
  /** A rename box with a name typed, then the sidebar hidden: nothing is saved, and the row has its name. */
  const dropped = async (page, kind, row, nameId, how) => {
    const name = `the rename box of ${kind}, hidden by ${HOW[how]}`, text = `Zz ${kind} ${how}`;
    const was = await rename(page, name, row, nameId, text);
    if (was === null) return;
    await hide(page, name, how);
    await focusIs(page, name, "rail");
    await timers(page); await frames(page);
    await focusIs(page, name + ", a moment later", "rail");
    if (await sideInputs(page)) fail(`${name}: the box is still in the hidden sidebar`);
    await show(page, name);
    await focusIs(page, name + ", shown again", "head");
    if (await sideInputs(page)) fail(`${name}: the box is there when the sidebar is shown`);
    const now = (await byTid(row, nameId).first().textContent().catch(() => "")).trim();
    if (now !== was) fail(`${name}: the row is named "${now}", "${was}" before`);
    const made = await calls(page);
    if (made.length) fail(`${name}: the page saved something: ${made.join("; ")}`);
  };
  /** Something open in the sidebar (`openIt` opens a menu), then the sidebar hidden by the key: it is closed, hidden and shown. By the
   *  head's control the press is the menu layer's: the menu is closed and the sidebar stays. */
  const closed = async (page, what, openIt, how) => {
    const name = `${what}, hidden by ${HOW[how]}`;
    await openIt();
    if (!await until(async () => await sideMenus(page) > 0, 10000)) return fail(`${name}: it did not open`);
    if (how === "key") {
      await hide(page, name, how);
      if (!await until(async () => !await sideMenus(page), 5000)) fail(`${name}: the menu is still in the hidden sidebar`);
      await frames(page);
      await focusIs(page, name, "rail");
      await show(page, name);
    } else {
      const h = await byTid(page, "side-hide").first().boundingBox();
      if (await touchOf(page)) await page.touchscreen.tap(h.x + h.width / 2, h.y + h.height / 2); else await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2);
      if (!await until(async () => !await sideMenus(page), 5000)) fail(`${name}: a press on the head's control did not close the menu`);
      if (await isHidden(page)) fail(`${name}: the press that closed the menu hid the sidebar as well`);
    }
    if (await sideMenus(page) || await page.locator('[data-testid="side-more"][aria-selected="true"], [data-testid="side-add"][aria-selected="true"]').count()) fail(`${name}: it is open when the sidebar is shown`);
  };
  const touchOf = (page) => page.evaluate(() => navigator.maxTouchPoints > 0);

  await run({ sel: { chat: "c_plain" } }, async (page) => {
    await spy(page);
    const group = page.locator('[data-testid="side-group-head"][title="Shop"]').first(), board = page.locator('[data-testid="side-row"][title="Shop / arch"]').first();
    const chat = byTid(page, "side-row", { kind: "chat" }).and(page.locator('[aria-selected="true"]')).first();
    for (const how of ["key", "control"]) {
      await dropped(page, "a group", group, "side-group-name", how);
      await dropped(page, "a board", board, "side-name", how);
      await dropped(page, "a chat", chat, "side-name", how);
    }
    const more = (row) => () => sideMenu(page, row, "More").then(() => {});
    for (const how of ["key", "control"]) {
      await closed(page, 'the head\'s "+" menu', () => press(page, byTid(page, "side-new").first()), how);
      await closed(page, "a chat row's menu", more(chat), how);
      await closed(page, 'a group\'s "+" menu', () => sideMenu(page, group, "New in Shop").then(() => {}), how);
      await closed(page, "a group's menu", more(group), how);
      await closed(page, "a board row's menu", more(board), how);
    }
    const made = await calls(page);
    if (made.length) fail(`the menus: the page saved something: ${made.join("; ")}`);

    // the listener's own proof: a box that loses the focus to a press elsewhere saves its text
    const text = "Zz saved by blur";
    if (await rename(page, "a group's rename box", group, "side-group-name", text) !== null) {
      await press(page, byTid(page, "side-brand").first());
      const saved = await until(async () => (await page.evaluate(() => window.__calls)).find((c) => c.includes(text)), 10000);
      if (!saved) fail("a rename box that lost the focus to a press on the sidebar's head saved nothing: the check would not see a save");
      else note(`a rename box that loses the focus saves (${saved.split(" ").slice(0, 2).join(" ")}); hidden by ⌘B and by the head's control, a group's, a board's and a chat's saved nothing`);
    }
  });
}, { viewports, page: false });
