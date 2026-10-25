// Proves that a section's head is not a group's (plans/remote-server-sections-goal.md, 3.2 "Collapse" and "Not a
// group", 3.13): a click collapses and expands the section, and that is all the head does: a double click renames
// nothing, it has no menu, it cannot be dragged, and nothing dragged onto it is taken. Whether a section is collapsed,
// and each group in it, is kept in the app (the kv key "aiwb.collapsed"), survives a reload, and is sent nowhere:
// no call to any server carries `collapsed`, this computer's included (its groups are the page's own to collapse, as a
// section's are). A local group and a section's group with the same id are collapsed apart. A collapsed
// section stays collapsed while its server is not connected and when it is back, and so does a group in it; a group
// that is new to the page shows open.
// The drops between the parts of the sidebar are SEC.5's.
// Ports dev/checks/SEC.3-notagroup.mjs (S1) to the new build, at the three viewports (A-SB-37, A-SC-04, A-SC-05, A-DD-05's head half, A-SG-03,
// A-SG-04). Deviations: a double click is two taps on a touch viewport, and a right click is made on the desktop only; the part that
// drags a row onto a head and looks at what lights is the drag's (S2): a press and a move on a head starts no drag, and a row
// dropped on a head lights nothing and makes no call, with the drag of the viewport (a mouse presses and moves, a finger is held first).
// The phone (package H1) has no section heads and no collapse: a server is a chip of Home and a group a screen pushed over it
// (plans/ux-improvements/h1-design.md §2, §3). Its half (`onPhone` below) proves that a chip is not a group either: a press shows that
// server's Home and nothing else, two presses rename nothing, a long press opens the server's sheet (no menu of a group); a group is pushed as
// its screen (the one that server's own page shows collapsed too), a section's group with a local group's id is its own screen; nothing of
// this is sent to any server or kept under "aiwb.collapsed"; a finger held and moved on a row or a chip drags nothing (no drag on Home until
// a package adds one); through an outage and a reload the server's Home comes back with its groups and a group made meanwhile.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, hold, mouseDrag, press, showHome, touchDrag, touchNow } from "./sel.mjs";
import { dragReader } from "./drag.mjs";
import { groupHead, homeOf, section, sectionHead, sectionToggle, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", KEY = "aiwb.collapsed";

await check("SEC.3 a section's head collapses and does nothing else; collapse is the browser's own", async ({ url, open, fail, note, layout }) => {
  if (layout === "phone") return onPhone({ url, open, fail, note });
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const touch = await touchNow(page);
  const calls = callsOf(page);
  const head = (id) => sectionToggle(page, id);
  const gHead = (id, name) => groupHead(page, name, section(page, id));
  const localHead = (name) => byTid(section(page, "local"), "side-group-head", { depth: 0 }).filter({ has: page.locator(`[data-testid="side-group-name"]:text-is(${J(name)})`) }).first();
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]"), KEY);
  const collapsedIs = async (name, id, want) => { if (!await until(async () => (await sideSeen(page, id)).collapsed === want, 10000)) fail(`${name}: the section of ${id} is ${want ? "not collapsed" : "collapsed"}`); };
  const writes = () => calls.filter((c) => c.method !== "GET");
  await byTid(section(page, STUDIO), "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  const rows = (await sideSeen(page, STUDIO)).outline.length;

  // ---- a click collapses and expands
  await press(page, head(STUDIO));
  await collapsedIs("a click on the head", STUDIO, true);
  let s = await sideSeen(page, STUDIO);
  if (s.outline.length || await byTid(section(page, STUDIO), "side-section-body").count()) fail(`a collapsed section still draws its body: ${J(s.outline)}`);
  if (!Number(s.count)) fail(`a collapsed section with a tree shows no count of what is in it: "${s.count}"`);
  if (s.state !== "Connected") fail(`a collapsed section does not say its state: "${s.state}"`);
  await press(page, head(STUDIO));
  await collapsedIs("a second click", STUDIO, false);
  if ((await sideSeen(page, STUDIO)).outline.length !== rows) fail("expanded again, the section does not show its tree");

  // ---- no rename, no menu, not draggable
  const name = byTid(section(page, STUDIO), "side-section-name").first();
  if (touch) { await name.tap(); await name.tap(); } else await name.dblclick();
  if (await page.locator('[data-testid="side-section-head"] [data-testid="name-input"], [data-testid="side-section"] [data-testid="name-input"]').count()) fail("a double click on a section's head opened a rename box");
  await collapsedIs("a double click (two clicks)", STUDIO, false);
  for (const id of [STUDIO, "s_empty", "s_wait", "s_away", "s_old", "s_cert"]) {
    const v = await sideSeen(page, id);
    if (v.menu) fail(`the head of ${id} has a menu button`);
    if (v.draggable) fail(`the head of ${id} is draggable`);
  }
  if (!touch) {
    await head(STUDIO).click({ button: "right" });
    if (await byTid(page, "menu").count()) fail("a right click on a section's head opened a menu");
    // a press and a move that is no drag, and the release: a click, which collapses the section (and opens it again here)
    const b = await head(STUDIO).boundingBox();
    await mouseDrag(page, { x: b.x + 40, y: b.y + b.height / 2 }, { x: b.x + 54, y: b.y + b.height / 2 + 6 }, { steps: 4 });
    await collapsedIs("a press, a move and a release on the head", STUDIO, true);
    await press(page, head(STUDIO)); await collapsedIs("the next click", STUDIO, false);
  }
  const d = await dragReader(page);
  const headPoint = (id) => d.at(sectionHead(page, id));
  // a press and a move on a head start no drag (and the release is a click, which collapses the section: opened again here)
  if (await d.start(await headPoint(STUDIO), { none: true })) { fail("a press and a move on a section's head started a drag"); await d.cancel(); }
  // (a mouse's press and release on the head are a click; a finger held there and lifted may or may not be a tap, so it is looked at and put back)
  if (!touch) await collapsedIs("a press, a move and a release on the head", STUDIO, true);
  if (await until(async () => (await sideSeen(page, STUDIO)).collapsed, touch ? 2000 : 100)) { await press(page, head(STUDIO)); await collapsedIs("the next click", STUDIO, false); }
  // ---- nothing dragged onto a head is taken: a local chat on Studio Mac's, a chat of Studio Mac on Empty box's
  const before = writes().length;
  for (const [row, id] of [["Why is the build slow", STUDIO], ["Take 14", "s_empty"], ["Take 14", STUDIO]]) {
    if (!await d.start(await d.row(row))) { fail(`the row "${row}" started no drag`); continue; }
    await d.over(await headPoint(id));
    const lit = await d.lit();
    if (lit.length) fail(`"${row}" over the head of ${id} lights ${J(lit)}`);
    await d.drop();
  }
  if (writes().length !== before) fail(`a drop on a section's head made the calls ${J(writes().slice(before).map((c) => `${c.method} ${c.path}`))}`);
  if (await d.groupOf("Take 14") !== "Old takes") fail(`after the drops on the heads "Take 14" is in "${await d.groupOf("Take 14")}"`);

  // ---- collapse is kept in the app and sent nowhere
  await press(page, head("s_empty")); await collapsedIs("Empty box", "s_empty", true);
  await press(page, head("s_away")); await collapsedIs("a server that is not connected", "s_away", true);
  await press(page, gHead(STUDIO, "Old takes"));
  if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes("group Old takes [collapsed]"), 10000)) fail(`a click on a group of the section did not collapse it: ${J((await sideSeen(page, STUDIO)).outline)}`);
  // the section's group with the id of a local group: each is collapsed apart
  await press(page, gHead(STUDIO, "Renders"));
  if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes("group Renders [collapsed]"), 10000)) fail("a click on the group Renders did not collapse it");
  if ((await sideSeen(page, "local")).outline.includes("group Shop [collapsed]")) fail("collapsing Studio Mac's group g_shop collapsed this computer's group g_shop");
  let want = ["s_away", "s_empty", `${STUDIO}~g_old`, `${STUDIO}~g_shop`];
  if (!await until(async () => J((await stored()).sort()) === J(want), 5000)) fail(`the kv key "${KEY}" is ${J(await stored())}, not ${J(want)}`);
  const sent = () => writes().filter((c) => c.server !== "local" && (c.body && typeof c.body === "object" && "collapsed" in c.body || /collapsed/.test(c.path)));
  if (sent().length || writes().some((c) => /\/groups\//.test(c.path))) fail(`collapsing a section and its groups made the calls ${J(writes().map((c) => `${c.method} ${c.path} ${J(c.body)}`))}`);
  const there = await mockEval(`return [onCalls.filter((c) => c.body && typeof c.body === "object" && "collapsed" in c.body).length, onServer("${STUDIO}", () => groups.map((g) => [g.id, !!g.collapsed]))];`, url);
  if (there[0] || J(there[1]) !== J([["g_shop", true], ["g_sub", false], ["g_old", false]])) fail(`the mock was told of a collapse for another server, or Studio Mac's own collapse changed: ${J(there)}`);

  // a local group's collapse is the browser's too, under its own key, and is sent nowhere
  await press(page, localHead("Shop"));
  want = [...want, "g_shop"].sort();
  if (!await until(async () => J((await stored()).sort()) === J(want), 5000)) fail(`collapsing a local group left the kv key "${KEY}" at ${J(await stored())}, not ${J(want)}`);
  if (!await until(async () => (await sideSeen(page, "local")).outline.includes("group Shop [collapsed]"), 5000)) fail("a click on this computer's group Shop did not collapse it");
  await page.waitForTimeout(300);
  if (writes().some((c) => /\/groups\//.test(c.path) || (c.body && typeof c.body === "object" && "collapsed" in c.body))) fail(`collapsing a local group made a call: ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  await press(page, gHead(STUDIO, "Renders")); // open again: the local one stays collapsed
  if (!await until(async () => !(await sideSeen(page, STUDIO)).outline.includes("group Renders [collapsed]"), 10000)) fail("the group Renders did not open again");
  if (!(await sideSeen(page, "local")).outline.includes("group Shop [collapsed]")) fail("opening Studio Mac's group g_shop opened this computer's group g_shop");
  want = want.filter((k) => k !== `${STUDIO}~g_shop`);
  if (!(await sideSeen(page, "local")).outline.includes("group Shop [collapsed]")) fail("this computer's group Shop is not collapsed any more");

  // ---- it survives a reload
  await page.reload(); await byTid(page, "side-section").first().waitFor({ state: "attached", timeout: 15000 });
  await collapsedIs("after a reload, Empty box", "s_empty", true);
  await collapsedIs("after a reload, the server that is not connected", "s_away", true);
  await collapsedIs("after a reload, Studio Mac", STUDIO, false);
  if (!await until(async () => { const o = (await sideSeen(page, STUDIO)).outline; return o.includes("group Old takes [collapsed]") && o.includes("group Renders"); }, 10000)) fail(`after a reload the groups of the section are not as they were left: ${J((await sideSeen(page, STUDIO)).outline)}`);
  if (J((await stored()).sort()) !== J(want)) fail(`after a reload the kv key "${KEY}" is ${J(await stored())}, not ${J(want)}`);
  if (!await until(async () => (await sideSeen(page, "local")).outline.includes("group Shop [collapsed]"), 10000)) fail("after a reload this computer's group Shop is not collapsed");

  // ---- a collapsed section stays collapsed through an outage, and so does a group in it; a new group shows open
  await press(page, head(STUDIO)); await collapsedIs("Studio Mac, collapsed", STUDIO, true);
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  if (!await until(async () => (await sideSeen(page, STUDIO)).state === "Unreachable", 10000)) fail("the collapsed section does not say that its server dropped");
  await collapsedIs("Studio Mac, not connected", STUDIO, true);
  if ((await sideSeen(page, STUDIO)).lines.length) fail("a collapsed section of a server that is not connected draws its line");
  await collapsedIs("the other server that is not connected", "s_away", true);
  await mockEval(`await elsewhere("${STUDIO}", "POST", "/groups", { name: "Made meanwhile" }); setServerState("${STUDIO}", "connected");`, url);
  if (!await until(async () => (await sideSeen(page, STUDIO)).state === "Connected", 10000)) fail("the collapsed section does not say that its server is back");
  await collapsedIs("Studio Mac, back", STUDIO, true);
  if (!Number((await sideSeen(page, STUDIO)).count)) fail("back and collapsed, the section shows no count");
  await press(page, head(STUDIO)); await collapsedIs("Studio Mac, opened", STUDIO, false);
  const o = (await sideSeen(page, STUDIO)).outline;
  if (!o.includes("group Old takes [collapsed]")) fail(`a group that was collapsed is open after its server was away: ${J(o)}`);
  if (!o.includes("group Made meanwhile") || !o.includes("group Renders")) fail(`a group that is new to the page does not show open: ${J(o)}`);
  if (sent().length) fail(`a call to another server carried collapsed: ${J(sent())}`);
  if (await mockEval(`return onCalls.filter((c) => c.body && typeof c.body === "object" && "collapsed" in c.body).length;`, url)) fail("the mock was told of a collapse");

  note(`the head collapses and expands, renames nothing and has no menu; ${want.length + 1} collapses kept in the kv key, over a reload and an outage, none sent to any server, this computer's group included`);
}, { viewports, page: false });

/** The phone's half: a chip and a group's row of Home (see the head of the file). */
async function onPhone({ url, open, fail, note }) {
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="home"]' });
  const calls = callsOf(page);
  const writes = () => calls.filter((c) => c.method !== "GET");
  const chip = (id) => byTid(page, "server-chip", { server: id }).first();
  const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
  await showHome(page, STUDIO);
  if (!await until(async () => (await homeOf(page)).rows.length, 15000)) fail("Studio Mac's Home has no row");
  const top = (await homeOf(page)).outline;

  // ---- a press on a chip shows that server's Home; a press on the selected one changes nothing; two presses rename nothing
  await press(page, chip("s_empty"));
  if (!await until(async () => (await homeOf(page)).server === "s_empty", 10000)) fail("a press on Empty box's chip did not show its Home");
  await press(page, chip(STUDIO));
  if (!await until(async () => J((await homeOf(page)).outline) === J(top), 10000)) fail("back on Studio Mac's chip, its Home is not what it was");
  await press(page, chip(STUDIO));
  await page.waitForTimeout(300);
  const again = await homeOf(page);
  if (again.server !== STUDIO || J(again.outline) !== J(top)) fail(`a press on the selected chip changed Home: ${J([again.server, again.outline])}`);
  await chip(STUDIO).tap(); await chip(STUDIO).tap();
  if (await byTid(page, "name-input").count()) fail("two presses on a chip opened a rename box");

  // ---- a long press opens the server's sheet, not a group's menu
  // (S2's server sheet, `srv-sheet`, replaced H1's stopgap `server-sheet-stopgap` that this check named)
  const sheet = byTid(page, "srv-sheet").last();
  await hold(page, chip(STUDIO), { until: sheet });
  if (!await until(() => sheet.isVisible(), 10000)) fail("a long press on a chip opened no server sheet");
  if (await byTid(page, "menu-item").filter({ hasText: /Rename|Delete|Move to/ }).count()) fail("a long press on a chip opened a group's menu (Rename, Delete or Move to)");
  await page.keyboard.press("Escape");
  await until(async () => !await sheet.isVisible(), 5000);

  // ---- a group is a screen: the one Studio Mac's own page shows collapsed opens like any other; the local g_shop is another screen
  if (!await mockEval('return onServer("s_studio", () => groups.find((g) => g.id === "g_shop").collapsed === true);', url)) fail("the seed's group Renders is not collapsed on Studio Mac itself: the check proves nothing of it");
  await press(page, byTid(page, "home-row", { kind: "group", key: `${STUDIO}~g_shop` }).first());
  if (!await until(async () => (await homeOf(page, `${STUDIO}~g_shop`)).rows.length === 3, 10000)) fail(`Studio Mac's group Renders (collapsed on its own page) is no screen with its rows: ${J((await homeOf(page, `${STUDIO}~g_shop`)).outline)}`);
  const theirs = (await homeOf(page, `${STUDIO}~g_shop`)).outline;
  await showHome(page, "local");
  await press(page, byTid(page, "home-row", { kind: "group", key: "g_shop" }).first());
  if (!await until(async () => (await homeOf(page, "g_shop")).rows.length > 0, 10000)) fail("this computer's group Shop is no screen with its rows");
  const ours = (await homeOf(page, "g_shop")).outline;
  if (J(ours) === J(theirs)) fail(`this computer's group g_shop and Studio Mac's show the same rows: ${J(ours)}`);
  await back(page);
  if (writes().length) fail(`pressing chips and groups made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  if (await stored() !== null && await stored() !== "[]") fail(`Home wrote "${KEY}": ${await stored()}`);

  // ---- a finger held and moved on a row or a chip drags nothing
  await showHome(page, STUDIO);
  const row = byTid(page, "home-row", { kind: "chat", key: `${STUDIO}~c_plain` }).first();
  await touchDrag(page, row, byTid(page, "home-row", { kind: "group", key: `${STUDIO}~g_old` }).first());
  await touchDrag(page, chip(STUDIO), chip("s_empty"));
  await page.waitForTimeout(500);
  if (writes().length) fail(`a drag on Home made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  if (await byTid(page, "drop-mark").count()) fail("a drag on Home drew a drop mark");

  // ---- through an outage and back, the groups are there with one made meanwhile; a reload shows the same server's Home
  await showHome(page, STUDIO);
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  if (!await until(async () => (await homeOf(page)).state === "trouble", 10000)) fail("Studio Mac's Home does not say that its server dropped");
  await mockEval(`await elsewhere("${STUDIO}", "POST", "/groups", { name: "Made meanwhile" }); setServerState("${STUDIO}", "connected");`, url);
  if (!await until(async () => { const o = (await homeOf(page)).outline; return o.includes("group Made meanwhile") && o.includes("group Renders") && o.includes("group Old takes"); }, 10000)) fail(`back, Studio Mac's Home does not list its groups and the one made meanwhile: ${J((await homeOf(page)).outline)}`);
  await page.reload(); await byTid(page, "home").first().waitFor({ state: "attached", timeout: 15000 });
  if (!await until(async () => (await homeOf(page)).server === STUDIO && (await homeOf(page)).outline.includes("group Made meanwhile"), 15000)) fail(`after a reload Home does not show Studio Mac, the server it showed (saved in "aiwb.home"), with its groups: ${J([(await homeOf(page)).server, (await homeOf(page)).outline, await page.evaluate(() => localStorage.getItem("aiwb.home"))])}`);
  if (writes().some((c) => c.server !== "local" && (c.body && typeof c.body === "object" && "collapsed" in c.body || /collapsed/.test(c.path)))) fail("a call to another server carried collapsed");
  if (await mockEval('return onCalls.filter((c) => c.body && typeof c.body === "object" && "collapsed" in c.body).length;', url)) fail("the mock was told of a collapse");

  note("a chip shows its server's Home and renames nothing, its long press opens the server's sheet; groups are screens (the local g_shop apart); no drag, no call, no collapse kept; back after an outage and a reload with its groups");
}
