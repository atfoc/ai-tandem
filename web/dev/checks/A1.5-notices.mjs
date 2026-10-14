// Proves A1.5. The rail's control has its dot while this computer's section has something to say (its server is not
// connected, is of another build than the app, did not start) and at no other time: not for another server that is not
// connected.
// Hiding by the head's control, and by ⌘B with the focus in the sidebar, puts the focus on the rail's control;
// showing from the rail puts it on the head's; a focus outside the sidebar stays where it is through ⌘B. Hiding
// either way ends a rename box (a group's, a board's, a chat's) with its text not saved, though a box that
// loses the focus saves: the check ends with one that does, heard by the same listener. And it closes the head's
// "+" menu, a chat row's and a board row's menu, a group's "+" menu and a group's menu. With the sidebar shown its
// head holds its two controls inside the pane, down to the pane's least width.
// The theme picker's menu, which closes too, is P7.2's: there the sidebar is hidden with it open.
import { check, mockEval, openPage, seed, until } from "../shot.mjs";

const UNDO = "delete flags.streamDown; delete flags.hello; setServerState('local', 'connected');";

await check("A1.5 the rail's dot, the focus, and what hiding the sidebar closes", async ({ url, browser, fail, note }) => {
  await seed(url, "A1");
  const bundle = await fetch(url + "/main.js").then((r) => r.text(), () => "");
  if (!bundle.includes('"uicheck"')) fail('the build\'s version is not "uicheck": a server of another build needs a version of the page to differ from (buildDist of dev/shot.mjs gives it)');
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** Every timer the page had set for the next moments has fired (the composer takes the focus 30 ms after it is
   *  asked to): a timer set now, with a later end, fires after them. */
  const timers = (page) => page.evaluate(() => new Promise((ok) => setTimeout(ok, 60)));
  const isHidden = (page) => page.evaluate(() => !!document.querySelector(".app > .side-rail") && !document.querySelector(".app > .side-pane").getClientRects().length);
  const focus = (page) => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? "nothing" : a.matches(".side-rail .side-show") ? "rail" : a.matches(".side-head .side-hide") ? "head" : a.matches(".composer-input") ? "composer" : a.tagName.toLowerCase() + "." + String(a.className).trim().split(/\s+/).join("."); });
  const focusIs = async (page, name, want) => { if (!await until(async () => await focus(page) === want, 10000)) fail(`${name}: the focus is on ${await focus(page)}, not on ${want === "rail" ? "the rail's control" : want === "head" ? "the head's control" : "the " + want}`); };
  const HOW = { key: "⌘B", control: "the head's control" };
  const hide = async (page, name, how) => {
    if (how === "key") await page.keyboard.press("ControlOrMeta+b"); else await page.locator(".side-head .side-hide").click();
    if (!await until(() => isHidden(page), 10000)) fail(`${name}: ${HOW[how]} did not hide the sidebar`);
  };
  const show = async (page, name) => {
    await page.locator(".side-rail .side-show").click();
    if (!await until(async () => !await isHidden(page), 10000)) fail(`${name}: the rail's control did not show the sidebar`);
  };
  const open = async (o, body) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, ...o });
    try { await body(page); } finally { for (const e of errors) fail(`page error: ${e}`); await ctx.close(); }
  };

  // ---- the dot
  await open({ sel: { chat: "c_plain" }, ls: { "aiwb.side": "hidden" }, wait: ".app > .side-rail" }, async (page) => { // (not the tree: it is not drawn)
    const HERE = '.side-section[data-server="local"]';
    const dot = () => page.evaluate((HERE) => {
      const d = document.querySelector(".side-rail .side-show .side-rail-dot"), c = document.querySelector(".side-rail .side-show");
      const r = d?.getBoundingClientRect(), b = c?.getBoundingClientRect();
      return { dot: !!d && r.width >= 5 && r.left >= b.left - 3 && r.right <= b.right + 3 && r.top >= b.top - 3 && r.bottom <= b.bottom + 3 && getComputedStyle(d).backgroundColor !== "rgba(0, 0, 0, 0)",
        state: document.querySelector(`${HERE} .side-section-state`)?.textContent ?? "", extra: document.querySelector(`${HERE} .side-section-extra`)?.textContent ?? "", label: c?.getAttribute("aria-label") ?? "" };
    }, HERE);
    /** Waits for this computer's section to say what is told, then holds the dot against it: the dot and the control's
     *  name as they were read together (a later reading may be of the next moment). */
    const at = async (name, { state, extra }, want) => {
      const ok = await until(async () => { const s = await dot(); return s.state === state && s.extra.includes(extra) && !!s.extra === !!extra && s.dot === want ? s : null; }, 30000);
      const s = ok || await dot();
      if (!ok) fail(`the dot, ${name}: the control has ${s.dot ? "a" : "no"} dot while this computer's section says "${s.state}" and ${s.extra ? `"${s.extra}"` : "nothing else"}`);
      else if (s.label.includes("notice") !== want) fail(`the dot, ${name}: the control is named "${s.label}"`);
    };
    if (!await isHidden(page)) return fail("the dot: the page did not open with the sidebar hidden");
    if (!await page.locator('.side-foot .servers-btn[title*="not connected"]').count()) fail("the dot: the seed's server that is not connected is not told by the Servers button");
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
      if (!await page.locator('.side-foot .servers-btn[title*="not connected"]').count()) fail("the dot: the Servers button lost its own dot");
    } finally { await mockEval(UNDO, url); }
    note("the dot: on while this computer's server was connecting, of another build, not started and too old; off when connected with a server of the list down, and after each");
  });

  // ---- the head of a sidebar that shows: the name gives way, the two controls stay inside the pane and can be hit
  for (const w of [200, 264]) await open({ sel: { chat: "c_plain" }, ls: { "aiwb.widths": JSON.stringify({ side: w, panel: 400 }) } }, async (page) => {
    const head = () => page.evaluate(() => {
      const pane = document.querySelector(".side-pane").getBoundingClientRect(), box = document.querySelector(".side-head");
      const ctl = (s) => { const e = box.querySelector(s), r = e.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { w: r.width, past: Math.round((r.right - pane.right) * 10) / 10, hit: at === e || e.contains(at) }; };
      return { hide: ctl(".side-hide"), plus: ctl(".icon-btn.new"), scroll: box.scrollWidth - box.clientWidth };
    });
    const held = async (name) => {
      const h = await head();
      for (const [what, c] of [["the control that hides the sidebar", h.hide], ['"+"', h.plus]]) if (c.past > 0 || !c.hit || c.w < 26) fail(`the head at ${w} px, ${name}: ${what} is ${c.w} px wide, ends ${c.past} px past the pane and ${c.hit ? "is" : "is not"} what is at its centre`);
      if (h.scroll > 0) fail(`the head at ${w} px, ${name}: its content is ${h.scroll} px wider than it`);
      return h;
    };
    await held("connected");
  });

  // ---- the focus
  await open({ sel: { chat: "c_plain" } }, async (page) => {
    const box = page.locator(".chat-page .composer .composer-input");
    await box.click();
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

    await page.locator(".side-foot .side-archived input").focus();
    await hide(page, "the focus", "key");
    await focusIs(page, "hidden by ⌘B with the focus on the sidebar's switch", "rail");
    await page.keyboard.press("Enter");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: Enter on the rail's control did not show the sidebar");
    await focusIs(page, "shown by Enter on the rail's control", "head");
    await page.keyboard.press("Enter");
    if (!await until(() => isHidden(page), 10000)) fail("the focus: Enter on the head's control did not hide the sidebar");
    await focusIs(page, "hidden by Enter on the head's control", "rail");
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => !await isHidden(page), 10000)) fail("the focus: ⌘B on the rail's control did not show the sidebar");
    await focusIs(page, "shown by ⌘B with the focus on the rail's control", "head");
    note("the focus: to the rail's control when the head's control hid the sidebar and when ⌘B did with the focus in it; to the head's control when the rail showed it; left in the composer by ⌘B");
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
  /** Puts a row in rename mode by its menu and types a name into its box; answers the name it had. */
  const rename = async (page, name, row, nameSel, text) => {
    const was = (await row.locator(nameSel).first().textContent()).trim();
    await row.hover();
    await row.locator('.icon-btn[title="More"]').first().click();
    await page.locator(".side .menu .menu-item", { hasText: "Rename" }).click();
    const input = row.locator(".name-input");
    if (!await until(() => input.evaluate((i) => document.activeElement === i).catch(() => false), 10000)) { fail(`${name}: "Rename" opened no box with the focus`); return null; }
    await page.keyboard.type(text);
    if (await input.inputValue() !== text) { fail(`${name}: the box holds "${await input.inputValue()}" after "${text}" was typed`); return null; }
    await calls(page);
    return was;
  };
  /** A rename box with a name typed, then the sidebar hidden: nothing is saved, and the row has its name. */
  const dropped = async (page, kind, row, nameSel, how) => {
    const name = `the rename box of ${kind}, hidden by ${HOW[how]}`, text = `Zz ${kind} ${how}`;
    const was = await rename(page, name, row, nameSel, text);
    if (was === null) return;
    await hide(page, name, how);
    await focusIs(page, name, "rail");
    await timers(page); await frames(page);
    await focusIs(page, name + ", a moment later", "rail");
    if (await page.locator(".side .name-input").count()) fail(`${name}: the box is still in the hidden sidebar`);
    await show(page, name);
    await focusIs(page, name + ", shown again", "head");
    if (await page.locator(".side .name-input").count()) fail(`${name}: the box is there when the sidebar is shown`);
    const now = (await row.locator(nameSel).first().textContent().catch(() => "")).trim();
    if (now !== was) fail(`${name}: the row is named "${now}", "${was}" before`);
    const made = await calls(page);
    if (made.length) fail(`${name}: the page saved something: ${made.join("; ")}`);
  };
  /** Something open in the sidebar (`opened` matches it), then the sidebar hidden: it is closed, hidden and shown. */
  const closed = async (page, what, openIt, opened, how) => {
    const name = `${what}, hidden by ${HOW[how]}`;
    await openIt();
    if (!await until(() => page.locator(opened).isVisible(), 10000)) return fail(`${name}: it did not open`);
    await hide(page, name, how);
    await frames(page);
    if (await page.locator(".side .menu").count()) fail(`${name}: the menu is still in the hidden sidebar`);
    await focusIs(page, name, "rail");
    await show(page, name);
    if (await page.locator(".side .menu, .side .side-hover.open").count()) fail(`${name}: it is open when the sidebar is shown`);
  };

  await open({ sel: { chat: "c_plain" } }, async (page) => {
    await spy(page);
    const group = page.locator('.side-group-head[title="Shop"]'), board = page.locator('.side-row.is-board[title="Shop / arch"]'), chat = page.locator(".side-row.is-chat.on");
    for (const how of ["key", "control"]) {
      await dropped(page, "a group", group, ".side-group-name", how);
      await dropped(page, "a board", board, ".side-name", how);
      await dropped(page, "a chat", chat, ".side-name", how);
    }
    const more = (row) => async () => { await row.hover(); await row.locator('.icon-btn[title="More"]').first().click(); };
    for (const how of ["key", "control"]) {
      await closed(page, 'the head\'s "+" menu', () => page.locator(".side-head .icon-btn.new").click(), ".side-head .menu", how);
      await closed(page, "a chat row's menu", more(chat), ".side-row.is-chat.on .menu", how);
      await closed(page, 'a group\'s "+" menu', async () => { await group.hover(); await group.locator('.icon-btn[title^="New in"]').click(); }, '.side-group-head[title="Shop"] .menu .menu-head', how);
      await closed(page, "a group's menu", more(group), '.side-group-head[title="Shop"] .menu', how);
      await closed(page, "a board row's menu", more(board), '.side-row.is-board[title="Shop / arch"] .menu', how);
    }
    const made = await calls(page);
    if (made.length) fail(`the menus: the page saved something: ${made.join("; ")}`);

    // the listener's own proof: a box that loses the focus to a press elsewhere saves its text
    const text = "Zz saved by blur";
    if (await rename(page, "a group's rename box", group, ".side-group-name", text) !== null) {
      await page.locator(".side-head .brand").click();
      const saved = await until(async () => (await page.evaluate(() => window.__calls)).find((c) => c.includes(text)), 10000);
      if (!saved) fail("a rename box that lost the focus to a press on the sidebar's head saved nothing: the check would not see a save");
      else note(`a rename box that loses the focus saves (${saved.split(" ").slice(0, 2).join(" ")}); hidden by ⌘B and by the head's control, a group's, a board's and a chat's saved nothing`);
    }
  });
});
