// Proves that a section's head is not a group's (plans/remote-server-sections-goal.md, 3.2 "Collapse" and "Not a
// group", 3.13): a click collapses and expands the section, and that is all the head does: a double click renames
// nothing, it has no menu, it cannot be dragged, and nothing dragged onto it is taken. Whether a section is collapsed,
// and each group in it, is kept in the browser (localStorage "aiwb.collapsed"), survives a reload, and is sent nowhere:
// no call under /api/on/ carries `collapsed`. A local group's collapse still goes to its server (PATCH
// /api/groups/<id>), and a local group and a section's group with the same id are collapsed apart. A collapsed
// section stays collapsed while its server is not connected and when it is back, and so does a group in it; a group
// that is new to the page shows open.
// The drops between the parts of the sidebar are SEC.5's.
import { callsOf, check, dragger, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", KEY = "aiwb.collapsed";

await check("SEC.3 a section's head collapses and does nothing else; collapse is the browser's own", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const { ctx, page, errors } = await openPage({ url, browser, size: [1280, 1500] });
  const calls = callsOf(page), d = await dragger(page);
  const head = (id) => page.locator(`.side-section[data-server="${id}"] > .side-section-head`);
  const groupHead = (id, name) => page.locator(`.side-section[data-server="${id}"] .side-group-head`, { has: page.locator(".side-group-name", { hasText: name }) });
  const localHead = (name) => page.locator(".side-tree > .side-group > .side-group-head", { has: page.locator(".side-group-name", { hasText: name }) });
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]"), KEY);
  const collapsedIs = async (name, id, want) => { if (!await until(async () => (await sideSeen(page, id)).collapsed === want, 10000)) fail(`${name}: the section of ${id} is ${want ? "not collapsed" : "collapsed"}`); };
  const headPoint = (id) => page.evaluate((id) => { const e = document.querySelector(`.side-section[data-server="${id}"] > .side-section-head`); e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 }; }, id);
  const writes = () => calls.filter((c) => c.method !== "GET");
  await page.waitForSelector(`.side-section[data-server="${STUDIO}"] .side-row`);
  const rows = (await sideSeen(page, STUDIO)).outline.length;

  // ---- a click collapses and expands
  await head(STUDIO).click();
  await collapsedIs("a click on the head", STUDIO, true);
  let s = await sideSeen(page, STUDIO);
  if (s.outline.length || await page.locator(`.side-section[data-server="${STUDIO}"] .side-section-body`).count()) fail(`a collapsed section still draws its body: ${J(s.outline)}`);
  if (!Number(s.count)) fail(`a collapsed section with a tree shows no count of what is in it: "${s.count}"`);
  if (s.state !== "Connected") fail(`a collapsed section does not say its state: "${s.state}"`);
  await head(STUDIO).click();
  await collapsedIs("a second click", STUDIO, false);
  if ((await sideSeen(page, STUDIO)).outline.length !== rows) fail("expanded again, the section does not show its tree");

  // ---- no rename, no menu, not draggable
  await head(STUDIO).locator(".side-section-name").dblclick();
  if (await page.locator(".side-section-head input, .side-section input.name-input").count()) fail("a double click on a section's head opened a rename box");
  await collapsedIs("a double click (two clicks)", STUDIO, false);
  for (const id of [STUDIO, "s_empty", "s_wait", "s_away", "s_old", "s_cert"]) {
    const v = await sideSeen(page, id);
    if (v.menu) fail(`the head of ${id} has a menu button`);
    if (v.draggable) fail(`the head of ${id} is draggable`);
  }
  await head(STUDIO).click({ button: "right" });
  if (await page.locator(".menu").count()) fail("a right click on a section's head opened a menu");
  if (await d.start(await headPoint(STUDIO))) { fail("a press and a move on a section's head started a drag"); await d.cancel(); }
  // (the press and the release that started no drag are a click: the section is collapsed by it, and opened again here)
  await collapsedIs("a press, a move and a release on the head", STUDIO, true);
  await head(STUDIO).click(); await collapsedIs("the next click", STUDIO, false);

  // ---- nothing dragged onto a head is taken: a local run on Studio Mac's, a chat of Studio Mac on Empty box's
  const before = writes().length;
  for (const [row, id] of [["New run", STUDIO], ["Take 14", "s_empty"], ["Take 14", STUDIO]]) {
    if (!await d.start(await d.row(row))) { fail(`the row "${row}" started no drag`); continue; }
    await d.over(await headPoint(id));
    const lit = await d.lit();
    if (lit.length) fail(`"${row}" over the head of ${id} lights ${J(lit)}`);
    await d.drop();
  }
  if (writes().length !== before) fail(`a drop on a section's head made the calls ${J(writes().slice(before).map((c) => `${c.method} ${c.path}`))}`);
  if (await d.groupOf("Take 14") !== "Old takes") fail(`after the drops on the heads "Take 14" is in "${await d.groupOf("Take 14")}"`);

  // ---- collapse is kept in the browser and sent nowhere
  await head("s_empty").click(); await collapsedIs("Empty box", "s_empty", true);
  await head("s_away").click(); await collapsedIs("a server that is not connected", "s_away", true);
  await groupHead(STUDIO, "Old takes").click();
  if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes("group Old takes [collapsed]"), 10000)) fail(`a click on a group of the section did not collapse it: ${J((await sideSeen(page, STUDIO)).outline)}`);
  // the section's group with the id of a local group: each is collapsed apart
  await groupHead(STUDIO, "Renders").click();
  if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes("group Renders [collapsed]"), 10000)) fail("a click on the group Renders did not collapse it");
  if ((await sideSeen(page)).outline.includes("group Shop [collapsed]")) fail("collapsing Studio Mac's group g_shop collapsed this computer's group g_shop");
  let want = ["s_away", "s_empty", `${STUDIO}~g_old`, `${STUDIO}~g_shop`];
  if (!await until(async () => J((await stored()).sort()) === J(want), 5000)) fail(`localStorage "${KEY}" is ${J(await stored())}, not ${J(want)}`);
  const sent = () => writes().filter((c) => c.path.startsWith("/api/on/") && (c.body && typeof c.body === "object" && "collapsed" in c.body || /collapsed/.test(c.path)));
  if (sent().length || writes().some((c) => /\/groups\//.test(c.path))) fail(`collapsing a section and its groups made the calls ${J(writes().map((c) => `${c.method} ${c.path} ${J(c.body)}`))}`);
  const there = await mockEval(`return [onCalls.filter((c) => c.body && typeof c.body === "object" && "collapsed" in c.body).length, onServer("${STUDIO}", () => groups.map((g) => [g.id, !!g.collapsed]))];`, url);
  if (there[0] || J(there[1]) !== J([["g_shop", true], ["g_sub", false], ["g_old", false]])) fail(`the mock was told of a collapse under /api/on/, or Studio Mac's own collapse changed: ${J(there)}`);

  // a local group's collapse goes to its server, and is not in the browser's list
  await localHead("Shop").click();
  if (!await until(() => writes().some((c) => c.method === "PATCH" && c.path === "/api/groups/g_shop" && c.body?.collapsed === true), 10000)) fail(`collapsing the local group Shop sent no PATCH /api/groups/g_shop {collapsed: true}: ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  if (J((await stored()).sort()) !== J(want)) fail(`collapsing a local group changed localStorage "${KEY}": ${J(await stored())}`);
  await groupHead(STUDIO, "Renders").click(); // open again: the local one stays collapsed
  if (!await until(async () => !(await sideSeen(page, STUDIO)).outline.includes("group Renders [collapsed]"), 10000)) fail("the group Renders did not open again");
  if (!(await sideSeen(page)).outline.includes("group Shop [collapsed]")) fail("opening Studio Mac's group g_shop opened this computer's group g_shop");
  want = want.filter((k) => k !== `${STUDIO}~g_shop`);

  // ---- it survives a reload
  await page.reload(); await page.waitForSelector(".side-tree .side-section");
  await collapsedIs("after a reload, Empty box", "s_empty", true);
  await collapsedIs("after a reload, the server that is not connected", "s_away", true);
  await collapsedIs("after a reload, Studio Mac", STUDIO, false);
  if (!await until(async () => { const o = (await sideSeen(page, STUDIO)).outline; return o.includes("group Old takes [collapsed]") && o.includes("group Renders"); }, 10000)) fail(`after a reload the groups of the section are not as they were left: ${J((await sideSeen(page, STUDIO)).outline)}`);
  if (J((await stored()).sort()) !== J(want)) fail(`after a reload localStorage "${KEY}" is ${J(await stored())}, not ${J(want)}`);

  // ---- a collapsed section stays collapsed through an outage, and so does a group in it; a new group shows open
  await head(STUDIO).click(); await collapsedIs("Studio Mac, collapsed", STUDIO, true);
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  if (!await until(async () => (await sideSeen(page, STUDIO)).state === "Unreachable", 10000)) fail("the collapsed section does not say that its server dropped");
  await collapsedIs("Studio Mac, not connected", STUDIO, true);
  if ((await sideSeen(page, STUDIO)).lines.length) fail("a collapsed section of a server that is not connected draws its line");
  await collapsedIs("the other server that is not connected", "s_away", true);
  await mockEval(`await elsewhere("${STUDIO}", "POST", "/groups", { name: "Made meanwhile" }); setServerState("${STUDIO}", "connected");`, url);
  if (!await until(async () => (await sideSeen(page, STUDIO)).state === "Connected", 10000)) fail("the collapsed section does not say that its server is back");
  await collapsedIs("Studio Mac, back", STUDIO, true);
  if (!Number((await sideSeen(page, STUDIO)).count)) fail("back and collapsed, the section shows no count");
  await head(STUDIO).click(); await collapsedIs("Studio Mac, opened", STUDIO, false);
  const o = (await sideSeen(page, STUDIO)).outline;
  if (!o.includes("group Old takes [collapsed]")) fail(`a group that was collapsed is open after its server was away: ${J(o)}`);
  if (!o.includes("group Made meanwhile") || !o.includes("group Renders")) fail(`a group that is new to the page does not show open: ${J(o)}`);
  if (sent().length) fail(`a call under /api/on/ carried collapsed: ${J(sent())}`);
  if (await mockEval(`return onCalls.filter((c) => c.body && typeof c.body === "object" && "collapsed" in c.body).length;`, url)) fail("the mock was told of a collapse under /api/on/");

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`the head collapses and expands, renames nothing, has no menu, starts no drag and takes no drop; ${want.length + 1} collapses kept in localStorage, over a reload and an outage, none sent under /api/on/; the local group's sent to /api/groups/g_shop`);
});
