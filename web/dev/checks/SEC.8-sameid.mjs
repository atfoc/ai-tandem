// Proves that two things with the same id, one of this computer and one of a section, are told apart everywhere
// (plans/remote-server-sections-goal.md, section 5 "An id is unique on one server only"): the seed's chat c_plain of
// this computer and chat c_plain of Studio Mac are two rows, each in its own part; they open as two chats with their
// own titles and threads; a message, a draft, a rename and a delete of one never touch the other, by the page's own
// actions and by events from elsewhere; and every call goes to /api/chats/c_plain for the one and to
// /api/on/<entry id>/chats/c_plain for the other. The selection that is saved names which of the two is open, and a
// reload opens that one.
// The group g_shop, the board b_arch and the run r_draft, which both machines have too, are SEC.3's, SEC.4's and SEC.5's.
import { callsOf, check, mockEval, openPage, seed, sideMenu, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", HERE = "/api/chats/c_plain", THERE = `/api/on/${STUDIO}/chats/c_plain`;
const LOCAL = { name: "Why is the build slow", asks: "Why is the build slow?", says: "Because of the font copy step." };
const FAR = { name: "Render queue is stuck", asks: "Why is the render queue stuck?", says: "Two jobs hold the GPU lock." };

await check("SEC.8 a chat of this computer and a chat of a section with the same id are two chats", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const sec = `.side-section[data-server="${STUDIO}"]`;
  const p = await openPage({ url, browser, size: [1280, 1500] }), { page } = p, calls = callsOf(page);
  const localRow = (name) => page.locator(`.side-tree > .side-group .side-row:has(.side-name:text-is("${name}"))`);
  const farRow = (name) => page.locator(`${sec} .side-row:has(.side-name:text-is("${name}"))`);
  const thread = () => page.locator(".thread .msg").allTextContents();
  const box = page.locator(".composer .composer-input");
  /** What the two machines hold of their chat c_plain: its name, its messages, its draft. */
  const held = () => mockEval(`const of = () => (chats.c_plain ? [chats.c_plain.name, items.c_plain.filter((x) => x.kind === "user").map((x) => x.text), chats.c_plain.draft?.text ?? ""] : null); return [of(), onServer("${STUDIO}", of)];`, url);
  /** The calls since `from` that are about a chat c_plain: those of this computer's, and those of Studio Mac's. */
  const split = (from) => { const mine = calls.slice(from).filter((c) => /\/chats\/c_plain(\/|\?|$)/.test(c.path)); return { here: mine.filter((c) => c.path.startsWith(HERE)), there: mine.filter((c) => c.path.startsWith(THERE)), other: mine.filter((c) => !c.path.startsWith(HERE) && !c.path.startsWith(THERE)) }; };
  /** (a call is heard of a moment after it was made: the calls of the right kind are waited for, the others read then) */
  const only = async (name, from, which) => { await until(() => split(from)[which].length, 5000); const s = split(from), wrong = which === "here" ? s.there : s.here; if (wrong.length || s.other.length || !s[which].length) fail(`${name}: the calls were ${J(calls.slice(from).filter((c) => /c_plain/.test(c.path)).map((c) => `${c.method} ${c.path}`))}, not all under ${which === "here" ? HERE : THERE}`); };
  /** The chat on screen is one of the two: its title, its server in the head or none, and its own thread. */
  const open = async (name, row, want, server) => {
    const from = calls.length;
    await row.click();
    if (!await until(async () => { const t = await thread(); return t.some((x) => x.includes(want.asks)) && t.some((x) => x.includes(want.says)); }, 10000)) fail(`${name}: the thread is ${J(await thread())}`);
    const other = server ? LOCAL : FAR;
    if ((await thread()).some((x) => x.includes(other.asks) || x.includes(other.says))) fail(`${name}: the thread has the other chat's messages: ${J(await thread())}`);
    const head = await page.locator(".chat-head").textContent();
    if (!head.includes(want.name) || head.includes(other.name)) fail(`${name}: the head says "${head}"`);
    if ((await page.locator(".chat-head .chat-head-server").count() ? await page.locator(".chat-head .chat-head-server").textContent() : "") !== server) fail(`${name}: the head names the server "${await page.locator(".chat-head .chat-head-server").textContent().catch(() => "")}", not "${server}"`);
    const sel = JSON.parse(await page.evaluate(() => localStorage.getItem("aiwb.sel")));
    if (sel.chat !== (server ? `${STUDIO}~c_plain` : "c_plain")) fail(`${name}: the saved selection is ${J(sel)}`);
    return from;
  };
  await page.waitForSelector(`${sec} .side-row`);

  // ---- two rows, each in its own part, and each opens as itself
  const local = await sideSeen(page), far = await sideSeen(page, STUDIO);
  if (local.rows.filter((n) => n === LOCAL.name).length !== 1 || local.rows.includes(FAR.name) || far.rows.filter((n) => n === FAR.name).length !== 1 || far.rows.includes(LOCAL.name)) fail(`the two chats are not one row each in their own part: local ${J(local.rows.filter((n) => [LOCAL.name, FAR.name].includes(n)))}, Studio Mac ${J(far.rows.filter((n) => [LOCAL.name, FAR.name].includes(n)))}`);
  let from = await open("this computer's chat", localRow(LOCAL.name), LOCAL, "");
  if (!await until(() => split(from).here.some((c) => c.method === "GET" && c.path.startsWith(`${HERE}/items`)), 10000)) fail("this computer's chat was not read at /api/chats/c_plain/items");
  await only("opening this computer's chat", from, "here");
  from = await open("Studio Mac's chat", farRow(FAR.name), FAR, "Studio Mac");
  if (!await until(() => split(from).there.some((c) => c.method === "GET" && c.path.startsWith(`${THERE}/items`)), 10000)) fail(`Studio Mac's chat was not read at ${THERE}/items`);
  await only("opening Studio Mac's chat", from, "there");
  if (await farRow(FAR.name).evaluate((r) => r.classList.contains("on")) !== true || await localRow(LOCAL.name).evaluate((r) => r.classList.contains("on"))) fail("with Studio Mac's chat open, the lit row is not its own alone");

  // ---- a draft of one is not the other's
  from = calls.length;
  await box.click(); await page.keyboard.type("for the studio only");
  if (!await until(async () => (await held())[1][2] === "for the studio only", 10000)) fail(`the draft typed in Studio Mac's chat is not saved there: ${J(await held())}`);
  await only("a draft in Studio Mac's chat", from, "there");
  if ((await held())[0][2]) fail("the draft typed in Studio Mac's chat is this computer's chat's too");
  await open("this computer's chat again", localRow(LOCAL.name), LOCAL, "");
  if ((await box.textContent()) !== "") fail(`this computer's chat opens with the other chat's draft: "${await box.textContent()}"`);
  if (!await localRow(LOCAL.name).locator(".draft-tag").count() === false && await localRow(LOCAL.name).locator(".draft-tag").count()) fail("this computer's row has the draft mark of Studio Mac's chat");
  if (!await until(() => farRow(FAR.name).locator(".draft-tag").count(), 10000)) fail("Studio Mac's row has no draft mark for its own draft");

  // ---- a message to one is not in the other
  from = calls.length;
  await box.click(); await page.keyboard.type("ping this computer"); await page.keyboard.press("Enter");
  if (!await until(async () => (await thread()).some((x) => x.includes("A canned reply of the mock.")), 15000)) fail("the message to this computer's chat got no reply");
  if (!await until(() => split(from).here.some((c) => c.method === "POST" && c.path.startsWith(`${HERE}/messages`)), 5000)) fail("the message to this computer's chat did not go to /api/chats/c_plain/messages");
  await only("a message to this computer's chat", from, "here");
  if (J((await held())[1][1]) !== J([FAR.asks])) fail(`Studio Mac's chat got the message: ${J((await held())[1][1])}`);
  from = await open("Studio Mac's chat again", farRow(FAR.name), FAR, "Studio Mac");
  if ((await thread()).some((x) => x.includes("ping this computer") || x.includes("canned reply"))) fail("Studio Mac's thread shows the message sent to this computer's chat");
  if ((await box.textContent()) !== "for the studio only") fail(`Studio Mac's chat lost its draft: "${await box.textContent()}"`);
  from = calls.length;
  await box.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.type("ping the studio"); await page.keyboard.press("Enter");
  if (!await until(async () => (await thread()).some((x) => x.includes("A canned reply of the mock.")), 15000)) fail("the message to Studio Mac's chat got no reply");
  if (!await until(() => split(from).there.some((c) => c.method === "POST" && c.path.startsWith(`${THERE}/messages`)), 5000)) fail(`the message to Studio Mac's chat did not go to ${THERE}/messages`);
  if (split(from).here.length) fail(`a message to Studio Mac's chat made calls for this computer's: ${J(split(from).here.map((c) => `${c.method} ${c.path}`))}`);
  if (J((await held())[0][1]) !== J([LOCAL.asks, "ping this computer"]) || J((await held())[1][1]) !== J([FAR.asks, "ping the studio"])) fail(`the two chats hold the messages ${J((await held()).map((h) => h[1]))}`);
  await open("this computer's chat a third time", localRow(LOCAL.name), { ...LOCAL, says: "A canned reply of the mock." }, "");
  if ((await thread()).some((x) => x.includes("ping the studio"))) fail("this computer's thread shows the message sent to Studio Mac's chat");

  // ---- a rename of one is not the other's: by this page, and by events from elsewhere
  from = calls.length;
  await sideMenu(page, farRow(FAR.name), "More", "Rename");
  await page.locator(`${sec} input.name-input`).fill("Render queue fixed"); await page.keyboard.press("Enter");
  if (!await until(() => farRow("Render queue fixed").count(), 10000)) fail("the rename of Studio Mac's chat does not show");
  await only("a rename of Studio Mac's chat", from, "there");
  from = calls.length;
  await sideMenu(page, localRow(LOCAL.name), "More", "Rename");
  await page.locator(".side-tree input.name-input").fill("Build is slow"); await page.keyboard.press("Enter");
  if (!await until(() => localRow("Build is slow").count(), 10000)) fail("the rename of this computer's chat does not show");
  await only("a rename of this computer's chat", from, "here");
  if (J((await held()).map((h) => h[0])) !== J(["Build is slow", "Render queue fixed"]) || !await farRow("Render queue fixed").count()) fail(`after both renames the chats are named ${J((await held()).map((h) => h[0]))}`);
  await mockEval(`await elsewhere("${STUDIO}", "PATCH", "/chats/c_plain", { name: "Named by its owner" }); await elsewhere("local", "PATCH", "/chats/c_plain", { name: "Named in another window" });`, url);
  if (!await until(async () => await farRow("Named by its owner").count() === 1 && await localRow("Named in another window").count() === 1, 10000)) fail(`the renames from elsewhere did not each reach their own row: ${J([(await sideSeen(page)).rows.filter((n) => /Named/.test(n)), (await sideSeen(page, STUDIO)).rows.filter((n) => /Named/.test(n))])}`);

  // ---- a reload opens the one that was open
  await farRow("Named by its owner").click();
  await page.waitForSelector(".chat-head .chat-head-server");
  await page.reload(); await page.waitForSelector(".side-tree .side-section");
  if (!await until(async () => (await thread()).some((x) => x.includes(FAR.asks)) && (await page.locator(".chat-head .chat-head-server").textContent().catch(() => "")) === "Studio Mac", 10000)) fail(`after a reload with Studio Mac's chat open, the thread is ${J(await thread())}`);
  if ((await thread()).some((x) => x.includes(LOCAL.asks))) fail("after the reload the thread is this computer's chat's");
  const calls2 = callsOf(page);

  // ---- a delete of one leaves the other: Studio Mac's first
  await sideMenu(page, farRow("Named by its owner"), "More", "Delete");
  await page.locator(".dialog[role=dialog] button", { hasText: "Delete" }).click();
  if (!await until(async () => !await farRow("Named by its owner").count() && (await held())[1] === null, 10000)) fail("Studio Mac's chat was not deleted");
  if (!await until(() => calls2.some((c) => c.method === "DELETE" && c.path === THERE), 5000) || calls2.some((c) => c.method === "DELETE" && c.path.startsWith(HERE))) fail(`the delete of Studio Mac's chat made the calls ${J(calls2.filter((c) => c.method === "DELETE").map((c) => c.path))}`);
  if (!(await held())[0] || await localRow("Named in another window").count() !== 1) fail("the delete of Studio Mac's chat took this computer's chat with it");
  await localRow("Named in another window").click();
  if (!await until(async () => (await thread()).some((x) => x.includes(LOCAL.asks)), 10000)) fail("after the other was deleted, this computer's chat does not open with its thread");

  // ---- and this computer's, with Studio Mac's there again (its machine seeded anew)
  await seed(url, "SEC");
  await page.reload(); await page.waitForSelector(`${sec} .side-row`);
  const calls3 = callsOf(page);
  await sideMenu(page, localRow("Named in another window"), "More", "Delete");
  await page.locator(".dialog[role=dialog] button", { hasText: "Delete" }).click();
  if (!await until(async () => !await localRow("Named in another window").count() && (await held())[0] === null, 10000)) fail("this computer's chat was not deleted");
  if (!await until(() => calls3.some((c) => c.method === "DELETE" && c.path === HERE), 5000) || calls3.some((c) => c.method === "DELETE" && c.path.startsWith("/api/on/"))) fail(`the delete of this computer's chat made the calls ${J(calls3.filter((c) => c.method === "DELETE").map((c) => c.path))}`);
  if (!(await held())[1] || await farRow(FAR.name).count() !== 1) fail("the delete of this computer's chat took Studio Mac's chat with it");
  await farRow(FAR.name).click();
  if (!await until(async () => (await thread()).some((x) => x.includes(FAR.asks)) && (await thread()).some((x) => x.includes(FAR.says)), 10000)) fail("after the other was deleted, Studio Mac's chat does not open with its thread");

  for (const e of p.errors) fail(`page error: ${e}`);
  await p.ctx.close();
  note(`two rows, two titles, two threads; a draft, a message, a rename and a delete of each left the other as it was; this computer's calls under ${HERE}, Studio Mac's under ${THERE}`);
});
