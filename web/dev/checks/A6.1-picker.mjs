// Proves A6.1: the theme's picker is one button in the sidebar's foot, in place of the three-button switch. Its menu
// opens upward and offers Light, Dark, System and the four Catppuccin flavours, with the chosen one marked, and only
// that one. A pick puts the page in that theme at once (data-theme and data-flavour on <html>, the page's
// background), saves it, closes the menu and leaves the focus on the button. The keys work: Enter opens with the
// focus on the choice, the arrows, Home and End move, Esc closes and changes nothing; a press outside closes, and
// a press on the button closes and does not open again. The menu lies inside the window at the narrowest sidebar
// (200 px) and at the default one, each item under the pointer at its own centre; in a window too low for it it
// scrolls, and its first and last item can still be picked. It closes when the sidebar is hidden, by the key and by
// the head's control, and is not open when the sidebar shows again. System follows the OS between light and dark,
// and a flavour does not.
// P7.2 hides the sidebar with the menu open beside the other goals' controls.
import { check, colourOf, openPage, until } from "../shot.mjs";

const LABELS = ["Light", "Dark", "System", "Latte", "Frappé", "Macchiato", "Mocha"];
const PREFS = {
  light: { label: "Light", theme: "light", bg: "#ffffff", title: "Theme: Light" },
  dark: { label: "Dark", theme: "dark", bg: "#1c1c21", title: "Theme: Dark" },
  system: { label: "System", theme: "light", bg: "#ffffff", title: "Theme: System (follows the OS)" }, // (the browser's system is light)
  latte: { label: "Latte", theme: "light", flavour: "latte", bg: "#eff1f5", title: "Theme: Catppuccin Latte" },
  frappe: { label: "Frappé", theme: "dark", flavour: "frappe", bg: "#303446", title: "Theme: Catppuccin Frappé" },
  macchiato: { label: "Macchiato", theme: "dark", flavour: "macchiato", bg: "#24273a", title: "Theme: Catppuccin Macchiato" },
  mocha: { label: "Mocha", theme: "dark", flavour: "mocha", bg: "#1e1e2e", title: "Theme: Catppuccin Mocha" },
};
const BTN = ".side-foot .theme-btn", MENU = '.side-foot [role="menu"][aria-label="Theme"]', ITEM = `${MENU} [role="menuitemradio"]`;
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** In the page: the picker as it is now. */
function picker() {
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const btn = document.querySelector(".side-foot .theme-btn"), menu = document.querySelector('.side-foot [role="menu"][aria-label="Theme"]');
  const items = menu ? [...menu.querySelectorAll('[role="menuitemradio"]')] : [];
  const focus = document.activeElement;
  return {
    buttons: document.querySelectorAll(".side-foot .theme-btn").length, seg: document.querySelectorAll(".seg, [role=radiogroup][aria-label=Theme]").length,
    title: btn?.title ?? null, name: btn?.getAttribute("aria-label") ?? null, expanded: btn?.getAttribute("aria-expanded") ?? null, btn: btn && btn.getClientRects().length ? R(btn) : null,
    open: !!menu, menus: document.querySelectorAll('[role="menu"][aria-label="Theme"]').length, menu: menu && R(menu),
    scroll: menu && { top: menu.scrollTop, height: menu.scrollHeight, client: menu.clientHeight, overflow: getComputedStyle(menu).overflowY },
    heads: menu ? [...menu.querySelectorAll(".menu-head")].map((h) => h.textContent.trim()) : [],
    items: items.map((e) => {
      const r = R(e), at = document.elementFromPoint(r.l + r.w / 2, r.t + r.h / 2);
      return { label: e.querySelector(".menu-label")?.textContent.trim(), pref: e.dataset.themePref, checked: e.getAttribute("aria-checked"), on: e.classList.contains("on"), mark: e.textContent.includes("✓"),
        r, hit: at === e || e.contains(at), icon: !!e.querySelector("svg") };
    }),
    focus: !focus || focus === document.body ? "nothing" : focus.matches(".side-foot .theme-btn") ? "button" : focus.matches('[role="menuitemradio"]') ? "item " + focus.dataset.themePref : focus.tagName.toLowerCase() + "." + focus.className,
    theme: document.documentElement.dataset.theme ?? null, flavour: document.documentElement.dataset.flavour ?? null, saved: localStorage.getItem("aiwb.theme"),
    w: innerWidth, h: innerHeight, side: document.querySelector(".side-pane")?.getBoundingClientRect().width ?? 0,
  };
}

await check("A6.1 the theme's picker: one button, a menu of seven with the choice marked, inside the window, closed with the sidebar", async ({ url, browser, fail, note }) => {
  const sized = (side) => ({ "aiwb.widths": JSON.stringify({ side, panel: 400 }) });
  const read = (page) => page.evaluate(picker);
  // (a menu hears a press outside from the task after it was drawn, so that the press that opened it does not close
  // it: the check waits for that task, as a hand does without knowing)
  const settled = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok)))));
  const openMenu = async (page) => { await page.locator(BTN).click(); await page.waitForSelector(MENU, { timeout: 10000 }); await settled(page); };
  const closed = (page) => until(() => page.evaluate(() => !document.querySelector('[role="menu"][aria-label="Theme"]')), 10000);
  /** The page is in the theme of `pref`: the attributes, the saved value, the background, the button's words. */
  const shows = async (page, pref, tag, saved = pref) => {
    const want = PREFS[pref], m = await read(page), bg = hex(await colourOf(page, "html", "backgroundColor"));
    const say = (line) => fail(`${tag}: ${line}`);
    if (m.theme !== want.theme || m.flavour !== (want.flavour ?? null)) say(`<html> has data-theme "${m.theme}" and data-flavour ${JSON.stringify(m.flavour)}, not "${want.theme}" and ${JSON.stringify(want.flavour ?? null)}`);
    if (m.saved !== saved) say(`localStorage "aiwb.theme" is ${JSON.stringify(m.saved)}, not ${JSON.stringify(saved)}`);
    if (bg !== want.bg) say(`the page's background is ${bg}, not ${want.bg}`);
    if (m.title !== want.title || m.name !== want.title) say(`the button's tooltip is "${m.title}" and its name "${m.name}", not "${want.title}"`);
    return m;
  };
  /** The open menu offers the seven, and marks `pref` alone. */
  const offers = (m, pref, tag) => {
    const say = (line) => fail(`${tag}: ${line}`);
    if (!m.open || m.menus !== 1 || m.expanded !== "true") return say(`the page has ${m.menus} theme menus and the button says aria-expanded="${m.expanded}"`);
    if (m.items.map((i) => i.label).join("|") !== LABELS.join("|")) say(`the menu offers ${m.items.map((i) => i.label).join(", ")}; it must offer ${LABELS.join(", ")}`);
    if (m.items.map((i) => i.pref).join("|") !== Object.keys(PREFS).join("|")) say(`the items stand for ${m.items.map((i) => i.pref).join(", ")}`);
    if (m.heads.join("|") !== "Theme|Catppuccin") say(`the menu's heads are ${m.heads.join(", ")}`);
    const marked = m.items.filter((i) => i.checked === "true"), drawn = m.items.filter((i) => i.on || i.mark);
    if (marked.length !== 1 || marked[0].pref !== pref) say(`${marked.map((i) => i.label).join(", ") || "nothing"} is marked as chosen (aria-checked), not ${PREFS[pref].label} alone`);
    if (drawn.length !== 1 || drawn[0].pref !== pref || !drawn[0].on || !drawn[0].mark) say(`${drawn.map((i) => i.label).join(", ") || "nothing"} is drawn as chosen (the row's tint and its tick), not ${PREFS[pref].label} alone`);
    if (m.items.some((i) => !i.icon)) say("an item has no icon");
  };
  /** The open menu lies inside the window, and every item that is not scrolled out is under the pointer at its centre. */
  const inside = (m, tag) => {
    const say = (line) => fail(`${tag}: ${line}`);
    if (!m.menu) return say("no menu is open");
    if (m.menu.l < 0 || m.menu.r > m.w || m.menu.t < 0 || m.menu.b > m.h) say(`the menu lies from ${m.menu.l}, ${m.menu.t} to ${m.menu.r}, ${m.menu.b}: the window is ${m.w} by ${m.h}`);
    if (m.btn && m.menu.b > m.btn.t) say(`the menu ends at ${m.menu.b}, under the top of its button (${m.btn.t}): it does not open upward`);
    for (const i of m.items) {
      const shown = i.r.t >= m.menu.t - 0.5 && i.r.b <= m.menu.b + 0.5;
      if (i.r.l < m.menu.l || i.r.r > m.menu.r) say(`${i.label} lies from ${i.r.l} to ${i.r.r}, past its menu (${m.menu.l} to ${m.menu.r})`);
      if (shown && !i.hit) say(`${i.label} is not the element at its own centre: something covers it`);
    }
    return m.items.filter((i) => i.r.t >= m.menu.t - 0.5 && i.r.b <= m.menu.b + 0.5).length;
  };

  // ---- the button, the menu, a pick of each
  {
    const { ctx, page } = await openPage({ url, browser, size: [1000, 700] });
    try {
      const first = await shows(page, "system", "a page that never chose", null);
      if (first.buttons !== 1 || first.seg) fail(`the sidebar's foot has ${first.buttons} theme buttons and ${first.seg} three-button switches: it must have one button and no switch`);
      if (first.open) fail("the menu is open before the button was pressed");
      await openMenu(page);
      offers(await read(page), "system", "a page that never chose");
      await page.keyboard.press("Escape");
      if (!await closed(page)) fail("Esc did not close the menu");

      for (const pref of ["dark", "latte", "frappe", "macchiato", "mocha", "light", "system"]) {
        await openMenu(page);
        await page.locator(`${ITEM}[data-theme-pref="${pref}"]`).click();
        if (!await closed(page)) fail(`a pick of ${PREFS[pref].label} did not close the menu`);
        const m = await shows(page, pref, `${PREFS[pref].label} picked`);
        if (m.focus !== "button") fail(`${PREFS[pref].label} picked: the focus is on ${m.focus}, not on the picker's button`);
        if (m.expanded !== "false") fail(`${PREFS[pref].label} picked: the button says aria-expanded="${m.expanded}" with no menu`);
        await openMenu(page);
        const open = await read(page);
        offers(open, pref, `the menu after ${PREFS[pref].label} was picked`);
        if (open.focus !== "item " + pref) fail(`the menu opened after ${PREFS[pref].label}: the focus is on ${open.focus}, not on the chosen item`);
        await page.locator(BTN).click(); // a press on the button closes, and the click does not open it again
        if (!await closed(page)) fail("a press on the button did not close its open menu");
        await settled(page);
        if ((await read(page)).open) fail("a press on the button closed its menu and the click opened it again");
      }

      // the keys (the choice is System, the third item)
      await page.locator(BTN).focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector(MENU, { timeout: 10000 });
      const steps = [["the menu opened by Enter", null, "item system"], ["ArrowDown", "ArrowDown", "item latte"], ["End", "End", "item mocha"], ["ArrowDown at the end", "ArrowDown", "item light"],
        ["ArrowUp at the start", "ArrowUp", "item mocha"], ["Home", "Home", "item light"], ["ArrowDown", "ArrowDown", "item dark"]];
      for (const [what, key, want] of steps) {
        if (key) await page.keyboard.press(key);
        const m = await read(page);
        if (m.focus !== want) fail(`${what}: the focus is on ${m.focus}, not on ${want}`);
      }
      await page.keyboard.press("Escape");
      if (!await closed(page)) fail("Esc did not close the menu the keys moved in");
      const esc = await shows(page, "system", "Esc on another item than the choice");
      if (esc.focus !== "button") fail(`after Esc the focus is on ${esc.focus}, not on the picker's button`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(MENU, { timeout: 10000 });
      await page.keyboard.press("End"); await page.keyboard.press("Enter");
      if (!await closed(page)) fail("Enter on an item did not close the menu");
      if ((await shows(page, "mocha", "Mocha picked by the keys")).focus !== "button") fail("after a pick by the keys the focus is not on the picker's button");

      // a press outside closes, and changes nothing
      await openMenu(page);
      await page.mouse.click(700, 300);
      if (!await closed(page)) fail("a press outside did not close the menu");
      await shows(page, "mocha", "a press outside the menu");

      // System follows the OS; a flavour does not
      for (const [pref, scheme, want] of [["system", "dark", "dark"], ["system", "light", "light"], ["mocha", "light", "dark"], ["latte", "dark", "light"]]) {
        await openMenu(page);
        await page.locator(`${ITEM}[data-theme-pref="${pref}"]`).click();
        await page.emulateMedia({ colorScheme: scheme });
        if (!await until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, want), 10000)) fail(`${PREFS[pref].label} with the OS ${scheme}: data-theme did not become "${want}"`);
        const m = await read(page);
        if (m.flavour !== (PREFS[pref].flavour ?? null) || m.saved !== pref) fail(`${PREFS[pref].label} with the OS ${scheme}: data-flavour is ${JSON.stringify(m.flavour)} and the saved choice ${JSON.stringify(m.saved)}`);
      }
      await page.emulateMedia({ colorScheme: "light" });
    } finally { await ctx.close(); }
  }

  // ---- inside the window: at the narrowest sidebar and the default one; in a low window it scrolls
  const told = [];
  for (const side of [200, 264]) {
    const { ctx, page } = await openPage({ url, browser, size: [1000, 700], ls: { ...sized(side), "aiwb.theme": "macchiato" } });
    try {
      for (const height of [700, 320, 240, 200]) {
        await page.setViewportSize({ width: 1000, height });
        await openMenu(page);
        const m = await read(page), tag = `a ${side} px sidebar in a window ${height} px high`;
        if (Math.abs(m.side - side) > 0.5) fail(`${tag}: the sidebar is ${m.side} px wide`);
        offers(m, "macchiato", tag);
        const seen = inside(m, tag);
        if (m.scroll.height > m.scroll.client + 0.5) {
          if (!/auto|scroll/.test(m.scroll.overflow)) fail(`${tag}: the menu's content is ${m.scroll.height} px in ${m.scroll.client} and it does not scroll (overflow-y ${m.scroll.overflow})`);
          // its last item, then its first, each brought into sight by scrolling the menu
          for (const [pref, at] of [["mocha", "the end"], ["light", "the start"]]) {
            await page.locator(`${ITEM}[data-theme-pref="${pref}"]`).scrollIntoViewIfNeeded();
            const s = await read(page), it = s.items.find((i) => i.pref === pref);
            if (!(it.r.t >= s.menu.t - 0.5 && it.r.b <= s.menu.b + 0.5) || !it.hit) fail(`${tag}: scrolled to ${at}, ${it.label} lies from ${it.r.t} to ${it.r.b} in a menu from ${s.menu.t} to ${s.menu.b}${it.hit ? "" : " and is covered"}`);
            inside(s, `${tag}, scrolled to ${at}`);
          }
          await page.locator(`${ITEM}[data-theme-pref="mocha"]`).click();
          if (!await closed(page)) fail(`${tag}: a pick in the scrolled menu did not close it`);
          await shows(page, "mocha", `${tag}, Mocha picked in the scrolled menu`);
          await openMenu(page);
          await page.locator(`${ITEM}[data-theme-pref="macchiato"]`).click();
          if (!await closed(page)) fail(`${tag}: the second pick in the scrolled menu did not close it`);
          told.push(`${side}/${height}: ${seen} of 7 in sight, scrolls ${Math.round(m.scroll.height - m.scroll.client)} px`);
        } else {
          if (seen !== 7) fail(`${tag}: ${seen} of the 7 items are in sight in a menu that does not scroll`);
          if (height <= 240) fail(`${tag}: the menu does not scroll: the check has no window too low for it`);
          await page.keyboard.press("Escape");
          if (!await closed(page)) fail(`${tag}: Esc did not close the menu`);
          told.push(`${side}/${height}: all 7 in sight, from ${Math.round(m.menu.l)} to ${Math.round(m.menu.r)} px`);
        }
      }
    } finally { await ctx.close(); }
  }
  note(`the menu by sidebar width / window height: ${told.join("; ")}`);

  // ---- hiding the sidebar closes it
  {
    const { ctx, page } = await openPage({ url, browser, size: [1000, 700], ls: { "aiwb.theme": "frappe" } });
    try {
      for (const [how, hide] of [["⌘B", () => page.keyboard.press("ControlOrMeta+b")], ["the head's control", () => page.locator(".side-head .side-hide").click()]]) {
        await openMenu(page);
        await hide();
        if (!await until(() => page.evaluate(() => !!document.querySelector(".app > .side-rail .side-show")), 10000)) { fail(`${how} did not hide the sidebar while the theme's menu was open`); continue; }
        const hidden = await read(page);
        if (hidden.open || hidden.menus) fail(`hidden by ${how}: the theme's menu is still in the page`);
        if (hidden.btn) fail(`hidden by ${how}: the picker's button is still drawn`);
        await page.keyboard.press("ControlOrMeta+b");
        if (!await until(() => page.evaluate(() => !document.querySelector(".side-rail") && !!document.querySelector(".side-foot .theme-btn")?.getClientRects().length), 10000)) { fail(`⌘B did not show the sidebar that ${how} hid`); continue; }
        const back = await shows(page, "frappe", `shown again after ${how}`);
        if (back.open) fail(`shown again after ${how}: the theme's menu is open`);
        if (back.expanded !== "false") fail(`shown again after ${how}: the button says aria-expanded="${back.expanded}"`);
      }
    } finally { await ctx.close(); }
  }
});
