// Proves that a remote server dropping does not touch this computer's section, and the other way round for a chat open on a
// remote server (app-as-client-goal.md, 3.3, 7.1: "a remote server that is down does not hold up this computer's section, and the
// other way round"). It goes on from AAC.2, which proves what this computer's own dropping does to what is open on it.
// A chat of this computer is open: Studio Mac drops, and this computer's section keeps its rows, its head, its +; Studio Mac's
// section says what the server list says of it and has no rows. Back: Studio Mac's tree is there again, and this computer's chat was not
// touched. A chat of Studio Mac is open: this computer drops, and Studio Mac's section is as it was.
// Ports dev/checks/AAC.3-remotedown.mjs (S1, S4, K3) to the new build, at the three viewports (A-SC-21). Deviations: the selection that
// stays is read in the page's storage (`aiwb.sel`) and the thread by `messages` of chat.mjs (the messages in the order they are on screen);
// on the phone the list is shown (`showList`) before the sidebar's + is read.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, showList } from "./sel.mjs";
import { sideSeen } from "./side.mjs";
import { messages, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio";

await check("AAC.3 a remote server that drops leaves this computer's section as it is, and the other way round", async ({ url, open, fail, note }) => {
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
  const run = async (sel, body) => {
    await seed(url, "SEC");
    const p = await open({ sel, wait: '[data-testid="chat-head"]' });
    p.calls = callsOf(p.page);
    try { await body(p); } finally { await p.ctx.close(); }
  };

  // ---- Studio Mac drops with a chat of this computer open
  await run({ chat: "c_plain" }, async ({ page, calls }) => {
    await threadShown(page);
    const local = await sideSeen(page, "local"), studio = await sideSeen(page, STUDIO), thread = await messages(page);
    if (!local.rows.length || !studio.rows.length) fail("the seed has no rows in this computer's section or in Studio Mac's");
    await set(STUDIO, "unreachable", { detail: "connection refused" });
    if (!await until(async () => !(await sideSeen(page, STUDIO)).rows.length, 10000)) fail("Studio Mac's rows stay while it is away");
    const after = await sideSeen(page, "local");
    if (J(after.outline) !== J(local.outline) || after.state !== "Connected" || after.tone !== "ok" || !after.add) fail(`this computer's section changed when Studio Mac dropped: ${J([after.state, after.tone, after.add])}`);
    if ((await sideSeen(page, STUDIO)).state !== "Unreachable") fail(`Studio Mac's head says "${(await sideSeen(page, STUDIO)).state}"`);
    if ((await saved(page)).chat !== "c_plain") fail(`the chat of this computer is not the selection any more: ${J(await saved(page))}`);
    for (const id of ["remote-bar", "agent-reason"]) if (await byTid(page, id).count()) fail(`the chat of this computer has a warning: "${await textOf(page, id)}"`);
    if (J(await messages(page)) !== J(thread)) fail("the chat of this computer changed when Studio Mac dropped");
    // a message is sent to this computer meanwhile
    const box = byTid(page, "composer-input").first();
    await press(page, box); await page.keyboard.type("while Studio Mac is away");
    if (await box.getAttribute("aria-readonly") === "true") fail("the composer of this computer's chat is read-only because Studio Mac is away");
    const was = calls.length;
    await page.keyboard.press("Enter");
    if (!await until(() => calls.slice(was).some((c) => c.server === "local" && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to this computer: ${J(calls.slice(was).map((c) => [c.server, c.method, c.path, c.status]))}`);
    if (calls.slice(was).some((c) => c.server === STUDIO && c.method !== "GET")) fail("a call for this computer's chat went to Studio Mac");
    await showList(page);
    if (await byTid(page, "side-new").first().isDisabled()) fail("the sidebar's + is off though this computer is connected");
    const before = calls.length;
    // Studio Mac is back
    await set(STUDIO, "connected");
    if (!await until(async () => J((await sideSeen(page, STUDIO)).outline) === J(studio.outline), 10000)) fail(`back, Studio Mac's tree is not whole: ${J((await sideSeen(page, STUDIO)).outline)}`);
    if (calls.slice(before).some((c) => c.server === "local" && c.method !== "GET")) fail("a call that changes something was made for this computer's chat while Studio Mac came back");
    if (await byTid(page, "remote-bar").count()) fail("a warning shows on this computer's chat when Studio Mac is back");
  });

  // ---- this computer drops with a chat of Studio Mac open
  await run({ chat: `${STUDIO}~c_plain` }, async ({ page, calls }) => {
    await threadShown(page);
    await set("local", "unreachable", { detail: "connection refused" });
    if (!await until(async () => !(await sideSeen(page, "local")).rows.length, 10000)) fail("this computer's rows stay while it is away");
    if (await byTid(page, "remote-bar").count()) fail(`the chat of Studio Mac has a warning because this computer is away: "${await textOf(page, "remote-bar")}"`);
    const box = byTid(page, "composer-input").first();
    await press(page, box); await page.keyboard.type("while this computer is away");
    if (await box.getAttribute("aria-readonly") === "true") fail("the composer of Studio Mac's chat is read-only because this computer is away");
    const was = calls.length;
    await page.keyboard.press("Enter");
    if (!await until(() => calls.slice(was).some((c) => c.server === STUDIO && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to Studio Mac: ${J(calls.slice(was).map((c) => [c.server, c.method, c.path, c.status]))}`);
    if ((await saved(page)).chat !== `${STUDIO}~c_plain`) fail(`the chat of Studio Mac is not the selection any more: ${J(await saved(page))}`);
    if ((await sideSeen(page, STUDIO)).state !== "Connected" || !(await sideSeen(page, STUDIO)).rows.length) fail("Studio Mac's section is not as it was while this computer is away");
    await set("local", "connected");
    if (!await until(async () => (await sideSeen(page, "local")).rows.length > 0, 10000)) fail("back, this computer's section has no rows");
  });
  note("this computer's section, head and selection as they were while Studio Mac was away; Studio Mac's section as it was while this computer was away; both back with their rows");
}, { viewports, page: false });
