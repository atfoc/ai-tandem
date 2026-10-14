// Proves that a remote server dropping does not touch this computer's section, and the other way round for a chat open on a
// remote server (app-as-client-goal.md, 3.3, 7.1: "a remote server that is down does not hold up this computer's section, and the
// other way round"). It goes on from AAC.2, which proves what this computer's own dropping does to what is open on it.
// A chat of this computer is open and a message is typed: Studio Mac drops, and this computer's section keeps its rows, its head,
// its +, the chat its warning-free view, a composer that takes text and a Send that reaches this computer; Studio Mac's section says
// what the server list says of it and has no rows. Back: Studio Mac's tree is there again, and this computer's chat was not touched.
// A chat of Studio Mac is open: this computer drops, and the chat of Studio Mac keeps being live: its composer sends there.
import { callsOf, check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio";

await check("AAC.3 a remote server that drops leaves this computer's section as it is, and the other way round", async ({ url, browser, fail, note }) => {
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => "");
  const open = async (sel) => {
    await seed(url, "SEC");
    const p = await openPage({ url, browser, sel, size: [1280, 900] });
    p.calls = callsOf(p.page);
    p.end = async () => { for (const e of p.errors) fail(`page error: ${e}`); await p.ctx.close(); };
    return p;
  };

  // ---- Studio Mac drops with a chat of this computer open
  {
    const p = await open({ chat: "c_plain" }), { page } = p;
    await page.waitForSelector(".thread .msg.user");
    const local = await sideSeen(page, "local"), studio = await sideSeen(page, STUDIO), thread = await page.locator(".thread .msg").allTextContents();
    if (!local.rows.length || !studio.rows.length) fail("the seed has no rows in this computer's section or in Studio Mac's");
    await set(STUDIO, "unreachable", { detail: "connection refused" });
    if (!await until(async () => !(await sideSeen(page, STUDIO)).rows.length, 10000)) fail("Studio Mac's rows stay while it is away");
    const after = await sideSeen(page, "local");
    if (J(after.outline) !== J(local.outline) || after.state !== "Connected" || after.tone !== "ok" || !after.add) fail(`this computer's section changed when Studio Mac dropped: ${J([after.state, after.tone, after.add])}`);
    if ((await sideSeen(page, STUDIO)).state !== "Unreachable") fail(`Studio Mac's head says "${(await sideSeen(page, STUDIO)).state}"`);
    if (await page.locator(".remote-bar, .composer .agent-reason").count()) fail(`the chat of this computer has a warning: "${await text(page, ".remote-bar, .composer .agent-reason")}"`);
    if (J(await page.locator(".thread .msg").allTextContents()) !== J(thread)) fail("the chat of this computer changed when Studio Mac dropped");
    if (await page.locator(".side-head .icon-btn.new").isDisabled()) fail("the sidebar's + is off though this computer is connected");
    // a message is sent to this computer meanwhile
    const box = page.locator(".composer .composer-input");
    await box.click(); await page.keyboard.type("while Studio Mac is away");
    if (await box.getAttribute("aria-readonly") === "true") fail("the composer of this computer's chat is read-only because Studio Mac is away");
    const before = p.calls.length;
    await page.keyboard.press("Enter");
    if (!await until(() => p.calls.slice(before).some((c) => c.server === "local" && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to this computer: ${J(p.calls.slice(before).map((c) => [c.server, c.method, c.path, c.status]))}`);
    if (p.calls.slice(before).some((c) => c.server === STUDIO && c.method !== "GET")) fail("a call for this computer's chat went to Studio Mac");
    // Studio Mac is back
    await set(STUDIO, "connected");
    if (!await until(async () => J((await sideSeen(page, STUDIO)).outline) === J(studio.outline), 10000)) fail(`back, Studio Mac's tree is not whole: ${J((await sideSeen(page, STUDIO)).outline)}`);
    if (await page.locator(".remote-bar").count()) fail("a warning shows on this computer's chat when Studio Mac is back");
    await p.end();
  }

  // ---- this computer drops with a chat of Studio Mac open
  {
    const p = await open({ chat: `${STUDIO}~c_plain` }), { page } = p;
    await page.waitForSelector(".thread .msg.user");
    await set("local", "unreachable", { detail: "connection refused" });
    if (!await until(async () => !(await sideSeen(page, "local")).rows.length, 10000)) fail("this computer's rows stay while it is away");
    if (await page.locator(".remote-bar").count()) fail(`the chat of Studio Mac has a warning because this computer is away: "${await text(page, ".remote-bar")}"`);
    const box = page.locator(".composer .composer-input");
    await box.click(); await page.keyboard.type("while this computer is away");
    if (await box.getAttribute("aria-readonly") === "true") fail("the composer of Studio Mac's chat is read-only because this computer is away");
    const before = p.calls.length;
    await page.keyboard.press("Enter");
    if (!await until(() => p.calls.slice(before).some((c) => c.server === STUDIO && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to Studio Mac: ${J(p.calls.slice(before).map((c) => [c.server, c.method, c.path, c.status]))}`);
    if ((await sideSeen(page, STUDIO)).state !== "Connected" || !(await sideSeen(page, STUDIO)).rows.length) fail("Studio Mac's section is not as it was while this computer is away");
    await set("local", "connected");
    if (!await until(async () => (await sideSeen(page, "local")).rows.length > 0, 10000)) fail("back, this computer's section has no rows");
    await p.end();
  }
  note("this computer's section, head and chat as they were while Studio Mac was away, and a message sent to it; a chat of Studio Mac live and sending while this computer was away");
});
