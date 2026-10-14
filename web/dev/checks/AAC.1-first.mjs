// Proves this computer's section (app-as-client-goal.md, 3.2, 3.3, 3.5, 3.6, 4.2, 4.4, 4.7; plan C7): it is the first section
// of the sidebar, always there; in each state of its server it has the head, the words and the tone of any section; and it
// alone says what the app does with its server. Connecting: the head says so and there are no rows. Not started: the reason
// the start gave as plain text, Retry; a Retry that fails again shows the new reason, one that works fills the section. Too
// old, and of another build than the app: Restart server, which asks the app, says "Restarting…", and brings the section back
// without loading the page again; when agents run it asks first. A restart that failed says so, with the reason, and Retry
// restarts again. The "+" of the section's head and of the sidebar's head make things on this computer, and are off while it
// is not connected. Its collapse is the page's own, under `local`. The Servers dialog lists it first, with the owner's
// things and the state of its MCP listener, and no Edit, Remove or Test.
// The page runs over HTTP here, not in the app: "Open server log" is the app's, and is not drawn. What happens to what is open
// when this computer's server drops is AAC.2's, the other servers going on beside it AAC.3's.
import { callsOf, check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const HERE = '.side-section[data-server="local"]';
const AWAY = "Its chats show when the server is back.";
const REASON = "AI Whiteboard is not set up on this machine.\nSet it up once with: ai-whiteboard remote setup";

await check("AAC.1 this computer's section: first, in each state of its server, and the owner's things", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const { ctx, page, errors } = await openPage({ url, browser });
  const calls = callsOf(page);
  const set = (state, o = {}) => mockEval(`return setServerState("local", ${J(state)}, ${J(o)});`, url);
  const text = (sel) => page.locator(sel).first().textContent({ timeout: 2000 }).then((t) => t.replace(/\s+/g, " ").trim(), () => "");
  const shows = async (name, want) => {
    const ok = async () => { const s = await sideSeen(page, "local"); return Object.entries(want).every(([k, v]) => J(s[k]) === J(v)); };
    if (!await until(ok, 10000)) { const s = await sideSeen(page, "local"); fail(`${name}: this computer's section shows ${J(Object.fromEntries(Object.keys(want).map((k) => [k, s[k]])))}, not ${J(want)}`); }
  };
  const buttons = () => page.locator(`${HERE} .side-section-extra .btn`).allTextContents();
  const plus = page.locator(".side-head .icon-btn.new");
  await page.waitForSelector(`${HERE} .side-row`);
  // (no agent runs: a restart asks nothing. The seed's chat with subagents at work has them done)
  await mockEval('chats.c_nested.subsRunning = 0; send({ type: "chat", chat: chats.c_nested });', url);
  if (!await until(async () => !(await mockEval("return Object.values(chats).some((c) => c.subsRunning || c.working || c.status !== \"ready\");", url)), 5000)) fail("a chat of the seed is at work");
  // the page is not loaded again by any of this: a mark on its window stays
  await page.evaluate(() => { window.__mark = "same page"; });

  // ---- the first, always there
  const order = await page.evaluate(() => [...document.querySelectorAll(".side-tree > *")].map((e) => (e.matches(".side-section") ? e.dataset.server : "other")));
  if (order[0] !== "local" || order.length < 3 || order.includes("other")) fail(`the sidebar's parts are ${J(order)}: this computer's section is not the first of sections alone`);
  const first = await sideSeen(page, "local");
  if (J([first.name, first.state, first.tone, first.add, first.menu, first.draggable]) !== J(["This computer", "Connected", "ok", true, false, false])) fail(`this computer's head: ${J([first.name, first.state, first.tone, first.add, first.menu, first.draggable])}`);
  if (first.rows.length < 2) fail(`this computer's section has ${first.rows.length} rows, what lives on this computer`);
  if (await page.locator(`${HERE} .side-section-extra`).count()) fail("this computer's section says something besides its rows while it is connected and of the app's build");
  if (await plus.isDisabled()) fail("the sidebar's + is off while this computer is connected");

  // ---- connecting
  await set("connecting");
  await shows("connecting", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });
  if (!await plus.isDisabled()) fail("the sidebar's + is on while this computer is connecting");
  if (await page.locator(`${HERE} .side-section-extra`).count()) fail("this computer's section connecting says more than its head");

  // ---- not started: the reason, Retry
  await set("not_started", { detail: REASON });
  await shows("not started", { state: "Not started", tone: "bad", outline: [], lines: [AWAY], add: false });
  if (await text(`${HERE} .side-section-reason`) !== REASON.replace(/\s+/g, " ")) fail(`the reason is "${await text(`${HERE} .side-section-reason`)}"`);
  if ((await page.locator(`${HERE} .side-section-reason`).evaluate((e) => e.tagName + getComputedStyle(e).whiteSpace)) !== "PREpre-wrap") fail("the reason is not preformatted text");
  if (J(await buttons()) !== J(["Retry"])) fail(`not started, the section offers ${J(await buttons())}, Retry alone (its log is the app's to open)`);
  if (!await plus.isDisabled()) fail("the sidebar's + is on while this computer is not started");
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await set("not_started", { detail: long });
  if (!await until(async () => (await text(`${HERE} .side-section-reason`)).includes("line 12"), 10000)) fail("a long reason is not shown");
  const shown = (await text(`${HERE} .side-section-reason`));
  if (shown.includes("line 13") || !shown.endsWith("…")) fail(`a reason of 30 lines shows "${shown}", not its first 12 lines and a mark`);
  await set("not_started", { detail: "<img src=x onerror=1>" });
  if (!await until(async () => (await text(`${HERE} .side-section-reason`)).includes("<img"), 10000) || await page.locator(`${HERE} img`).count()) fail("a reason with markup in it is not shown as text");
  await set("not_started", { detail: REASON });

  // Retry that fails again: the new reason; Retry that works: the section fills
  await mockEval('flags.start = { fail: "the server did not answer within 30 seconds" };', url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Retry" }).click();
  if (!await until(async () => (await text(`${HERE} .side-section-reason`)).includes("did not answer within 30 seconds"), 10000)) fail(`a Retry that failed shows "${await text(`${HERE} .side-section-reason`)}"`);
  await mockEval("delete flags.start;", url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Retry" }).click();
  await shows("after a Retry that worked", { state: "Connected", tone: "ok", lines: [], add: true });
  if (!await until(async () => (await sideSeen(page, "local")).rows.length >= 2, 10000)) fail("after a Retry that worked the section has no rows");
  if (await page.locator(`${HERE} .side-section-extra`).count()) fail("after a Retry that worked the section still says why it did not start");
  if (await plus.isDisabled()) fail("after a Retry that worked the sidebar's + is off");

  // ---- too old: the version and Restart server; the restart does not load the page again
  await set("too_old", { version: "0.9.1" });
  await shows("too old", { state: "Too old", tone: "bad", outline: [], lines: ["This computer's server is older than the app.", "Version 0.9.1"], add: false });
  if (J(await buttons()) !== J(["Restart server"])) fail(`too old, the section offers ${J(await buttons())}`);
  await mockEval('flags.restart = { delay: 1200, version: "dev" };', url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Restart server" }).click();
  if (!await until(async () => (await text(`${HERE} .side-section-extra`)).includes("Restarting…"), 10000)) fail("Restart server did not say Restarting…");
  if ((await buttons()).length) fail(`while the restart runs the section offers ${J(await buttons())}`);
  await shows("restarted", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => (await sideSeen(page, "local")).rows.length >= 2 && !(await page.locator(`${HERE} .side-section-extra`).count()), 10000)) fail("after the restart the section is not whole again");
  if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again by the restart");
  await mockEval("delete flags.restart;", url);

  // ---- of another build than the app: one line with its version, Restart server
  await mockEval('flags.hello = { version: "old" }; dropStreams();', url);
  if (!await until(async () => (await text(`${HERE} .side-section-extra`)).includes("another build (old)"), 15000)) fail(`another build: the section says "${await text(`${HERE} .side-section-extra`)}"`);
  if (J(await buttons()) !== J(["Restart server"])) fail(`of another build, the section offers ${J(await buttons())}`);
  if ((await sideSeen(page, "local")).rows.length < 2) fail("of another build, the section has no rows: its server works");
  // agents run: the restart asks first, and the question can be left
  await mockEval('setSession("c_plain", "main", { status: "tool", statusTool: "Bash" });', url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Restart server" }).click();
  await page.waitForSelector(".dialog", { timeout: 10000 });
  const asked = await text(".dialog");
  if (!asked.includes("Restart ends 1 running agent chat")) fail(`the restart's question is "${asked}"`);
  await page.keyboard.press("Escape");
  if (!await until(async () => !await page.locator(".dialog").count(), 5000)) fail("Esc did not leave the restart's question");
  if (await text(`${HERE} .side-section-extra`).then((t) => t.includes("Restarting"))) fail("a restart that was not confirmed began");
  // confirmed: the restart runs; the build is the app's after it (the hello flag is the seed's way to give the old version: it goes with the restart)
  await mockEval('flags.restart = { delay: 1200, version: "dev" };', url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Restart server" }).click();
  await page.waitForSelector(".dialog");
  await page.locator(".dialog .btn", { hasText: "Restart" }).last().click();
  if (!await until(async () => (await text(`${HERE} .side-section-extra`)).includes("Restarting…"), 10000)) fail("a confirmed restart did not say Restarting…");
  await mockEval("delete flags.hello;", url);
  await shows("restarted from another build", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => !(await page.locator(`${HERE} .side-section-extra`).count()), 10000)) fail(`after the restart the section says "${await text(`${HERE} .side-section-extra`)}"`);
  await mockEval("delete flags.restart; setSession('c_plain', 'main', { status: 'ready' });", url);

  // ---- a restart that failed: the reason, Retry restarts again
  await mockEval('flags.restart = { fail: "the server stopped while starting\\nlast line of its log", version: "dev" };', url);
  await mockEval('flags.hello = { version: "old" }; dropStreams();', url);
  await page.waitForSelector(`${HERE} .side-section-extra .btn`);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Restart server" }).click();
  if (!await until(async () => (await text(`${HERE} .side-section-extra`)).includes("Restart failed"), 10000)) fail(`a restart that failed says "${await text(`${HERE} .side-section-extra`)}"`);
  const why = await text(`${HERE} .side-section-reason`);
  if (!why.includes("the server stopped while starting") || !why.includes("last line of its log")) fail(`the reason of the failed restart is "${why}"`);
  if (!(await buttons()).includes("Retry")) fail(`a failed restart offers ${J(await buttons())}`);
  await mockEval('flags.restart = { version: "dev" }; delete flags.hello;', url);
  await page.locator(`${HERE} .side-section-extra .btn`, { hasText: "Retry" }).click();
  await shows("a restart tried again", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => !(await page.locator(`${HERE} .side-section-extra`).count()), 10000)) fail(`after Retry the section says "${await text(`${HERE} .side-section-extra`)}"`);
  await mockEval("delete flags.restart;", url);
  await set("connected");

  // ---- the "+" of the head, and of the sidebar's head, make things on this computer
  const head = page.locator(`${HERE} > .side-section-head`);
  await head.hover();
  await head.locator('button[title="New on This computer"]').click();
  const items = await page.locator(".menu .menu-item").allTextContents();
  if (J(items.map((t) => t.trim())) !== J(["Chat", "Whiteboard", "Group"])) fail(`the section's + offers ${J(items)}`);
  const made = calls.length;
  await page.locator(".menu .menu-item", { hasText: "Group" }).click();
  if (!await until(() => calls.slice(made).some((c) => c.server === "local" && c.method === "POST" && c.path === "/api/groups" && c.status === 200), 10000)) fail(`the section's + made no group on this computer: ${J(calls.slice(made).map((c) => [c.server, c.method, c.path]))}`);
  await page.keyboard.press("Escape");
  await plus.click();
  const top = await page.locator(".side-head .menu .menu-item").allTextContents();
  if (J(top.map((t) => t.trim())) !== J(["New chat", "New whiteboard", "New group"])) fail(`the sidebar's + offers ${J(top)}`);
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 400);

  // ---- the collapse is the page's own, under `local`
  await head.click();
  if (!await until(async () => (await sideSeen(page, "local")).collapsed, 5000)) fail("a click on the head did not collapse this computer's section");
  if (await page.locator(`${HERE} .side-row`).count()) fail("a collapsed section draws a row");
  const stored = await page.evaluate(() => localStorage.getItem("aiwb.collapsed"));
  if (J(JSON.parse(stored)) !== J(["local"])) fail(`the collapse is kept as ${stored}, not as ["local"]`);
  if (calls.some((c) => c.method !== "GET" && /collapsed/.test(J(c.body ?? {})))) fail("the collapse was sent to a server");
  await page.reload(); await page.waitForSelector(`${HERE}`);
  if (!(await sideSeen(page, "local")).collapsed) fail("after a reload this computer's section is not collapsed");
  await page.locator(`${HERE} > .side-section-head`).click();
  if (!await until(async () => !(await sideSeen(page, "local")).collapsed, 5000)) fail("a second click did not expand it");

  // ---- the Servers dialog: first, with the owner's things and the MCP listener, and nothing to edit
  await page.locator(".side-foot .servers-btn").click();
  await page.waitForSelector('.servers-dialog[role="dialog"] .servers-row');
  const row = page.locator(".servers-dialog .servers-row").first();
  if ((await row.locator(".servers-name").textContent()) !== "This computer") fail(`the first row of Servers is "${await row.locator(".servers-name").textContent()}"`);
  if ((await row.locator(".servers-state").textContent()) !== "Connected") fail("its row does not say Connected");
  if (!await until(async () => (await row.textContent()).includes("MCP listener: http://localhost:6006/mcp (up)"), 10000)) fail(`its row does not tell its MCP listener: "${await row.textContent()}"`);
  const rowButtons = (await row.locator("button").allTextContents()).map((t) => t.trim());
  if (J(rowButtons) !== J(["Restart server"])) fail(`its row has the buttons ${J(rowButtons)}: Restart server alone while it works (no Edit, Remove or Test; its log is the app's)`);
  await set("not_started", { detail: REASON });
  if (!await until(async () => J((await row.locator("button").allTextContents()).map((t) => t.trim())) === J(["Restart server", "Retry"]), 10000)) fail(`not started, its row has ${J(await row.locator("button").allTextContents())}`);
  if (!(await row.locator(".servers-reason").textContent()).includes("Set it up once with")) fail("not started, its row does not give the reason");
  await row.locator(".btn", { hasText: "Retry" }).click();
  if (!await until(async () => (await row.locator(".servers-state").textContent()) === "Connected", 10000)) fail("Retry in the Servers dialog did not start the server");
  await page.keyboard.press("Escape");
  // the listener down is told as down (read when the dialog opens)
  await mockEval("flags.mcp = { up: false };", url);
  await page.locator(".side-foot .servers-btn").click();
  await page.waitForSelector('.servers-dialog[role="dialog"] .servers-row');
  if (!await until(async () => (await page.locator(".servers-dialog .servers-row").first().textContent()).includes("(down)"), 10000)) fail("the MCP listener that is down is not told as down");
  await mockEval("delete flags.mcp;", url);
  await page.keyboard.press("Escape");

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note("first of the sections; connecting, not started (the reason as text, twelve lines, Retry that fails and works), too old and of another build (Restart server, the question when agents run, the page not loaded again), a failed restart and its Retry; the +s; the collapse under `local`; the Servers row");
});
