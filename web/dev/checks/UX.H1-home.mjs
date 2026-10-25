// UX.H1 (ux-improvements package H1, plans/ux-improvements/h1-design.md; PLAN §3 "H1" Checks): the phone's Home and the group screens, on the
// states of the seed UXH1 (dev/mock-ui.js; the servers are made in dev/mock.mjs `// ux-h1`), at the phone, in the light and in the dark theme
// (`aiwb.theme`; the page's <html data-theme> is read). One scenario per state, each against what the design and the mockups (sh2-10a…d, sh-08a, b) say:
//   one            no chips; the line under "Home" reads "Studio Mac · Connected"; the lists' sections
//   four           four chips (Studio Mac selected, each with its state word), GROUPS · BOARDS · CHATS with their counts, the group with a count
//                  (attention = count), the boards listed without their chats, the dot on a chat that needs you, no "…" or "+" in a row, every
//                  row 60 pt or more, a chip press switches the server; the gear's sheet holds the foot (Servers), a chip held opens its sheet
//   nested         Refunds three deep (the stack from the saved place): the large title, the line with the full place, the back naming the
//                  screen under it; the backs one at a time as far as Home; then down again by the rows (Checkout service › Payments › Refunds)
//   kinds          the group with two chats that need you (count 2), a board with a chat at work (no dot), a board with a chat that needs approval (dot)
//   empty-group    "Nothing here yet" and its "+ New", which opens the New sheet (H2: the Where card with the group, Chat, Whiteboard, Group; Esc and a press outside close it)
//   connecting     five placeholder rows, "+ New" dimmed
//   trouble        a server dropped after its list was drawn: the card above the list, faded; a press on a faded row says it is offline, opens nothing
//   cert           the certificate that changed: Review (no Try again) and no list
//   empty-server   a connected server with nothing on it: the two buttons, the agents line, no search
//   none           no server at all: the first run's three buttons, no "+ New", no search, no large title
// A screenshot of each state in each theme is written to $OUT (default `<tmp>/ux-h1-home`) for a person's look.
//
// Run: `cd web && VIEWPORT=phone npm run uicheck -- UX.H1`, or alone: VIEWPORT=phone node web/dev/checks/UX.H1-home.mjs (DIST=… as README.md says).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { homeSeen } from "./home.mjs";
import { newSheetSeen } from "./rows.mjs";

export const viewports = ["phone"];

const WAIT = 20000;
const OUT = process.env.OUT || path.join(os.tmpdir(), "ux-h1-home");
const J = JSON.stringify;

const STUDIO = "h1_studio", BUILD = "h1_build", ATTIC = "h1_attic", CERT = "h1_cert";
const UNDO = "setServerState('local', 'connected'); uxh1Reset();"; // (what P0.3 undoes after a state of this seed)
const key = (server, id) => `${server}~${id}`;

await check("UX.H1 the phone's Home: the chips, the lists, the group screens and the states, light and dark", async ({ url, open, fail, note }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const states = await seed(url, "UXH1"); // (the machines the states list: made once; a state's `pre` lists the ones it shows, UNDO puts the list back)

  /** Opens the state `id` of the seed (as P0.3 does: the state's `pre`, the page with its `ls`, then its `mock`), runs `body`
   *  with the page and helpers, takes the state's screenshot (`shot()` again for another one), closes the page. */
  const scenario = async (id, theme, body) => {
    const tag = `${theme} ${id}`;
    const bad = (line) => fail(`${tag}: ${line}`);
    const s = states.find((x) => x.id === id);
    if (!s) return bad("the seed has no such state");
    if (s.pre) await mockEval(s.pre, url);
    const o = await open({ ls: { ...s.ls, "aiwb.theme": theme }, wait: "" });
    const { page } = o;
    try {
      if (s.mock && id !== "trouble") await mockEval(s.mock, url); // (trouble drops its server itself, once Home has drawn the list)
      const seen = (root) => homeSeen(page, root);
      const ok = async (fn) => { try { return await fn(); } catch { return false; } };
      /** Waits for `fn` to be true; fails with `what` when it never is. */
      const wait = async (what, fn, ms = WAIT) => { const v = await until(() => ok(fn), ms); if (!v) bad(what); return !!v; };
      const shown = (tid, data) => ok(() => byTid(page, tid, data).first().isVisible());
      const count = (tid, data) => byTid(page, tid, data).count();
      const screens = (what) => wait(`${what}`, async () => (await count("home")) + (await count("group-screen")) > 0);
      const shot = (name = "") => page.screenshot({ path: path.join(OUT, `${id}${name ? "-" + name : ""}-${theme}.png`) });
      await wait("the page is not in the " + theme + " theme", () => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), 5000);
      await screens("neither Home nor a group screen is drawn");
      await body({ page, seen, wait, shown, count, shot, bad, ok });
    } catch (e) { bad(String(e.message).split("\n")[0]); }
    await o.ctx.close();
    await mockEval(UNDO, url);
  };

  /** Every row is 60 pt or more, and says no "…" or "+" (what H2 will put in its sheets, not on the row). */
  const rowsPlain = (v, bad, what) => {
    for (const r of v.rows) {
      if (r.height < 60) bad(`${what}: the row "${r.name}" is ${r.height.toFixed(1)} px high; a row is 60 pt or more`);
      if (/[…+]/.test(r.name + r.sub)) bad(`${what}: the row "${r.name}" says "${r.name} | ${r.sub}": no "…" or "+" in a row`);
    }
  };
  const rowOf = (v, kind, name) => v.rows.find((r) => r.kind === kind && r.name === name);
  const sectionsOf = (v) => v.sections.map((s) => `${s.section}:${s.count}`).join(" ");
  /** The back control on top: its label and the text it draws. */
  const backOf = (page) => byTid(page, "nav-back").last().evaluate((e) => ({ label: e.getAttribute("aria-label"), text: e.innerText.trim() })).catch(() => null);
  /** A finger put on an element and held, then taken off the way the system does when a sheet opens under it (a cancel, as UX.F2's hold). */
  const hold = async (page, locator, ms = 800) => {
    const b = await locator.boundingBox();
    const c = await page.context().newCDPSession(page);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] });
    await page.waitForTimeout(ms);
    await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await c.detach();
  };

  for (const theme of ["light", "dark"]) {
    // ---- one server: no chips, the sub-line, the sections
    await scenario("one", theme, async ({ seen, wait, shown, count, shot, bad }) => {
      await wait("Home never shows its list", async () => (await seen()).state === "list");
      const v = await seen();
      if (v.server !== "h1_one") bad(`Home shows ${J(v.server)}, not h1_one`);
      if (v.title !== "Home") bad(`the large title says ${J(v.title)}, not "Home"`);
      if (v.chips.length || await count("server-chips")) bad(`one server draws ${v.chips.length} chips; one server has none`);
      if (v.sub !== "Studio Mac · Connected") bad(`the line under "Home" says ${J(v.sub)}, not "Studio Mac · Connected"`);
      if (sectionsOf(v) !== "groups:1 boards:1 chats:1") bad(`the sections are [${sectionsOf(v)}], not [groups:1 boards:1 chats:1]`);
      const g = rowOf(v, "group", "Checkout service");
      if (!g || g.attention !== "none") bad(`the group row is ${J(g)}`);
      else if (g.sub !== "1 board") bad(`Checkout service says ${J(g.sub)}, not "1 board"`);
      const b = rowOf(v, "board", "Orders data model");
      if (b?.sub !== "Whiteboard · 1 chat") bad(`Orders data model says ${J(b?.sub)}, not "Whiteboard · 1 chat"`);
      if (v.rows.some((r) => r.kind === "chat" && r.name === "Model the order lines")) bad("a chat of a board is listed on Home");
      for (const id of ["home-new", "home-gear", "home-search"]) if (!await shown(id)) bad(`${id} is not drawn`);
      rowsPlain(v, bad, "Home");
      await shot();
    });

    // ---- four servers
    await scenario("four", theme, async ({ page, seen, wait, shown, count, shot, bad, ok }) => {
      await wait("Home never shows its list", async () => (await seen()).state === "list");
      let v = await seen();
      const words = { [STUDIO]: "connected", [BUILD]: "connecting", [ATTIC]: "unreachable", [CERT]: "cert-changed" };
      const chips = v.chips.map((c) => `${c.server}:${c.word}${c.selected ? "*" : ""}`).join(" ");
      const want = [STUDIO, BUILD, ATTIC, CERT].map((id) => `${id}:${words[id]}${id === STUDIO ? "*" : ""}`).join(" ");
      if (chips !== want) bad(`the chips are [${chips}], not [${want}]`);
      if (v.server !== STUDIO) bad(`Home shows ${J(v.server)}, not ${STUDIO}`);
      if (await count("home-sub")) bad("with chips Home also draws the one-server line");
      if (sectionsOf(v) !== "groups:3 boards:2 chats:3") bad(`the sections are [${sectionsOf(v)}], not [groups:3 boards:2 chats:3]`);
      const names = (k) => v.rows.filter((r) => r.kind === k).map((r) => r.name).sort().join(" | "); // (the order is the sidebar's: by recency, not the mockup's)
      if (names("group") !== "Checkout service | Infra | Mobile app") bad(`the groups are ${J(names("group"))}`);
      if (names("board") !== "Onboarding flow | Orders data model") bad(`the boards are ${J(names("board"))}`);
      if (names("chat") !== "Fix the flaky cart test | Regex for promo codes | Rename the env vars") bad(`the chats are ${J(names("chat"))}`);
      const co = rowOf(v, "group", "Checkout service");
      if (co?.attention !== "count" || co.count !== "2") bad(`Checkout service has attention ${co?.attention} and count ${J(co?.count)}, not count 2`);
      if (co?.sub !== "2 boards · 2 groups · 2 chats") bad(`Checkout service says ${J(co?.sub)}, not "2 boards · 2 groups · 2 chats"`);
      for (const [n, sub] of [["Mobile app", "2 boards"], ["Infra", "3 boards · 1 chat"]]) {
        const r = rowOf(v, "group", n);
        if (r?.sub !== sub || r.attention !== "none") bad(`${n} is ${J(r)}, not ${J(sub)} with no attention`);
      }
      const ob = rowOf(v, "board", "Orders data model");
      if (ob?.sub !== "Whiteboard · 1 chat" || ob.attention !== "none") bad(`Orders data model is ${J(ob)}`);
      if (v.rows.some((r) => ["Model the order lines", "Approve the schema change", "Draft the checkout states"].includes(r.name))) bad("the chats of a board are listed on Home: it lists boards, not their chats");
      const rn = rowOf(v, "chat", "Rename the env vars");
      if (rn?.attention !== "dot" || rn.sub !== "Needs your approval") bad(`"Rename the env vars" is ${J(rn)}: a dot and "Needs your approval"`);
      const fl = rowOf(v, "chat", "Fix the flaky cart test");
      if (fl?.attention !== "dot" || fl.sub !== "Stopped") bad(`"Fix the flaky cart test" is ${J(fl)}: a dot and "Stopped"`);
      const rx = rowOf(v, "chat", "Regex for promo codes");
      if (rx?.attention !== "none" || !/Medium/.test(rx.sub)) bad(`"Regex for promo codes" is ${J(rx)}: no dot, its model's line`);
      for (const r of v.rows) if (r.kind === "chat" && r.attention === "count") bad(`a chat row has a count: ${J(r)}`);
      rowsPlain(v, bad, "Home");
      await shot();

      // a chip press switches the server (Home's `data-server`)
      await press(page, byTid(page, "server-chip", { server: BUILD }));
      await wait("a press on the Build box chip did not switch Home to it", async () => (await seen()).server === BUILD && (await seen()).chips.find((c) => c.server === BUILD)?.selected);
      v = await seen();
      if (v.chips.filter((c) => c.selected).length !== 1) bad(`${v.chips.filter((c) => c.selected).length} chips are selected`);
      await press(page, byTid(page, "server-chip", { server: STUDIO }));
      await wait("a press on the Studio Mac chip did not switch Home back", async () => (await seen()).server === STUDIO && (await seen()).state === "list");

      // the gear pushes Settings (S1's screen); its back returns to Home
      await press(page, byTid(page, "home-gear"));
      await wait("the gear did not push Settings", () => shown("settings-screen"));
      if (await count("home-settings-stopgap")) bad("the gear opened the stop-gap sheet, not Settings");
      if (!await ok(() => byTid(page, "settings-row", { row: "servers" }).last().isVisible())) bad("Settings has no Servers row");
      await press(page, byTid(page, "nav-back").last());
      await wait("the back of Settings did not return to Home", async () => (await seen()).server === STUDIO && (await seen()).state === "list" && !(await shown("settings-screen")));

      // a chip held opens the server's sheet (S2's, `srv-sheet`: UX.S2's `sheet` proves its rows)
      await hold(page, byTid(page, "server-chip", { server: STUDIO }));
      await wait("a long press on a chip did not open the server's sheet", () => shown("srv-sheet"));
      if (await ok(() => byTid(page, "srv-sheet").first().isVisible()) && !(await byTid(page, "srv-sheet").first().innerText()).includes("Studio Mac")) bad("the server's sheet does not name Studio Mac");
    });

    // ---- groups as screens: three deep, the backs, then down by the rows
    await scenario("nested", theme, async ({ page, seen, wait, shot, bad }) => {
      const at = (g) => key(STUDIO, g);
      const onScreen = (what, g, title, sub, back) => wait(`${what}: not on the screen of ${g}`, async () => (await seen()).key === at(g)).then(async (ok) => {
        if (!ok) return false;
        const v = await seen(), b = await backOf(page);
        if (v.title !== title) bad(`${what}: the large title says ${J(v.title)}, not ${J(title)}`);
        if (v.sub !== sub) bad(`${what}: the line under it says ${J(v.sub)}, not ${J(sub)}`);
        if (b?.label !== `Back to ${back}` || b.text !== back) bad(`${what}: the back is ${J(b)}, not "Back to ${back}"`);
        rowsPlain(v, bad, what);
        return true;
      });
      await onScreen("Refunds", "g_refunds", "Refunds", "Studio Mac › Checkout service › Payments · 1 board", "Payments");
      let v = await seen();
      if (sectionsOf(v) !== "boards:1" || v.rows[0]?.name !== "Refund rules" || v.rows[0].sub !== "Whiteboard · no chats yet") bad(`Refunds lists [${sectionsOf(v)}] ${J(v.rows)}`);
      await shot("refunds");
      await press(page, byTid(page, "nav-back").last());
      await onScreen("the back from Refunds", "g_payments", "Payments", "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat", "Checkout service");
      v = await seen();
      if (sectionsOf(v) !== "groups:1 boards:2 chats:1") bad(`Payments lists [${sectionsOf(v)}]`);
      if (rowOf(v, "group", "Refunds")?.sub !== "1 board") bad(`Refunds' row says ${J(rowOf(v, "group", "Refunds")?.sub)}`);
      if (rowOf(v, "board", "Payment providers")?.attention !== "dot") bad("Payment providers (a chat needs approval) has no dot");
      if (rowOf(v, "board", "Retry policy")?.sub !== "Whiteboard · 3 chats") bad(`Retry policy says ${J(rowOf(v, "board", "Retry policy")?.sub)}`);
      await shot("payments");
      await press(page, byTid(page, "nav-back").last());
      await onScreen("the back from Payments", "g_checkout", "Checkout service", "Studio Mac · 2 groups · 2 boards · 2 chats", "Home");
      v = await seen();
      if (sectionsOf(v) !== "groups:2 boards:2 chats:2") bad(`Checkout service lists [${sectionsOf(v)}]`);
      const pay = rowOf(v, "group", "Payments");
      if (pay?.sub !== "2 boards · 1 group · 1 chat" || pay.attention !== "count" || pay.count !== "1") bad(`the Payments row is ${J(pay)}`);
      if (rowOf(v, "board", "Checkout flow")?.attention !== "dot") bad("Checkout flow (a chat needs approval) has no dot");
      if (rowOf(v, "board", "Cart redesign")?.sub !== "Whiteboard · no chats yet") bad(`Cart redesign says ${J(rowOf(v, "board", "Cart redesign")?.sub)}`);
      await shot("checkout");
      await press(page, byTid(page, "nav-back").last());
      await wait("the back from Checkout service did not land on Home", async () => (await seen()).state === "list" && (await seen()).server === STUDIO);
      if (await backOf(page)) bad("Home has a back control");

      // down again by the rows
      await press(page, byTid(page, "home-row", { kind: "group", key: at("g_checkout") }));
      await onScreen("Checkout service by its row", "g_checkout", "Checkout service", "Studio Mac · 2 groups · 2 boards · 2 chats", "Home");
      await press(page, byTid(page, "home-row", { kind: "group", key: at("g_payments") }).last());
      await onScreen("Payments by its row", "g_payments", "Payments", "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat", "Checkout service");
      await press(page, byTid(page, "home-row", { kind: "group", key: at("g_refunds") }).last());
      await onScreen("Refunds by its row", "g_refunds", "Refunds", "Studio Mac › Checkout service › Payments · 1 board", "Payments");
      await press(page, byTid(page, "nav-back").last());
      await onScreen("the back to Payments", "g_payments", "Payments", "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat", "Checkout service");
    });

    // ---- what the rows draw
    await scenario("kinds", theme, async ({ seen, wait, shot, bad }) => {
      await wait("Home never shows its list", async () => (await seen()).state === "list");
      const v = await seen();
      if (sectionsOf(v) !== "groups:2 boards:2") bad(`the sections are [${sectionsOf(v)}], not [groups:2 boards:2]`);
      const prep = rowOf(v, "group", "Release prep");
      if (prep?.attention !== "count" || prep.count !== "2" || prep.sub !== "2 chats") bad(`Release prep is ${J(prep)}: a count of 2 (an approval, a stopped chat) and "2 chats"`);
      const scratch = rowOf(v, "group", "Scratch");
      if (scratch?.attention !== "none" || scratch.sub !== "Empty") bad(`Scratch is ${J(scratch)}: nothing in it, "Empty"`);
      const load = rowOf(v, "board", "Load test");
      if (load?.attention !== "none" || load.sub !== "Whiteboard · 1 chat") bad(`Load test (a chat at work) is ${J(load)}: no dot`);
      const dep = rowOf(v, "board", "Deploy plan");
      if (dep?.attention !== "dot" || dep.sub !== "Whiteboard · 1 chat") bad(`Deploy plan (a chat needs approval) is ${J(dep)}: a dot`);
      rowsPlain(v, bad, "Home");
      await shot();
    });

    // ---- an empty group
    await scenario("empty-group", theme, async ({ page, seen, wait, shown, count, shot, bad, ok }) => {
      await wait("the empty group's screen is not drawn", async () => (await seen()).key === key("h1_release", "g_scratch"));
      const v = await seen();
      if (v.title !== "Scratch" || v.sub !== "Release box") bad(`the title and line are ${J([v.title, v.sub])}, not ["Scratch", "Release box"]`);
      if (!await wait("no group-empty", () => shown("group-empty"))) return;
      const text = await byTid(page, "group-empty").first().innerText();
      if (!text.includes("Nothing here yet")) bad(`the empty group says ${J(text)}, not "Nothing here yet"`);
      if (!await shown("home-empty-new")) bad("the empty group has no + New (home-empty-new)");
      if (await ok(() => byTid(page, "group-screen").last().locator('[data-testid="home-list"]').count())) bad("an empty group draws a list"); // (Home's own list is drawn under the screen)
      await shot();
      await press(page, byTid(page, "home-empty-new").first());
      await wait("+ New in an empty group did not open the New sheet", () => shown("home-new-sheet"));
      if (await shown("home-new-sheet")) {
        // the new sheet (H2): the Where card with the place (this group), Chat, Whiteboard and Group; not H1's stop-gap rows
        const sheet = await byTid(page, "home-new-sheet").first().innerText();
        for (const w of ["Where", "Change", "Chat", "Whiteboard", "Group"]) if (!sheet.toLowerCase().includes(w.toLowerCase())) bad(`the New sheet has no "${w}": ${J(sheet)}`);
        for (const w of ["New chat", "New whiteboard", "New group"]) if (sheet.includes(w)) bad(`the New sheet still has the stop-gap row "${w}": ${J(sheet)}`);
        const made = await newSheetSeen(page);
        if (made?.page !== "what" || made.group === "" || J(made.tiles) !== J(["new-chat", "new-board", "new-group"])) bad(`the New sheet of the empty group is ${J(made)}, not the first page for that group with Chat, Whiteboard and Group`);
        await page.keyboard.press("Escape");
        if (!await ok(() => until(async () => !await count("home-new-sheet"), 5000))) bad("Esc did not close the New sheet");
        await press(page, byTid(page, "home-empty-new").first());
        await wait("+ New in an empty group did not open the New sheet again", () => shown("home-new-sheet"));
        const bb = await byTid(page, "overlay-backdrop").last().boundingBox();
        if (bb) await page.touchscreen.tap(bb.x + 5, bb.y + 5);
        if (!await ok(() => until(async () => !await count("home-new-sheet"), 5000))) bad("a press outside did not close the New sheet");
      }
    });

    // ---- the server is connecting
    await scenario("connecting", theme, async ({ page, seen, wait, shown, count, shot, bad, ok }) => {
      await wait("Home is not connecting", async () => (await seen()).state === "connecting");
      const v = await seen();
      if (v.server !== BUILD) bad(`Home shows ${J(v.server)}, not ${BUILD}`);
      if (await count("home-placeholder") !== 5) bad(`${await count("home-placeholder")} placeholder rows, not 5`);
      if (v.rows.length || v.list || await count("problem-card")) bad("a connecting server draws rows or a card");
      const sel = v.chips.find((c) => c.selected);
      if (sel?.server !== BUILD || sel.word !== "connecting") bad(`the selected chip is ${J(sel)}`);
      if (!await shown("home-new")) bad("+ New is not drawn");
      else if (!await ok(() => byTid(page, "home-new").first().isDisabled())) bad("+ New is not disabled while the server connects");
      await shot();
    });

    // ---- trouble: the card above the faded list
    await scenario("trouble", theme, async ({ page, seen, wait, shown, count, shot, bad, ok }) => {
      if (!await wait("Home never drew Attic's list before it was dropped", async () => { const x = await seen(); return x.server === ATTIC && x.state === "list"; })) return;
      await mockEval(states.find((x) => x.id === "trouble").mock, url);
      await wait("Home never came to trouble", async () => (await seen()).state === "trouble");
      const v = await seen();
      if (v.server !== ATTIC) bad(`Home shows ${J(v.server)}, not ${ATTIC}`);
      if (v.card?.word !== "unreachable" || v.card.server !== ATTIC) bad(`the card is ${J(v.card)}`);
      const text = v.card?.text ?? "";
      if (!text.includes("Can't reach Attic. Its boards and chats come back when it does.")) bad(`the card says ${J(text)}, not "Can't reach Attic. Its boards and chats come back when it does."`);
      if (!/^Attic Unreachable · since /.test(text)) bad(`the card's first line is not "Attic … Unreachable · since …": ${J(text)}`);
      for (const id of ["problem-retry", "problem-details"]) if (!await shown(id)) bad(`${id} is not drawn`);
      if (await count("problem-review")) bad("an unreachable server's card has Review");
      if (!v.list?.stale) bad(`the list is ${J(v.list)}, not faded (stale)`);
      if (sectionsOf(v) !== "groups:1 boards:1 chats:2") bad(`the faded list's sections are [${sectionsOf(v)}], not [groups:1 boards:1 chats:2]`);
      const opacity = await ok(() => byTid(page, "home-list").first().evaluate((e) => getComputedStyle(e).opacity));
      if (!(Number(opacity) < 0.6)) bad(`the faded list has opacity ${opacity}`);
      const chip = v.chips.find((c) => c.selected);
      if (chip?.server !== ATTIC || chip.word !== "unreachable") bad(`the selected chip is ${J(chip)}`);
      if (await ok(() => byTid(page, "home-new").first().isDisabled()) !== true) bad("+ New is enabled with the server down");
      await shot();
      // a press on a faded row says the server is offline and opens nothing
      await press(page, byTid(page, "home-row", { kind: "group" }).first());
      await wait("a press on a faded row shows no toast", () => shown("toast"));
      const toast = await ok(() => byTid(page, "toast").first().innerText());
      if (!String(toast).includes("Attic is offline")) bad(`the toast says ${J(toast)}, not "Attic is offline. …"`);
      await page.waitForTimeout(500);
      if (await count("group-screen")) bad("a press on a faded row opened a group screen");
      if ((await seen()).state !== "trouble") bad("Home left its trouble state after a press on a faded row");
    });

    // ---- a certificate that changed
    await scenario("cert", theme, async ({ seen, wait, shown, count, shot, bad }) => {
      await wait("Home never came to trouble", async () => (await seen()).state === "trouble");
      const v = await seen();
      if (v.server !== CERT || v.card?.word !== "cert-changed") bad(`Home shows ${J(v.server)} with the card ${J(v.card)}`);
      if (!(v.card?.text ?? "").includes("Garage Mac's certificate changed. Nothing is sent until you review it.")) bad(`the card says ${J(v.card?.text)}`);
      if (!await shown("problem-review")) bad("no Review");
      if (await count("problem-retry")) bad("a certificate that changed offers Try again");
      if (!await shown("problem-details")) bad("no Details");
      if (v.list || v.rows.length) bad(`a server that never had a tree draws a list: ${J(v.list)}`);
      const chip = v.chips.find((c) => c.selected);
      if (chip?.server !== CERT || chip.word !== "cert-changed") bad(`the selected chip is ${J(chip)}`);
      await shot();
    });

    // ---- a connected server with nothing on it
    await scenario("empty-server", theme, async ({ page, seen, wait, shown, count, shot, bad }) => {
      await wait("Home is not empty", async () => (await seen()).state === "empty");
      const v = await seen();
      if (v.sub !== "Empty box · Connected") bad(`the line under "Home" says ${J(v.sub)}`);
      for (const id of ["home-empty", "home-empty-chat", "home-empty-board", "home-empty-agents"]) if (!await shown(id)) bad(`${id} is not drawn`);
      if (await count("home-search")) bad("an empty Home draws the search field");
      if (await count("home-list")) bad("an empty Home draws a list");
      const agents = await byTid(page, "home-empty-agents").first().innerText().catch(() => "");
      if (!/ready on Empty box\.$/.test(agents) || !agents.includes("Claude Code")) bad(`the agents line says ${J(agents)}`);
      const text = await byTid(page, "home-empty").first().innerText().catch(() => "");
      for (const w of ["Start a chat or a whiteboard", "New chat", "New whiteboard", "A whiteboard is an Excalidraw board"]) if (!text.includes(w)) bad(`the empty Home does not say "${w}": ${J(text)}`);
      if (await count("home-new") && await byTid(page, "home-new").first().isDisabled()) bad("+ New is disabled on a connected server");
      await shot();
    });

    // ---- no server: the first run
    await scenario("none", theme, async ({ page, seen, wait, shown, count, shot, bad }) => {
      await wait("Home is not the first run", async () => (await seen()).state === "first-run");
      for (const id of ["first-run", "first-run-add", "first-run-scan", "first-run-guide", "home-gear"]) if (!await shown(id)) bad(`${id} is not drawn`);
      for (const id of ["home-new", "home-search", "large-title", "server-chips", "home-list"]) if (await count(id)) bad(`the first run draws ${id}`);
      const text = await byTid(page, "first-run").first().innerText().catch(() => "");
      for (const w of ["Connect to your computer", "Add a server", "Scan the server's code", "ON YOUR COMPUTER", "setup-remote.sh", "Allow Local Network", "How to set up a server"]) if (!text.includes(w)) bad(`the first run does not say "${w}": ${J(text)}`);
      await shot();
    });
  }
  note(`screenshots are in ${OUT}`);
}, { viewports, page: false });
