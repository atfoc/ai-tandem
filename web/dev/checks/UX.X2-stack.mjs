// UX.X2-stack (package X2, ux-improvements goal 3.1.2 and 3.2): the phone's stack is the same during a server's outage. A chat of a remote
// server, opened the way a person does (Home, the server's chip, its groups, its row), is Home › Renders › Nightly › chat; the server drops
// and the stack is still that (the store drops the server's tree, the stack takes its groups from the last tree Home and the group screens
// drew, in memory: app/src/screens/shell/phone/lastgroups.ts). The chat is not drawn again (X1's R3.12 fix); the back lands on the group
// Nightly, drawn faded from the last sync, a second back on Renders, a third on Home. Phone only: the wide layouts have no stack.
import { check, mockEval, seed, until } from "../shot.mjs";
import { IDS, byTid, back, openChat, press } from "./sel.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
const STUDIO = "s_studio";
const SHOP = `${STUDIO}~g_shop`, NIGHT = `${STUDIO}~g_sub`, CHAT = `${STUDIO}~c_night`;
const FULL = ["home", `group:${SHOP}`, `group:${NIGHT}`, `chat:${CHAT}`];

await check("UX.X2-stack a remote chat's stack is Home › group › chat during its server's outage, and the back lands on the group, faded", async ({ url, open, fail, note }) => {
  await seed(url, "SEC");
  const { page, ctx } = await open({ wait: '[data-testid="home"]' });
  const keys = async () => (await page.evaluate(() => window.__aiwbStack.entries())).map((e) => e.key);
  const keysAre = async (what, want) => {
    const ok = await until(async () => J(await keys()) === J(want), WAIT);
    if (!ok) fail(`${what}: the stack is ${J(await keys())}, not ${J(want)}`);
    return ok;
  };
  const top = (id, data) => byTid(page, id, data).last();
  const sheetRows = async () => {
    const sheet = byTid(page, "stack-sheet").last();
    return sheet.isVisible().then(() => byTid(page, "picker-row").evaluateAll((els) => els.map((e) => e.dataset.value)), () => []);
  };

  await openChat(page, CHAT);
  await keysAre("a remote chat opened from Home, its server connected", FULL);
  await page.evaluate(() => { document.querySelector('[data-testid="chat-head"]').__x2 = "same"; }); // (a chat drawn again is a new element)

  // ---- the server drops: the stack does not change, the chat is not drawn again
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  await until(async () => (await byTid(page, "remote-bar").count()) > 0, WAIT);
  await keysAre("the chat's server dropped", FULL);
  if (!(await page.evaluate(() => document.querySelector('[data-testid="chat-head"]')?.__x2 === "same"))) fail("the chat was drawn again when its server dropped (X1's R3.12)");

  // ---- the stack sheet reads Home › group › chat
  const hold = async () => {
    const b = top(IDS.back), box = await b.boundingBox();
    const c = await page.context().newCDPSession(page);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + Math.min(30, box.width / 2), y: box.y + box.height / 2, id: 1 }] });
    await page.waitForTimeout(800);
    await byTid(page, "stack-sheet").last().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await c.detach();
  };
  await hold();
  const rows = await sheetRows();
  if (J(rows) !== J(FULL)) fail(`the stack sheet during the outage lists ${J(rows)}, not ${J(FULL)}`);
  if (rows.length) await press(page, byTid(page, "picker-row", { value: `group:${NIGHT}` }).last()); // (a pick of the group is a back)
  else await back(page);
  note("the server dropped: the stack stays Home › Renders › Nightly › chat, the chat stays");

  // ---- the back lands on the group (faded), then its parent, then Home
  await keysAre("the back from the chat of a dropped server", FULL.slice(0, -1));
  await until(async () => await byTid(page, "group-screen", { key: NIGHT }).last().isVisible().catch(() => false), WAIT);
  const list = top("home-list");
  if (!(await until(async () => (await list.getAttribute("data-stale").catch(() => null)) === "true", WAIT))) fail("the group screen after the back is not drawn faded from the last sync (home-list data-stale)");
  if ((await byTid(page, "home-row", { kind: "chat", key: CHAT }).count()) !== 1) fail("the faded group does not list its chat from the last sync");
  const sel = await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "null"));
  if (sel?.chat) fail(`after the back the saved selection is ${J(sel)}, not none`);
  await back(page);
  await keysAre("the second back", FULL.slice(0, -2));
  await back(page);
  await keysAre("the third back", ["home"]);
  note("back: the group (faded, from the last sync), its parent, Home");

  // ---- the server is back: the stack is as it was when the chat is opened again
  await mockEval(`setServerState("${STUDIO}", "connected");`, url);
  // (Home is in its "trouble" state for a moment after the server is back: its list is faded and a press on a row opens nothing)
  await until(async () => (await page.evaluate(() => document.querySelector('[data-testid="home"]')?.dataset.state)) === "list", WAIT);
  await openChat(page, CHAT).catch(async (e) => { fail(`${e.message}; stack ${J(await keys())}, rows ${J(await page.evaluate(() => [...document.querySelectorAll("[data-testid=home-row]")].map((e) => e.dataset.kind + ":" + e.dataset.key)))}`); });
  await keysAre("the chat opened again, its server back", FULL);
  await ctx.close();
}, { viewports, page: false });
