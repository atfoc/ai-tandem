// Proves that two things with the same id, one of this computer and one of a section, are told apart everywhere
// (plans/remote-server-sections-goal.md, section 5 "An id is unique on one server only"): the seed's chat c_plain of
// this computer and chat c_plain of Studio Mac are two rows, each in its own part; they open as two chats; a draft's mark, a rename and
// a delete of one never touch the other, by the page's own actions and by events from elsewhere; and every call goes to
// /api/chats/c_plain of "local" for the one and to /api/chats/c_plain of the entry id for the other. The selection that is saved names
// which of the two is open, and a reload opens that one.
// The group g_shop and the board b_arch, which both machines have too, are SEC.3's, SEC.4's and SEC.5's.
// Ports dev/checks/SEC.8-sameid.mjs (S1) to the new build, at the three viewports (A-SB-13, A-SB-17, A-SC-18). It reads the sidebar's half (the rows, the lit row, the calls of
// an open, the draft's mark, a rename and a delete of each) and what the chat view (S4) and the composer (K3) show of each: the titles and threads of the two
// chats, the box's draft, a message sent to one and the reply.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { messages, textOf } from "./chat.mjs";
import { byTid, layoutNow, openChat, press, showList } from "./sel.mjs";
import { rowNamed, section, sideMenu, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", HERE = "local /api/chats/c_plain", THERE = `${STUDIO} /api/chats/c_plain`;
/** A call as "<server> <path>": what HERE and THERE are the starts of. */
const at = (c) => `${c.server} ${c.path}`;
const LOCAL = { name: "Why is the build slow", asks: "Why is the build slow?", says: "Because of the font copy step." };
const FAR = { name: "Render queue is stuck", asks: "Why is the render queue stuck?", says: "Two jobs hold the GPU lock." };

await check("SEC.8 a chat of this computer and a chat of a section with the same id are two chats", async ({ url, open, fail, note }) => {
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const calls = callsOf(page);
  const sec = section(page, STUDIO), loc = section(page, "local");
  const localRow = (name) => rowNamed(page, name, loc);
  const farRow = (name) => rowNamed(page, name, sec);
  /** What the two machines hold of their chat c_plain: its name, its messages, its draft. */
  const held = () => mockEval(`const of = () => (chats.c_plain ? [chats.c_plain.name, items.c_plain.filter((x) => x.kind === "user").map((x) => x.text), chats.c_plain.draft?.text ?? ""] : null); return [of(), onServer("${STUDIO}", of)];`, url);
  /** The calls since `from` that are about a chat c_plain: those of this computer's, and those of Studio Mac's. */
  const split = (from) => { const mine = calls.slice(from).filter((c) => /\/chats\/c_plain(\/|\?|$)/.test(c.path)); return { here: mine.filter((c) => at(c).startsWith(HERE)), there: mine.filter((c) => at(c).startsWith(THERE)), other: mine.filter((c) => !at(c).startsWith(HERE) && !at(c).startsWith(THERE)) }; };
  /** (a call is heard of a moment after it was made: the calls of the right kind are waited for, the others read then) */
  const only = async (name, from, which) => { await until(() => split(from)[which].length, 5000); const s = split(from), wrong = which === "here" ? s.there : s.here; if (wrong.length || s.other.length || !s[which].length) fail(`${name}: the calls were ${J(calls.slice(from).filter((c) => /c_plain/.test(c.path)).map((c) => `${c.method} ${at(c)}`))}, not all under ${which === "here" ? HERE : THERE}`); };
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
  const thread = async () => (await messages(page)).map((m) => m.text);
  const box = () => byTid(page, "composer-input").first();
  /** The chat on screen is one of the two (the chat view's half of the old `open`): its title, its server in the head or none, and its own thread. */
  const shows = async (name, want, server) => {
    if (!await until(async () => { const t = await thread(); return t.some((x) => x.includes(want.asks)) && t.some((x) => x.includes(want.says)); }, 10000)) fail(`${name}: the thread is ${J(await thread())}`);
    const other = server ? LOCAL : FAR;
    if ((await thread()).some((x) => x.includes(other.asks) || x.includes(other.says))) fail(`${name}: the thread has the other chat's messages: ${J(await thread())}`);
    const head = await textOf(page, "chat-head");
    if (!head.includes(want.name) || head.includes(other.name)) fail(`${name}: the head says "${head}"`);
    if (await textOf(page, "chat-head-server") !== server) fail(`${name}: the head names the server "${await textOf(page, "chat-head-server")}", not "${server}"`);
  };
  /** The chat on screen is one of the two: the selection that is saved names it, and on the wide layouts its row is the lit one alone. */
  const opens = async (name, key) => {
    const from = calls.length;
    await openChat(page, key);
    if ((await saved()).chat !== key) fail(`${name}: the saved selection is ${J(await saved())}`);
    if (layoutNow(page) !== "phone") {
      const lit = await page.evaluate(() => [...document.querySelectorAll('[data-testid="side-row"][aria-selected="true"]')].map((r) => r.dataset.key));
      if (J(lit) !== J([key])) fail(`${name}: the lit rows are ${J(lit)}, not ${J([key])} alone`);
    }
    return from;
  };
  await byTid(sec, "side-row").first().waitFor({ state: "attached", timeout: 15000 });

  // ---- two rows, each in its own part, and each opens as itself
  const local = await sideSeen(page, "local"), far = await sideSeen(page, STUDIO);
  if (local.rows.filter((n) => n === LOCAL.name).length !== 1 || local.rows.includes(FAR.name) || far.rows.filter((n) => n === FAR.name).length !== 1 || far.rows.includes(LOCAL.name)) fail(`the two chats are not one row each in their own part: local ${J(local.rows.filter((n) => [LOCAL.name, FAR.name].includes(n)))}, Studio Mac ${J(far.rows.filter((n) => [LOCAL.name, FAR.name].includes(n)))}`);
  let from = await opens("this computer's chat", "c_plain");
  await shows("this computer's chat", LOCAL, "");
  if (!await until(() => split(from).here.some((c) => c.method === "GET" && at(c).startsWith(`${HERE}/items`)), 10000)) fail("this computer's chat was not read at /api/chats/c_plain/items");
  await only("opening this computer's chat", from, "here");
  from = await opens("Studio Mac's chat", `${STUDIO}~c_plain`);
  await shows("Studio Mac's chat", FAR, "Studio Mac");
  if (!await until(() => split(from).there.some((c) => c.method === "GET" && at(c).startsWith(`${THERE}/items`)), 10000)) fail(`Studio Mac's chat was not read at ${THERE}/items`);
  await only("opening Studio Mac's chat", from, "there");

  // ---- a draft of one is not the other's (a draft saved from elsewhere marks the row of its own chat: the open chat's own draft marks no row)
  await openChat(page, "c_plain");
  await mockEval(`await elsewhere("${STUDIO}", "PUT", "/chats/c_plain/draft", { text: "for the studio only" });`, url);
  if (!await until(() => byTid(farRow(FAR.name), "draft-tag").count(), 10000)) fail("Studio Mac's row has no draft mark for its own draft");
  if (await byTid(localRow(LOCAL.name), "draft-tag").count()) fail("this computer's row has the draft mark of Studio Mac's chat");
  if ((await held())[0][2]) fail("the draft saved in Studio Mac's chat is this computer's chat's too");
  await mockEval(`await elsewhere("${STUDIO}", "PUT", "/chats/c_plain/draft", { text: "" });`, url);
  if (!await until(async () => !await byTid(farRow(FAR.name), "draft-tag").count(), 10000)) fail("Studio Mac's row keeps the mark of a draft that was removed");

  // ---- a draft typed in one is not the other's, and a message to one is not in the other (the composer's half of the old check)
  from = (await opens("Studio Mac's chat", `${STUDIO}~c_plain`), calls.length);
  await press(page, box()); await page.keyboard.type("for the studio only");
  if (!await until(async () => (await held())[1][2] === "for the studio only", 10000)) fail(`the draft typed in Studio Mac's chat is not saved there: ${J(await held())}`);
  await only("a draft in Studio Mac's chat", from, "there");
  if ((await held())[0][2]) fail("the draft typed in Studio Mac's chat is this computer's chat's too");
  await opens("this computer's chat again", "c_plain");
  await shows("this computer's chat again", LOCAL, "");
  if ((await box().textContent()) !== "") fail(`this computer's chat opens with the other chat's draft: "${await box().textContent()}"`);
  await showList(page);
  if (await byTid(localRow(LOCAL.name), "draft-tag").count()) fail("this computer's row has the draft mark of Studio Mac's chat");
  if (!await until(() => byTid(farRow(FAR.name), "draft-tag").count(), 10000)) fail("Studio Mac's row has no draft mark for its own draft");
  await opens("this computer's chat once more", "c_plain");
  from = calls.length;
  await press(page, box()); await page.keyboard.type("ping this computer"); await page.keyboard.press("Enter");
  if (!await until(async () => (await thread()).some((x) => x.includes("A canned reply of the mock.")), 15000)) fail("the message to this computer's chat got no reply");
  if (!await until(() => split(from).here.some((c) => c.method === "POST" && at(c).startsWith(`${HERE}/messages`)), 5000)) fail("the message to this computer's chat did not go to /api/chats/c_plain/messages");
  await only("a message to this computer's chat", from, "here");
  if (J((await held())[1][1]) !== J([FAR.asks])) fail(`Studio Mac's chat got the message: ${J((await held())[1][1])}`);
  from = await opens("Studio Mac's chat again", `${STUDIO}~c_plain`);
  await shows("Studio Mac's chat again", FAR, "Studio Mac");
  if ((await thread()).some((x) => x.includes("ping this computer") || x.includes("canned reply"))) fail("Studio Mac's thread shows the message sent to this computer's chat");
  if ((await box().textContent()) !== "for the studio only") fail(`Studio Mac's chat lost its draft: "${await box().textContent()}"`);
  from = calls.length;
  await press(page, box()); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.type("ping the studio"); await page.keyboard.press("Enter");
  if (!await until(async () => (await thread()).some((x) => x.includes("A canned reply of the mock.")), 15000)) fail("the message to Studio Mac's chat got no reply");
  if (!await until(() => split(from).there.some((c) => c.method === "POST" && at(c).startsWith(`${THERE}/messages`)), 5000)) fail(`the message to Studio Mac's chat did not go to ${THERE}/messages`);
  if (split(from).here.length) fail(`a message to Studio Mac's chat made calls for this computer's: ${J(split(from).here.map((c) => `${c.method} ${c.path}`))}`);
  if (J((await held())[0][1]) !== J([LOCAL.asks, "ping this computer"]) || J((await held())[1][1]) !== J([FAR.asks, "ping the studio"])) fail(`the two chats hold the messages ${J((await held()).map((h) => h[1]))}`);
  await opens("this computer's chat a third time", "c_plain");
  if ((await thread()).some((x) => x.includes("ping the studio"))) fail("this computer's thread shows the message sent to Studio Mac's chat");

  // ---- a rename of one is not the other's: by this page, and by events from elsewhere
  await showList(page);
  from = calls.length;
  await sideMenu(page, farRow(FAR.name), "More", "Rename");
  await byTid(sec, "name-input").fill("Render queue fixed"); await page.keyboard.press("Enter");
  if (!await until(() => farRow("Render queue fixed").count(), 10000)) fail("the rename of Studio Mac's chat does not show");
  await only("a rename of Studio Mac's chat", from, "there");
  from = calls.length;
  await sideMenu(page, localRow(LOCAL.name), "More", "Rename");
  await byTid(page, "side-tree").locator('[data-testid="name-input"]').fill("Build is slow"); await page.keyboard.press("Enter");
  if (!await until(() => localRow("Build is slow").count(), 10000)) fail("the rename of this computer's chat does not show");
  await only("a rename of this computer's chat", from, "here");
  if (J((await held()).map((h) => h[0])) !== J(["Build is slow", "Render queue fixed"]) || !await farRow("Render queue fixed").count()) fail(`after both renames the chats are named ${J((await held()).map((h) => h[0]))}`);
  await mockEval(`await elsewhere("${STUDIO}", "PATCH", "/chats/c_plain", { name: "Named by its owner" }); await elsewhere("local", "PATCH", "/chats/c_plain", { name: "Named in another window" });`, url);
  if (!await until(async () => await farRow("Named by its owner").count() === 1 && await localRow("Named in another window").count() === 1, 10000)) fail(`the renames from elsewhere did not each reach their own row: ${J([(await sideSeen(page, "local")).rows.filter((n) => /Named/.test(n)), (await sideSeen(page, STUDIO)).rows.filter((n) => /Named/.test(n))])}`);

  // ---- a reload opens the one that was open
  await openChat(page, `${STUDIO}~c_plain`);
  await page.reload(); await byTid(page, "side-section").first().waitFor({ state: "attached", timeout: 15000 });
  if ((await saved()).chat !== `${STUDIO}~c_plain`) fail(`after a reload the saved selection is ${J(await saved())}`);
  if (!await until(async () => J(await page.evaluate(() => [...document.querySelectorAll('[data-testid="side-row"][aria-selected="true"]')].map((r) => r.dataset.key))) === J([`${STUDIO}~c_plain`]), 10000)) fail("after a reload with Studio Mac's chat open its row is not the lit one alone");
  if (!await until(async () => (await thread()).some((x) => x.includes(FAR.asks)) && (await textOf(page, "chat-head-server")) === "Studio Mac", 10000)) fail(`after a reload with Studio Mac's chat open, the thread is ${J(await thread())}`);
  if ((await thread()).some((x) => x.includes(LOCAL.asks))) fail("after the reload the thread is this computer's chat's");
  const calls2 = callsOf(page);

  // ---- a delete of one leaves the other: Studio Mac's first
  await showList(page);
  await sideMenu(page, farRow("Named by its owner"), "More", "Delete");
  await press(page, byTid(page, "confirm-dialog").getByText("Delete", { exact: true }).last());
  if (!await until(async () => !await farRow("Named by its owner").count() && (await held())[1] === null, 10000)) fail("Studio Mac's chat was not deleted");
  if (!await until(() => calls2.some((c) => c.method === "DELETE" && at(c) === THERE), 5000) || calls2.some((c) => c.method === "DELETE" && at(c).startsWith(HERE))) fail(`the delete of Studio Mac's chat made the calls ${J(calls2.filter((c) => c.method === "DELETE").map((c) => c.path))}`);
  if (!(await held())[0] || await localRow("Named in another window").count() !== 1) fail("the delete of Studio Mac's chat took this computer's chat with it");
  await openChat(page, "c_plain");
  if ((await saved()).chat !== "c_plain") fail("after the other was deleted, this computer's chat does not open");
  if (!await until(async () => (await thread()).some((x) => x.includes(LOCAL.asks)), 10000)) fail("after the other was deleted, this computer's chat does not open with its thread");

  // ---- and this computer's, with Studio Mac's there again (its machine seeded anew)
  await seed(url, "SEC");
  await page.reload(); await byTid(sec, "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  const calls3 = callsOf(page);
  await showList(page);
  await sideMenu(page, localRow("Named in another window"), "More", "Delete");
  await press(page, byTid(page, "confirm-dialog").getByText("Delete", { exact: true }).last());
  if (!await until(async () => !await localRow("Named in another window").count() && (await held())[0] === null, 10000)) fail("this computer's chat was not deleted");
  if (!await until(() => calls3.some((c) => c.method === "DELETE" && at(c) === HERE), 5000) || calls3.some((c) => c.method === "DELETE" && c.server !== "local")) fail(`the delete of this computer's chat made the calls ${J(calls3.filter((c) => c.method === "DELETE").map((c) => c.path))}`);
  if (!(await held())[1] || await farRow(FAR.name).count() !== 1) fail("the delete of this computer's chat took Studio Mac's chat with it");
  await openChat(page, `${STUDIO}~c_plain`);
  if ((await saved()).chat !== `${STUDIO}~c_plain`) fail("after the other was deleted, Studio Mac's chat does not open");
  if (!await until(async () => (await thread()).some((x) => x.includes(FAR.asks)) && (await thread()).some((x) => x.includes(FAR.says)), 10000)) fail("after the other was deleted, Studio Mac's chat does not open with its thread");

  note(`two rows, two opens, two renames and two deletes, each leaving the other as it was; a draft's mark of each; this computer's calls under ${HERE}, Studio Mac's under ${THERE}`);
}, { viewports, page: false });
