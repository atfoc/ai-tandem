// Proves the parts of the sidebar (plans/remote-server-sections-goal.md, 3.1, and app-as-client-goal.md, 4.2): the
// sidebar is sections only, the first is this computer's and is there with no other server in the list; with servers it
// has one more per entry, in the order of the list, inside the tree that scrolls; this computer's section holds no row of
// another, and is what it was without servers; a row of a section names no server; the foot and its Servers button are
// what they are with no server, and Servers lists every entry; "Show archived" is one switch for every section.
// What a section says in each state is SEC.2's, what its head does SEC.3's.
// Ports dev/checks/SEC.1-sidebar.mjs (S1) to the new build, at the three viewports (A-SB-01, A-SB-02, A-SB-06 to A-SB-08, A-SB-14, A-SB-43,
// A-SC-01, A-SC-02; the phone's first screen is the sidebar, so it is the same list). Deviations: the foot's controls are read by their testIDs
// (side-archived, servers-btn, library-btn, theme-btn), the parts "from before this computer was a section" by the words they had
// ("Reconnecting…", "New group" outside a menu), and what the Servers button opens is S3's dialog (`servers-dialog`, which lists every entry; Esc
// closes it).
// The phone (package H1) has no sidebar: Home shows one server at a time, chosen by its chip, and the foot is behind Home's gear (Settings' rows)
// (plans/ux-improvements/h1-design.md §2, §6). Its half (`onPhone` below) proves the same of Home: this computer's alone with no chips and no
// other server; with servers one chip per entry in the list's order, this computer's Home what it was and holding no row of another, a row
// naming no server, one Servers behind the gear that lists every entry, the chips following the list; the phone has no "Show archived": Home
// lists nothing archived, and Settings › Archived (H2's own screen, `archived-screen`) lists each server's archived chats under its heading.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openFoot, press, showHome } from "./sel.mjs";
import { archivedSeen } from "./rows.mjs";
import { openServersScreen } from "./srv.mjs";
import { footOf, homeOf, sectionsSeen, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;

await check("SEC.1 the sidebar: sections only, this computer's first, then one per server of the list, and one foot", async ({ url, open, fail, note, layout }) => {
  if (layout === "phone") return onPhone({ url, open, fail, note });
  // ---- no other server: this computer's section alone
  await mockEval('chats.c_old_experiment = chat("c_old_experiment", { name: "Old experiment", group: UNGROUPED, archived: true, archiveOp: "op_arch1" }); items.c_old_experiment = [];', url);
  const bare = await open({ wait: '[data-testid="side-tree"]' });
  const bp = bare.page;
  await byTid(bp, "side-section").first().waitFor({ state: "attached" });
  if (J(await sectionsSeen(bp)) !== J(["local"])) fail(`with no other server the sidebar has the sections ${J(await sectionsSeen(bp))}, not this computer's alone`);
  const parts = (page) => page.evaluate(() => { const c = document.querySelector('[data-testid="side-tree"]').firstElementChild; return [...c.children].map((e) => (e.matches('[data-testid="side-section"]') ? "section" : "other")); });
  if ((await parts(bp)).includes("other")) fail("with no other server the tree has a part that is no section");
  const side = (await byTid(bp, "side").first().innerText()).replace(/\s+/g, " ");
  if (/Reconnecting…|Update available|\bNew group\b/.test(side)) fail(`the sidebar has a part from before this computer was a section (New group, Reconnecting…, the update banner): "${side.slice(0, 200)}"`);
  const localBefore = await sideSeen(bp, "local"), footBefore = await footOf(bp);
  if (!await until(async () => (await sideSeen(bp, "local")).outline.length, 10000)) fail("this computer's section of the unseeded mock has no row");
  const lb = await sideSeen(bp, "local");
  if (lb.name !== "This computer" || lb.state !== "Connected" || lb.tone !== "ok" || !lb.add || lb.menu || lb.draggable) fail(`this computer's head: ${J({ name: lb.name, state: lb.state, tone: lb.tone, add: lb.add, menu: lb.menu, draggable: lb.draggable })}`);
  const outlineBefore = lb.outline;
  void localBefore;
  await bare.ctx.close();

  // ---- with servers
  await seed(url, "SEC");
  const list = await mockEval("return extra.servers.filter((x) => !x.local).map((x) => ({ id: x.id, name: x.name }));", url);
  const { page, ctx } = await open({ wait: '[data-testid="side-tree"]' });
  const ids = list.map((x) => x.id), want = ["local", ...ids];
  if (!await until(async () => (await sectionsSeen(page)).length === want.length, 10000)) fail(`the sidebar has the sections ${J(await sectionsSeen(page))} for the list ${J(want)}`);
  if (J(await sectionsSeen(page)) !== J(want)) fail(`the sections are in the order ${J(await sectionsSeen(page))}, this computer's and then the list's in ${J(want)}`);
  for (const v of list) { const s = await sideSeen(page, v.id); if (s.name !== v.name) fail(`the section of ${v.id} is named "${s.name}", the list's entry "${v.name}"`); }

  // sections only, inside the tree, which scrolls; the foot outside it
  const place = await page.evaluate(() => {
    const tree = document.querySelector('[data-testid="side-tree"]'), content = tree.firstElementChild, kids = [...content.children];
    return { order: kids.map((e) => (e.matches('[data-testid="side-section"]') ? "section" : "other")).join(","),
      sectionsInTree: document.querySelectorAll('[data-testid="side-section"]').length === content.querySelectorAll(':scope > [data-testid="side-section"]').length,
      scrolls: tree.scrollHeight > tree.clientHeight && /auto|scroll/.test(getComputedStyle(tree).overflowY),
      firstHasNoLine: getComputedStyle(kids[0]).borderTopWidth === "0px" };
  });
  if (place.order !== Array(want.length).fill("section").join(",")) fail(`the tree's parts are "${place.order}", not ${want.length} sections`);
  if (!place.firstHasNoLine) fail("the first section, this computer's, has a line above it");
  if (!place.sectionsInTree) fail("a section is drawn outside the tree that scrolls");
  if (!place.scrolls) fail(`the tree with the sections in it does not scroll: ${J(place)}`);
  const moved = await page.evaluate(() => {
    const tree = document.querySelector('[data-testid="side-tree"]'), head = document.querySelector('[data-testid="side-section-head"]'), foot = document.querySelector('[data-testid="side-foot"]');
    const before = [head.getBoundingClientRect().top, foot.getBoundingClientRect().top];
    tree.scrollTop = tree.scrollHeight;
    return { by: tree.scrollTop, head: before[0] - head.getBoundingClientRect().top, foot: before[1] - foot.getBoundingClientRect().top,
      lastSeen: (() => { const r = [...document.querySelectorAll('[data-testid="side-section"]')].at(-1).getBoundingClientRect(), t = tree.getBoundingClientRect(); return r.bottom <= t.bottom + 1 && r.bottom > t.top; })() };
  });
  if (moved.by <= 0 || Math.abs(moved.head - moved.by) > 1 || moved.foot !== 0) fail(`scrolled by ${moved.by} px, the first section's head moved by ${moved.head} and the foot by ${moved.foot}`);
  if (!moved.lastSeen) fail("scrolled to its end, the tree does not show the last section");
  await page.evaluate(() => { document.querySelector('[data-testid="side-tree"]').scrollTop = 0; });

  // this computer's section is what it was without servers, and holds no row of another
  const local = await sideSeen(page, "local"), studio = await sideSeen(page, "s_studio");
  if (J(local.outline) !== J(outlineBefore)) fail(`this computer's section changed with the servers: ${J(local.outline.filter((x) => !outlineBefore.includes(x)))} are new, ${J(outlineBefore.filter((x) => !local.outline.includes(x)))} are gone`);
  const both = studio.rows.filter((n) => local.rows.includes(n));
  if (!studio.rows.length || both.length) fail(`this computer's section has rows of Studio Mac's section: ${J(both)} (the section has ${studio.rows.length} rows)`);
  // (the seeded pair: the chat c_plain of this computer and the chat c_plain of Studio Mac, each in its own section, once)
  if (local.rows.filter((n) => n === "Why is the build slow").length !== 1 || studio.rows.filter((n) => n === "Render queue is stuck").length !== 1) fail(`the two chats with the id c_plain are not one row each in their own part: ${J([local.rows.filter((n) => /build slow/.test(n)), studio.rows.filter((n) => /Render queue/.test(n))])}`);

  // a row of a section names no server
  const names = list.map((x) => x.name);
  for (const v of list) {
    const s = await sideSeen(page, v.id), said = [...s.subs, ...s.titles, ...s.rows].filter((t) => names.some((n) => t.includes(n)));
    if (said.length) fail(`a row of the section of ${v.name} names a server: ${J(said)}`);
  }
  if (await page.locator('[data-testid="side-section"] [data-testid="side-row"] [data-testid*="server"]').count()) fail("a row of a section has an element for a server's name");

  // the foot is what it is with no server, and Servers lists every entry
  const foot = await footOf(page);
  if (J(foot.controls) !== J(footBefore.controls) || J(foot.box) !== J(footBefore.box) || foot.inTree) fail(`the foot changed with the servers: ${J(foot)}, without them ${J(footBefore)}`);
  if (await byTid(page, "servers-btn").count() !== 1 || await byTid(page, "side-foot").locator('[data-testid="servers-btn"]').count() !== 1 || await page.locator('[data-testid="side-section"] [data-testid="servers-btn"]').count()
    || await page.locator('[data-testid="side-section-head"] [data-testid="side-more"]').count()) fail("Servers is not the one button of the foot, or a section's head has a button of its own besides its +");
  await press(page, byTid(page, "servers-btn").first());
  const dialog = byTid(page, "servers-dialog");
  if (!await until(() => dialog.isVisible(), 10000)) fail("the foot's Servers button opened no dialog");
  const listed = await dialog.textContent();
  for (const n of names) if (!listed.includes(n)) fail(`the Servers dialog does not list ${n}`);
  await page.keyboard.press("Escape");
  if (!await until(async () => !await dialog.count(), 10000)) fail("Esc did not close the Servers dialog");

  // the order of the list is the order of the sections after this computer's, also when the list changes
  await mockEval('extra.servers = [extra.servers[0], ...extra.servers.slice(1).reverse()]; resync();', url);
  const turned = ["local", ...ids.slice().reverse()];
  if (!await until(async () => J(await sectionsSeen(page)) === J(turned), 10000)) fail(`the list turned round, the sections are ${J(await sectionsSeen(page))}, not ${J(turned)}`);

  // "Show archived": one switch, for every section
  const switches = page.locator('[data-testid="side"] [role="switch"]');
  if (await switches.count() !== 1 || await page.locator('[data-testid="side-section"] [role="switch"]').count()) fail(`the sidebar has ${await switches.count()} switches, ${await page.locator('[data-testid="side-section"] [role="switch"]').count()} of them in a section`);
  const archived = async () => [(await sideSeen(page, "local")).outline.some((x) => x.includes("Old experiment")), (await sideSeen(page, "s_studio")).outline.some((x) => x.includes("Put away there"))];
  if (J(await archived()) !== J([false, false])) fail(`with the switch off an archived row shows: local ${(await archived())[0]}, Studio Mac ${(await archived())[1]}`);
  await press(page, switches.first());
  if (!await until(async () => J(await archived()) === J([true, true]), 10000)) fail(`the switch on, the archived rows show: local ${(await archived())[0]}, Studio Mac ${(await archived())[1]}`);
  if (await switches.first().getAttribute("aria-checked") !== "true") fail("the switch that is on does not say aria-checked");
  if (!(await sideSeen(page, "s_studio")).outline.includes("chat Put away there [archived]")) fail(`Studio Mac's archived chat is not marked archived: ${J((await sideSeen(page, "s_studio")).outline)}`);
  if (await page.evaluate(() => localStorage.getItem("aiwb.archived")) !== "1") fail('the choice is not saved ("aiwb.archived" = "1")');
  await press(page, switches.first());
  if (!await until(async () => J(await archived()) === J([false, false]), 10000)) fail("the switch off again, an archived row still shows");
  if (await page.evaluate(() => localStorage.getItem("aiwb.archived")) !== "0") fail('the choice off is not saved ("aiwb.archived" = "0")');

  await ctx.close();
  note(`this computer's section alone without servers; ${list.length} more in the list's order, scrolling with the tree; this computer's unchanged; no row names a server; one foot, one Servers, one switch`);
}, { viewports, page: false });

/** The phone's half: Home in the sidebar's place (see the head of the file). */
async function onPhone({ url, open, fail, note }) {
  const chipsOf = async (page) => (await homeOf(page)).chips.map((c) => c.server);
  // ---- no other server: this computer's Home alone, no chips
  await mockEval('chats.c_old_experiment = chat("c_old_experiment", { name: "Old experiment", group: UNGROUPED, archived: true, archiveOp: "op_arch1" }); items.c_old_experiment = [];', url);
  const bare = await open({ wait: '[data-testid="home"]' });
  const bp = bare.page;
  if (!await until(async () => (await homeOf(bp)).rows.length, 10000)) fail("this computer's Home of the unseeded mock has no row");
  const lb = await homeOf(bp);
  if (lb.server !== "local" || lb.chips.length || lb.name !== "This computer" || lb.word !== "connected" || !lb.newEnabled) fail(`with no other server Home is not this computer's alone: ${J({ server: lb.server, chips: lb.chips.length, name: lb.name, word: lb.word, new: lb.newEnabled })}`);
  if (await byTid(bp, "side-tree").count() || await byTid(bp, "side-section").count()) fail("the phone draws the sidebar's tree or a section");
  const outlineBefore = lb.outline;
  await bare.ctx.close();

  // ---- with servers: one chip per entry, in the list's order
  await seed(url, "SEC");
  const list = await mockEval("return extra.servers.filter((x) => !x.local).map((x) => ({ id: x.id, name: x.name }));", url);
  const { page, ctx } = await open({ wait: '[data-testid="home"]' });
  const ids = list.map((x) => x.id), want = ["local", ...ids];
  if (!await until(async () => J(await chipsOf(page)) === J(want), 10000)) fail(`Home has the chips ${J(await chipsOf(page))} for the list ${J(want)}`);
  for (const v of list) { const c = (await homeOf(page)).chips.find((x) => x.server === v.id); if (c?.name !== v.name) fail(`the chip of ${v.id} is named "${c?.name}", the list's entry "${v.name}"`); }

  // this computer's Home is what it was without servers, and holds no row of another; Studio Mac's holds none of this computer's
  await showHome(page, "local");
  if (!await until(async () => J((await homeOf(page)).outline) === J(outlineBefore), 10000)) fail(`this computer's Home changed with the servers: ${J((await homeOf(page)).outline)}, before ${J(outlineBefore)}`);
  const local = await homeOf(page);
  if (local.rows.some((r) => r.server !== "local")) fail(`this computer's Home has rows of another server: ${J(local.rows.filter((r) => r.server !== "local"))}`);
  await showHome(page, "s_studio");
  if (!await until(async () => (await homeOf(page)).rows.length, 10000)) fail("Studio Mac's Home has no row");
  const studio = await homeOf(page);
  if (studio.rows.some((r) => r.server !== "s_studio")) fail(`Studio Mac's Home has rows of another server: ${J(studio.rows.filter((r) => r.server !== "s_studio"))}`);
  // (the seeded pair: the chat c_plain of this computer, in its group Shop, and the chat c_plain of Studio Mac, on its Home: each once, in its own)
  if (studio.rows.filter((r) => r.name === "Render queue is stuck").length !== 1 || studio.rows.some((r) => r.name === "Why is the build slow")) fail(`the two chats with the id c_plain are not one row each in their own Home: ${J(studio.outline)}`);

  // a row names no server
  const names = list.map((x) => x.name);
  const said = studio.rows.flatMap((r) => [r.name, r.sub]).filter((t) => names.some((n) => t.includes(n)));
  if (said.length) fail(`a row of Studio Mac's Home names a server: ${J(said)}`);

  // one Servers, behind Home's gear (Settings' Servers row: S2's list, a screen pushed on the stack), and it lists every entry
  await openServersScreen(page);
  const listScreen = byTid(page, "srv-list").last();
  const listed = await listScreen.textContent();
  for (const n of names) if (!listed.includes(n)) fail(`the Servers list does not list ${n}`);
  if (await byTid(page, "servers-dialog").count()) fail("Settings' Servers opened the old dialog");
  await showHome(page);
  if (!await until(async () => !await byTid(page, "srv-list").count(), 10000)) fail("back did not leave the Servers list");

  // the order of the list is the order of the chips after this computer's, also when the list changes
  await mockEval('extra.servers = [extra.servers[0], ...extra.servers.slice(1).reverse()]; resync();', url);
  const turned = ["local", ...ids.slice().reverse()];
  if (!await until(async () => J(await chipsOf(page)) === J(turned), 10000)) fail(`the list turned round, the chips are ${J(await chipsOf(page))}, not ${J(turned)}`);

  // archived things are not on Home (no "Show archived" on the phone) and are listed in Settings › Archived, each under its own server (H2-7)
  for (const id of ["local", "s_studio"]) {
    await showHome(page, id);
    await page.waitForTimeout(300);
    const o = (await homeOf(page)).outline;
    if (o.some((x) => /Old experiment|Put away there/.test(x))) fail(`${id}'s Home lists an archived thing: ${J(o)}`);
  }
  await showHome(page);
  const screen = await openFoot(page, "side-archived"); // (Settings › the Archived row: the screen itself)
  if (!await byTid(page, "archived-screen").last().isVisible()) fail("Settings' Archived row did not push the Archived screen");
  if (await screen.locator('[role="switch"]').count()) fail(`Settings' Archived has ${await screen.locator('[role="switch"]').count()} switches: the phone has no "Show archived"`);
  const seen = await until(async () => { const r = (await archivedSeen(page)).rows; return r.length >= 2 && r; }, 10000);
  const rows = seen || (await archivedSeen(page)).rows;
  const where = (name) => rows.find((r) => r.name === name);
  if (where("Old experiment")?.server !== "local" || where("Put away there")?.server !== "s_studio") fail(`Archived does not list each archived chat under its server: ${J(rows.map((r) => [r.name, r.server]))}`);
  if (rows.some((r) => !r.archived)) fail(`Archived has a row that is not marked archived: ${J(rows)}`);
  for (const id of ["local", "s_studio"]) if (!(await archivedSeen(page)).servers.some((x) => x.server === id)) fail(`Archived has no heading for ${id}: ${J((await archivedSeen(page)).servers)}`);

  await ctx.close();
  note(`this computer's Home alone without servers; ${list.length} more chips in the list's order; this computer's Home unchanged; no row names a server; one Servers behind the gear; Home lists nothing archived, Settings › Archived lists it under each server`);
}
