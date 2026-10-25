// Proves that a remote server dropping does not touch this computer's section, and the other way round for a chat open on a
// remote server (app-as-client-goal.md, 3.3, 7.1: "a remote server that is down does not hold up this computer's section, and the
// other way round"). It goes on from AAC.2, which proves what this computer's own dropping does to what is open on it.
// A chat of this computer is open: Studio Mac drops, and this computer's section keeps its rows, its head, its +; Studio Mac's
// section says what the server list says of it and has no rows. Back: Studio Mac's tree is there again, and this computer's chat was not
// touched. A chat of Studio Mac is open: this computer drops, and Studio Mac's section is as it was.
// Ports dev/checks/AAC.3-remotedown.mjs (S1, S4, K3) to the new build, at the three viewports (A-SC-21). Deviations: the selection that
// stays is read in the page's storage (`aiwb.sel`) and the thread by `messages` of chat.mjs (the messages in the order they are on screen);
// on the phone the list is shown (`showList`) before the sidebar's + is read.
// The phone has no sidebar (package H1, plans/ux-improvements/h1-design.md §2, §4.3, §5): its half (`phoneHalf` below) proves the same on Home, one server at
// a time: the chips say each server's word (a dot of its own), a server that is away is its Home's problem card above its last list, faded (the rows
// the page drew while it was there), and the other's Home is as it was. The chats are opened from Home first (the rows read before), and Home is
// read again after the chat's part, since the chat is a screen over it. A chat of a server that drops is told once, by the composer's offline notice in the
// toolbar's place (V1, goal 3.7.1: `composer-block`, `block-servers`), not by the box's placeholder.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press, showHome, showList } from "./sel.mjs";
import { homeOf, sideSeen } from "./side.mjs";
import { messages, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio";

await check("AAC.3 a remote server that drops leaves this computer's section as it is, and the other way round", async ({ url, layout, open, fail, note }) => {
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
  /** The phone's half: the same two runs, Home read in the place of the sidebar's sections. */
  const phoneHalf = async () => {
    const runPhone = async (body) => {
      await seed(url, "SEC");
      const p = await open({ wait: '[data-testid="home"]' });
      p.calls = callsOf(p.page);
      try { await body(p); } finally { await p.ctx.close(); }
    };
    const homeOn = async (page, id) => { await showHome(page, id); return homeOf(page); };

    // ---- Studio Mac drops with a chat of this computer open
    await runPhone(async ({ page, calls }) => {
      const local = await homeOn(page, "local"), studio = await homeOn(page, STUDIO);
      if (!local.rows.length || !studio.rows.length) fail("the seed has no rows on this computer's Home or Studio Mac's");
      await openChat(page, "c_plain");
      await threadShown(page);
      const thread = await messages(page);
      await set(STUDIO, "unreachable", { detail: "connection refused" });
      if ((await saved(page)).chat !== "c_plain") fail(`the chat of this computer is not the selection any more: ${J(await saved(page))}`);
      for (const id of ["remote-bar", "agent-reason"]) if (await byTid(page, id).count()) fail(`the chat of this computer has a warning: "${await textOf(page, id)}"`);
      if (J(await messages(page)) !== J(thread)) fail("the chat of this computer changed when Studio Mac dropped");
      const box = byTid(page, "composer-input").first();
      await press(page, box); await page.keyboard.type("while Studio Mac is away");
      if (await box.getAttribute("aria-readonly") === "true") fail("the composer of this computer's chat is read-only because Studio Mac is away");
      const was = calls.length;
      await page.keyboard.press("ControlOrMeta+Enter");
      if (!await until(() => calls.slice(was).some((c) => c.server === "local" && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to this computer: ${J(calls.slice(was).map((c) => [c.server, c.method, c.path, c.status]))}`);
      if (calls.slice(was).some((c) => c.server === STUDIO && c.method !== "GET")) fail("a call for this computer's chat went to Studio Mac");
      // Home: Studio Mac's is its card above the faded last list, and the chip's word; this computer's is as it was
      const away = await homeOn(page, STUDIO);
      if (away.state !== "trouble" || away.card?.word !== "unreachable" || away.card?.server !== STUDIO) fail(`Studio Mac's Home says ${J([away.state, away.card])}, not the problem card of an unreachable server`);
      if (!away.stale || J(away.outline) !== J(studio.outline)) fail(`Studio Mac's list while it is away is ${J(away.stale ? away.outline : "not faded")}, not its last sync's ${J(studio.outline)}, faded`);
      const chips = (await homeOf(page)).chips;
      if (chips.find((c) => c.server === STUDIO)?.word !== "unreachable" || chips.find((c) => c.server === "local")?.word !== "connected") fail(`the chips say ${J(chips.map((c) => [c.server, c.word]))}`);
      const after = await homeOn(page, "local");
      if (J(after.outline) !== J(local.outline) || after.state !== "list" || after.word !== "connected" || !after.newEnabled || after.card || after.stale) fail(`this computer's Home changed when Studio Mac dropped: ${J([after.state, after.word, after.newEnabled, after.card, after.stale])}`);
      const before = calls.length;
      // Studio Mac is back
      await set(STUDIO, "connected");
      await showHome(page, STUDIO);
      if (!await until(async () => { const h = await homeOf(page); return h.state === "list" && !h.stale && J(h.outline) === J(studio.outline); }, 10000)) fail(`back, Studio Mac's Home is not whole: ${J((await homeOf(page)).outline)}`);
      if (calls.slice(before).some((c) => c.server === "local" && c.method !== "GET")) fail("a call that changes something was made for this computer's chat while Studio Mac came back");
      if ((await homeOf(page)).card) fail("the problem card stays on Studio Mac's Home when it is back");
    });

    // ---- Studio Mac drops with a chat of Studio Mac open (T3-5, goal 3.5: the thread stays, as it was, with no bar over or under it; the
    // composer says it; the server's return shows the "back online" toast once)
    await runPhone(async ({ page }) => {
      await homeOn(page, STUDIO);
      await openChat(page, `${STUDIO}~c_plain`);
      await threadShown(page);
      const thread = await messages(page), toast = byTid(page, "toast");
      if (await toast.count()) fail("a toast shows before the server dropped: the first look is not a return");
      await set(STUDIO, "unreachable", { detail: "connection refused" });
      const box = byTid(page, "composer-input").first();
      // (V1, goal 3.7.1: said once, in the toolbar's place inside the box, with a Servers button, and no placeholder in the box)
      const block = byTid(page, "composer-block", { kind: "offline", place: "toolbar" });
      if (!await until(async () => (await block.count()) === 1 && /^Studio Mac is offline/.test((await block.first().textContent()) ?? ""), 10000)) fail(`the composer of a chat of Studio Mac does not say that it is offline in the toolbar's place: ${J(await block.first().textContent().catch(() => null))}`);
      else {
        if (await byTid(page, "block-servers").count() !== 1) fail("the offline notice has no Servers button");
        if (((await box.getAttribute("data-placeholder").catch(() => "")) ?? "") !== "") fail(`the box says ${J(await box.getAttribute("data-placeholder"))} as well as the notice`);
      }
      if (await byTid(page, "remote-bar").count()) fail(`the chat of Studio Mac draws a bar on the phone: "${await textOf(page, "remote-bar")}"`);
      if (J(await messages(page)) !== J(thread)) fail("the thread of the chat of Studio Mac changed or went when it dropped");
      if (await toast.count()) fail(`a toast shows while the server is away: "${await toast.first().innerText()}"`);
      await set(STUDIO, "connected");
      if (!await until(async () => (await byTid(page, "toast", { kind: "back-online" }).count()) === 1 && (await toast.first().innerText()).includes("Studio Mac is back online"), 10000)) fail(`back, the toast says ${J(await toast.first().innerText().catch(() => ""))}, not "Studio Mac is back online"`);
      if (J(await messages(page)) !== J(thread)) fail("the thread of the chat of Studio Mac is not as it was when it came back");
    });

    // ---- this computer drops with a chat of Studio Mac open
    await runPhone(async ({ page, calls }) => {
      const studio = await homeOn(page, STUDIO);
      await openChat(page, `${STUDIO}~c_plain`);
      await threadShown(page);
      await set("local", "unreachable", { detail: "connection refused" });
      if (await byTid(page, "remote-bar").count()) fail(`the chat of Studio Mac has a warning because this computer is away: "${await textOf(page, "remote-bar")}"`);
      const box = byTid(page, "composer-input").first();
      await press(page, box); await page.keyboard.type("while this computer is away");
      if (await box.getAttribute("aria-readonly") === "true") fail("the composer of Studio Mac's chat is read-only because this computer is away");
      const was = calls.length;
      await page.keyboard.press("ControlOrMeta+Enter");
      if (!await until(() => calls.slice(was).some((c) => c.server === STUDIO && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to Studio Mac: ${J(calls.slice(was).map((c) => [c.server, c.method, c.path, c.status]))}`);
      if ((await saved(page)).chat !== `${STUDIO}~c_plain`) fail(`the chat of Studio Mac is not the selection any more: ${J(await saved(page))}`);
      const mine = await homeOn(page, STUDIO);
      if (mine.state !== "list" || mine.word !== "connected" || !mine.rows.length || J(mine.outline) !== J(studio.outline)) fail(`Studio Mac's Home is not as it was while this computer is away: ${J([mine.state, mine.word, mine.outline])}`);
      const gone = await homeOn(page, "local");
      if (gone.state !== "trouble" || gone.card?.word !== "unreachable") fail(`this computer's Home says ${J([gone.state, gone.card])} while it is away, not its problem card`);
      if (gone.rows.length && !gone.stale) fail("this computer's rows are live while it is away");
      await set("local", "connected");
      if (!await until(async () => { const h = await homeOn(page, "local"); return h.state === "list" && h.rows.length > 0 && !h.card; }, 10000)) fail("back, this computer's Home has no rows");
      if (await byTid(page, "toast", { kind: "back-online" }).count()) fail("this computer came back: the toast of the chat of Studio Mac, another server, says it is back online");
    });
    note("a chat of Studio Mac while it drops: no bar, the composer says so, the thread as it was, the back-online toast on return (not when another server returns); on Home: Studio Mac's problem card above its last list faded, this computer's list and word as they were, the chat of this computer open and sending; Studio Mac back with its rows; this computer away with a chat of Studio Mac open and sending, Studio Mac's Home as it was, this computer's card");
  };
  if (layout === "phone") return phoneHalf();
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
    await page.keyboard.press("ControlOrMeta+Enter");
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
    await page.keyboard.press("ControlOrMeta+Enter");
    if (!await until(() => calls.slice(was).some((c) => c.server === STUDIO && c.method === "POST" && /\/chats\/c_plain\/messages(\?|$)/.test(c.path) && c.status === 200), 10000)) fail(`the message was not sent to Studio Mac: ${J(calls.slice(was).map((c) => [c.server, c.method, c.path, c.status]))}`);
    if ((await saved(page)).chat !== `${STUDIO}~c_plain`) fail(`the chat of Studio Mac is not the selection any more: ${J(await saved(page))}`);
    if ((await sideSeen(page, STUDIO)).state !== "Connected" || !(await sideSeen(page, STUDIO)).rows.length) fail("Studio Mac's section is not as it was while this computer is away");
    await set("local", "connected");
    if (!await until(async () => (await sideSeen(page, "local")).rows.length > 0, 10000)) fail("back, this computer's section has no rows");
  });
  note("this computer's section, head and selection as they were while Studio Mac was away; Studio Mac's section as it was while this computer was away; both back with their rows");
}, { viewports, page: false });
