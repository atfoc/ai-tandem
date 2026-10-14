// Proves the parts of the sidebar (plans/remote-server-sections-goal.md, 3.1, and app-as-client-goal.md, 4.2): the
// sidebar is sections only, the first is this computer's and is there with no other server in the list; with servers it
// has one more per entry, in the order of the list, inside the tree that scrolls; this computer's section holds no row of
// another, and is what it was without servers; a row of a section names no server; the foot and its Servers button are
// what they are with no server, and Servers lists every entry; "Show archived" is one switch for every section.
// What a section says in each state is SEC.2's, what its head does SEC.3's.
import { check, mockEval, openPage, sectionsSeen, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
/** In the page: the foot's controls, each by its tag, its classes and what it says (the Servers button without its
 *  title, which tells of an entry that is not connected), and the foot's box. */
const footOf = (page) => page.evaluate(() => {
  const foot = document.querySelector(".side .side-foot"), r = foot.getBoundingClientRect();
  return { controls: [...foot.querySelectorAll("button, input, label")].map((e) => `${e.tagName.toLowerCase()}.${e.className.replace(/\s+/g, ".")} ${e.matches(".servers-btn") ? "" : e.getAttribute("title") ?? ""} ${e.textContent.trim()}`),
    box: [r.left, r.width, r.height, innerHeight - r.bottom].map(Math.round), inTree: !!foot.closest(".side-tree") };
});

await check("SEC.1 the sidebar: sections only, this computer's first, then one per server of the list, and one foot", async ({ url, browser, fail, note }) => {
  // ---- no other server: this computer's section alone
  await mockEval('chats.c_old_experiment = chat("c_old_experiment", { name: "Old experiment", group: UNGROUPED, archived: true, archiveOp: "op_arch1" }); items.c_old_experiment = [];', url);
  const bare = await openPage({ url, browser });
  if (J(await sectionsSeen(bare.page)) !== J(["local"])) fail(`with no other server the sidebar has the sections ${J(await sectionsSeen(bare.page))}, not this computer's alone`);
  if (await bare.page.locator(".side-tree > :not(.side-section)").count()) fail("with no other server the tree has a part that is no section");
  if (await bare.page.locator(".side-addgroup, .offline, .side-update").count()) fail("the sidebar has a part from before this computer was a section (New group, Reconnecting…, the update banner)");
  const localBefore = await sideSeen(bare.page, "local"), footBefore = await footOf(bare.page);
  if (!localBefore.outline.length) fail("this computer's section of the unseeded mock has no row");
  if (localBefore.name !== "This computer" || localBefore.state !== "Connected" || localBefore.tone !== "ok" || !localBefore.add || localBefore.menu || localBefore.draggable) fail(`this computer's head: ${J({ name: localBefore.name, state: localBefore.state, tone: localBefore.tone, add: localBefore.add, menu: localBefore.menu, draggable: localBefore.draggable })}`);
  await bare.ctx.close();

  // ---- with servers
  await seed(url, "SEC");
  const list = await mockEval("return extra.servers.filter((x) => !x.local).map((x) => ({ id: x.id, name: x.name }));", url);
  const { ctx, page, errors } = await openPage({ url, browser });
  const ids = list.map((x) => x.id), want = ["local", ...ids];
  if (!await until(async () => (await sectionsSeen(page)).length === want.length, 10000)) fail(`the sidebar has the sections ${J(await sectionsSeen(page))} for the list ${J(want)}`);
  if (J(await sectionsSeen(page)) !== J(want)) fail(`the sections are in the order ${J(await sectionsSeen(page))}, this computer's and then the list's in ${J(want)}`);
  for (const v of list) { const s = await sideSeen(page, v.id); if (s.name !== v.name) fail(`the section of ${v.id} is named "${s.name}", the list's entry "${v.name}"`); }

  // sections only, inside the tree, which scrolls; the foot outside it
  const place = await page.evaluate(() => {
    const tree = document.querySelector(".side-tree"), kids = [...tree.children];
    return { order: kids.map((e) => (e.matches(".side-section") ? "section" : "other")).join(","), sectionsInTree: document.querySelectorAll(".side-section").length === tree.querySelectorAll(":scope > .side-section").length,
      scrolls: tree.scrollHeight > tree.clientHeight && /auto|scroll/.test(getComputedStyle(tree).overflowY),
      firstHasNoLine: getComputedStyle(kids[0]).borderTopWidth === "0px" };
  });
  if (place.order !== Array(want.length).fill("section").join(",")) fail(`the tree's parts are "${place.order}", not ${want.length} sections`);
  if (!place.firstHasNoLine) fail("the first section, this computer's, has a line above it");
  if (!place.sectionsInTree) fail("a section is drawn outside the tree that scrolls");
  if (!place.scrolls) fail(`the tree with the sections in it does not scroll: ${J(place)}`);
  const moved = await page.evaluate(() => {
    const tree = document.querySelector(".side-tree"), head = document.querySelector(".side-section .side-section-head"), foot = document.querySelector(".side-foot");
    const before = [head.getBoundingClientRect().top, foot.getBoundingClientRect().top];
    tree.scrollTop = tree.scrollHeight;
    return { by: tree.scrollTop, head: before[0] - head.getBoundingClientRect().top, foot: before[1] - foot.getBoundingClientRect().top,
      lastSeen: (() => { const r = [...document.querySelectorAll(".side-section")].at(-1).getBoundingClientRect(), t = tree.getBoundingClientRect(); return r.bottom <= t.bottom + 1 && r.bottom > t.top; })() };
  });
  if (moved.by <= 0 || Math.abs(moved.head - moved.by) > 1 || moved.foot !== 0) fail(`scrolled by ${moved.by} px, the first section's head moved by ${moved.head} and the foot by ${moved.foot}`);
  if (!moved.lastSeen) fail("scrolled to its end, the tree does not show the last section");
  await page.evaluate(() => { document.querySelector(".side-tree").scrollTop = 0; });

  // this computer's section is what it was without servers, and holds no row of another
  const local = await sideSeen(page, "local"), studio = await sideSeen(page, "s_studio");
  if (J(local.outline) !== J(localBefore.outline)) fail(`this computer's section changed with the servers: ${J(local.outline.filter((x) => !localBefore.outline.includes(x)))} are new, ${J(localBefore.outline.filter((x) => !local.outline.includes(x)))} are gone`);
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
  if (await page.locator(".side-section .side-row .chat-head-server, .side-section .side-row .server-chip, .side-section .side-row [class*=server]").count()) fail("a row of a section has an element for a server's name");

  // the foot is what it is with no server, and Servers lists every entry
  const foot = await footOf(page);
  if (J(foot.controls) !== J(footBefore.controls) || J(foot.box) !== J(footBefore.box) || foot.inTree) fail(`the foot changed with the servers: ${J(foot)}, without them ${J(footBefore)}`);
  if (await page.locator(".side-foot .servers-btn").count() !== 1 || await page.locator(".side-section .servers-btn, .side-section-head button:not([title^='New on'])").count()) fail("Servers is not the one button of the foot, or a section's head has a button of its own besides its +");
  await page.locator(".side-foot .servers-btn").click();
  const dialog = page.locator('.servers-dialog[role="dialog"]');
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
  const switches = page.locator(".side input.switch");
  if (await switches.count() !== 1 || await page.locator(".side-section input").count()) fail(`the sidebar has ${await switches.count()} switches, ${await page.locator(".side-section input").count()} of them in a section`);
  const archived = async () => [(await sideSeen(page, "local")).outline.some((x) => x.includes("Old experiment")), (await sideSeen(page, "s_studio")).outline.some((x) => x.includes("Put away there"))];
  if (J(await archived()) !== J([false, false])) fail(`with the switch off an archived row shows: local ${(await archived())[0]}, Studio Mac ${(await archived())[1]}`);
  await switches.click();
  if (!await until(async () => J(await archived()) === J([true, true]), 10000)) fail(`the switch on, the archived rows show: local ${(await archived())[0]}, Studio Mac ${(await archived())[1]}`);
  if (!(await sideSeen(page, "s_studio")).outline.includes("chat Put away there [archived]")) fail(`Studio Mac's archived chat is not marked archived: ${J((await sideSeen(page, "s_studio")).outline)}`);
  await switches.click();
  if (!await until(async () => J(await archived()) === J([false, false]), 10000)) fail("the switch off again, an archived row still shows");

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`this computer's section alone without servers; ${list.length} more in the list's order, scrolling with the tree; this computer's unchanged; no row names a server; one foot, one Servers, one switch`);
});
