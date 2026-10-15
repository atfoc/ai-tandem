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
// Ports dev/checks/AAC.1-first.mjs (S1, S3) to the new build, at the three viewports (A-SB-03, A-SB-04, A-SC-06, A-SC-13, A-OW-01, A-OW-02, A-OW-04, A-OW-06 to
// A-OW-10, A-OW-13, A-OW-15, A-DL-01's restart question; on the web build every layout has this computer's section, since the test host and the
// app's window have a server of their own). Deviations: the reason is a scrolling text of its own (`side-section-reason`, no `pre` element: its
// text keeps its line breaks); the Servers dialog is a sheet on the phone (`servers-dialog`, rows `servers-row`).
// Besides the old check (A-SB-04, A-ST-03): the sidebar's "+" is titled with the reason while this computer is not connected; the first screen says so and offers nothing.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, touchNow } from "./sel.mjs";
import { section, sectionToggle, sectionsSeen, sideMenu, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const AWAY = "Its chats show when the server is back.";
const REASON = "AI Whiteboard is not set up on this machine.\nSet it up once with: ai-whiteboard remote setup";

await check("AAC.1 this computer's section: first, in each state of its server, and the owner's things", async ({ url, layout, open, fail, note }) => {
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const { callsOf } = await import("../shot.mjs");
  const calls = callsOf(page);
  const HERE = section(page, "local");
  const extra = byTid(HERE, "side-section-extra");
  const set = (state, o = {}) => mockEval(`return setServerState("local", ${J(state)}, ${J(o)});`, url);
  const text = (loc) => loc.first().textContent({ timeout: 2000 }).then((t) => t.replace(/\s+/g, " ").trim(), () => "");
  const shows = async (name, want) => {
    const ok = async () => { const s = await sideSeen(page, "local"); return Object.entries(want).every(([k, v]) => J(s[k]) === J(v)); };
    if (!await until(ok, 10000)) { const s = await sideSeen(page, "local"); fail(`${name}: this computer's section shows ${J(Object.fromEntries(Object.keys(want).map((k) => [k, s[k]])))}, not ${J(want)}`); }
  };
  const buttons = () => byTid(extra, "btn").allTextContents();
  const button = (label) => byTid(extra, "btn").filter({ hasText: label }).first();
  const reason = byTid(HERE, "side-section-reason");
  const plus = byTid(page, "side-new").first();
  const touch = await touchNow(page);
  await byTid(HERE, "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  // (no agent runs: a restart asks nothing. The seed's chat with subagents at work has them done)
  await mockEval('chats.c_nested.subsRunning = 0; send({ type: "chat", chat: chats.c_nested });', url);
  if (!await until(async () => !(await mockEval("return Object.values(chats).some((c) => c.subsRunning || c.working || c.status !== \"ready\");", url)), 5000)) fail("a chat of the seed is at work");
  // the page is not loaded again by any of this: a mark on its window stays
  await page.evaluate(() => { window.__mark = "same page"; });

  // ---- the first, always there
  const order = await sectionsSeen(page);
  if (order[0] !== "local" || order.length < 3) fail(`the sidebar's sections are ${J(order)}: this computer's section is not the first`);
  const first = await sideSeen(page, "local");
  if (J([first.name, first.state, first.tone, first.add, first.menu, first.draggable]) !== J(["This computer", "Connected", "ok", true, false, false])) fail(`this computer's head: ${J([first.name, first.state, first.tone, first.add, first.menu, first.draggable])}`);
  if (first.rows.length < 2) fail(`this computer's section has ${first.rows.length} rows, what lives on this computer`);
  if (await extra.count()) fail("this computer's section says something besides its rows while it is connected and of the app's build");
  if (await plus.isDisabled()) fail("the sidebar's + is off while this computer is connected");
  if (await plus.getAttribute("title") !== "New…") fail(`the sidebar's + is titled "${await plus.getAttribute("title")}" while this computer is connected, not "New…"`); // (A-SB-04)

  // ---- connecting
  await set("connecting");
  await shows("connecting", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });
  if (!await until(() => plus.isDisabled(), 5000)) fail("the sidebar's + is on while this computer is connecting");
  if (await plus.getAttribute("title") !== "New… (this computer's server is not connected)") fail(`the sidebar's + is titled "${await plus.getAttribute("title")}" while this computer is connecting`); // (A-SB-04)
  if (await extra.count()) fail("this computer's section connecting says more than its head");

  // ---- not started: the reason, Retry
  await set("not_started", { detail: REASON });
  await shows("not started", { state: "Not started", tone: "bad", outline: [], lines: [AWAY], add: false });
  if (await text(reason) !== REASON.replace(/\s+/g, " ")) fail(`the reason is "${await text(reason)}"`);
  if (await reason.evaluate((e) => getComputedStyle(e.querySelector("[dir], div") ?? e).whiteSpace) === "nowrap") fail("the reason is not preformatted text");
  if (layout !== "phone") { // the first screen says it too, and offers no chat or whiteboard (A-ST-03; the phone has no Home)
    const home = byTid(page, "home").first();
    if (!await until(async () => ((await text(home)) || "").includes("This computer's server is not connected: chats can be started when it is back."), 5000)) fail(`the first screen of a computer whose server is not started says "${await text(home)}"`);
    if (!await byTid(page, "home-new-chat").first().isDisabled() || !await byTid(page, "home-new-board").first().isDisabled()) fail("the first screen offers a chat or a whiteboard while this computer's server is not started");
  }
  if (J(await buttons()) !== J(["Retry"])) fail(`not started, the section offers ${J(await buttons())}, Retry alone (its log is the app's to open)`);
  if (!await plus.isDisabled()) fail("the sidebar's + is on while this computer is not started");
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await set("not_started", { detail: long });
  if (!await until(async () => (await text(reason)).includes("line 12"), 10000)) fail("a long reason is not shown");
  const shown = (await text(reason));
  if (shown.includes("line 13") || !shown.endsWith("…")) fail(`a reason of 30 lines shows "${shown}", not its first 12 lines and a mark`);
  await set("not_started", { detail: "<img src=x onerror=1>" });
  if (!await until(async () => (await text(reason)).includes("<img"), 10000) || await HERE.locator("img").count()) fail("a reason with markup in it is not shown as text");
  await set("not_started", { detail: REASON });

  // Retry that fails again: the new reason; Retry that works: the section fills
  await mockEval('flags.start = { fail: "the server did not answer within 30 seconds" };', url);
  await press(page, button("Retry"));
  if (!await until(async () => (await text(reason)).includes("did not answer within 30 seconds"), 10000)) fail(`a Retry that failed shows "${await text(reason)}"`);
  await mockEval("delete flags.start;", url);
  await press(page, button("Retry"));
  await shows("after a Retry that worked", { state: "Connected", tone: "ok", lines: [], add: true });
  if (!await until(async () => (await sideSeen(page, "local")).rows.length >= 2, 10000)) fail("after a Retry that worked the section has no rows");
  if (await extra.count()) fail("after a Retry that worked the section still says why it did not start");
  if (await plus.isDisabled()) fail("after a Retry that worked the sidebar's + is off");

  // ---- too old: the version and Restart server; the restart does not load the page again
  await set("too_old", { version: "0.9.1" });
  await shows("too old", { state: "Too old", tone: "bad", outline: [], lines: ["This computer's server is older than the app.", "Version 0.9.1"], add: false });
  if (J(await buttons()) !== J(["Restart server"])) fail(`too old, the section offers ${J(await buttons())}`);
  await mockEval('flags.restart = { delay: 1200, version: "dev" };', url);
  await press(page, button("Restart server"));
  if (!await until(async () => (await text(extra)).includes("Restarting…"), 10000)) fail("Restart server did not say Restarting…");
  if ((await buttons()).length) fail(`while the restart runs the section offers ${J(await buttons())}`);
  await shows("restarted", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => (await sideSeen(page, "local")).rows.length >= 2 && !(await extra.count()), 10000)) fail("after the restart the section is not whole again");
  if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again by the restart");
  await mockEval("delete flags.restart;", url);

  // ---- of another build than the app: one line with its version, Restart server
  await mockEval('flags.hello = { version: "old" }; dropStreams();', url);
  if (!await until(async () => (await text(extra)).includes("another build (old)"), 15000)) fail(`another build: the section says "${await text(extra)}"`);
  if (J(await buttons()) !== J(["Restart server"])) fail(`of another build, the section offers ${J(await buttons())}`);
  if ((await sideSeen(page, "local")).rows.length < 2) fail("of another build, the section has no rows: its server works");
  // agents run: the restart asks first, and the question can be left
  await mockEval('setSession("c_plain", "main", { status: "tool", statusTool: "Bash" });', url);
  await press(page, button("Restart server"));
  const dialog = byTid(page, "confirm-dialog");
  await dialog.waitFor({ timeout: 10000 });
  const asked = await text(dialog);
  if (!asked.includes("Restart ends 1 running agent chat")) fail(`the restart's question is "${asked}"`);
  await page.keyboard.press("Escape");
  if (!await until(async () => !await dialog.count(), 5000)) fail("Esc did not leave the restart's question");
  if (await text(extra).then((t) => t.includes("Restarting"))) fail("a restart that was not confirmed began");
  // confirmed: the restart runs; the build is the app's after it (the hello flag is the seed's way to give the old version: it goes with the restart)
  await mockEval('flags.restart = { delay: 1200, version: "dev" };', url);
  await press(page, button("Restart server"));
  await dialog.waitFor();
  await press(page, dialog.getByText("Restart", { exact: true }).last());
  if (!await until(async () => (await text(extra)).includes("Restarting…"), 10000)) fail("a confirmed restart did not say Restarting…");
  await mockEval("delete flags.hello;", url);
  await shows("restarted from another build", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => !(await extra.count()), 10000)) fail(`after the restart the section says "${await text(extra)}"`);
  await mockEval("delete flags.restart; setSession('c_plain', 'main', { status: 'ready' });", url);

  // ---- a restart that failed: the reason, Retry restarts again
  await mockEval('flags.restart = { fail: "the server stopped while starting\\nlast line of its log", version: "dev" };', url);
  await mockEval('flags.hello = { version: "old" }; dropStreams();', url);
  await byTid(extra, "btn").first().waitFor({ timeout: 15000 });
  await press(page, button("Restart server"));
  if (!await until(async () => (await text(extra)).includes("Restart failed"), 10000)) fail(`a restart that failed says "${await text(extra)}"`);
  const why = await text(reason);
  if (!why.includes("the server stopped while starting") || !why.includes("last line of its log")) fail(`the reason of the failed restart is "${why}"`);
  if (!(await buttons()).includes("Retry")) fail(`a failed restart offers ${J(await buttons())}`);
  await mockEval('flags.restart = { version: "dev" }; delete flags.hello;', url);
  await press(page, button("Retry"));
  await shows("a restart tried again", { state: "Connected", tone: "ok", add: true });
  if (!await until(async () => !(await extra.count()), 10000)) fail(`after Retry the section says "${await text(extra)}"`);
  await mockEval("delete flags.restart;", url);
  await set("connected");

  // ---- the "+" of the head, and of the sidebar's head, make things on this computer
  const menuTexts = async () => (await byTid(page, "menu").last().locator('[data-testid="menu-item"]').allTextContents()).map((t) => t.trim());
  const made = calls.length;
  await sideMenu(page, byTid(HERE, "side-section-head").first(), "New on This computer");
  await byTid(page, "menu").last().waitFor({ timeout: 10000 });
  const items = await menuTexts();
  if (J(items) !== J(["Chat", "Whiteboard", "Group"])) fail(`the section's + offers ${J(items)}`);
  await press(page, byTid(page, "menu").last().locator('[data-testid="menu-item"]', { hasText: "Group" }).first());
  if (!await until(() => calls.slice(made).some((c) => c.server === "local" && c.method === "POST" && c.path === "/api/groups" && c.status === 200), 10000)) fail(`the section's + made no group on this computer: ${J(calls.slice(made).map((c) => [c.server, c.method, c.path]))}`);
  await byTid(HERE, "name-input").waitFor({ timeout: 10000 }).catch(() => fail("the new group is not in rename mode"));
  await page.keyboard.press("Escape");
  await press(page, plus);
  await byTid(page, "menu").last().waitFor({ timeout: 10000 });
  const top = await menuTexts();
  if (J(top) !== J(["New chat", "New whiteboard", "New group"])) fail(`the sidebar's + offers ${J(top)}`);
  await page.keyboard.press("Escape");
  if (!await until(async () => !await byTid(page, "menu").count(), 3000)) await press(page, byTid(page, "overlay-backdrop").last());

  // ---- the collapse is the page's own, under `local`
  await press(page, sectionToggle(page, "local"));
  if (!await until(async () => (await sideSeen(page, "local")).collapsed, 5000)) fail("a click on the head did not collapse this computer's section");
  if (await HERE.locator('[data-testid="side-row"]').count()) fail("a collapsed section draws a row");
  const stored = await page.evaluate(() => localStorage.getItem("aiwb.collapsed"));
  if (J(JSON.parse(stored)) !== J(["local"])) fail(`the collapse is kept as ${stored}, not as ["local"]`);
  if (calls.some((c) => c.method !== "GET" && /collapsed/.test(J(c.body ?? {})))) fail("the collapse was sent to a server");
  await page.reload(); await byTid(page, "side-section").first().waitFor({ state: "attached", timeout: 15000 });
  if (!(await sideSeen(page, "local")).collapsed) fail("after a reload this computer's section is not collapsed");
  await press(page, sectionToggle(page, "local"));
  if (!await until(async () => !(await sideSeen(page, "local")).collapsed, 5000)) fail("a second click did not expand it");
  void touch;

  // ---- the Servers dialog: first, with the owner's things and the MCP listener, and nothing to edit
  const serversDialog = byTid(page, "servers-dialog");
  const openServers = async () => {
    await press(page, byTid(page, "servers-btn").first());
    await serversDialog.waitFor({ timeout: 10000 });
    await byTid(serversDialog, "servers-row").first().waitFor({ timeout: 10000 });
  };
  const closeServers = async () => {
    await page.keyboard.press("Escape");
    if (!await until(async () => !await serversDialog.count(), 5000)) fail("Esc did not close the Servers dialog");
  };
  await openServers();
  const row = byTid(serversDialog, "servers-row").first();
  const rowText = () => text(row);
  const rowButtons = async () => (await row.getByRole("button").allTextContents()).map((t) => t.trim());
  const rowName = await text(byTid(row, "servers-name"));
  if (rowName !== "This computer") fail(`the first row of Servers is "${rowName}"`);
  if (await text(byTid(row, "servers-state")) !== "Connected") fail("its row does not say Connected");
  if (!await until(async () => (await rowText()).includes("MCP listener: http://localhost:6006/mcp (up)"), 10000)) fail(`its row does not tell its MCP listener: "${await rowText()}"`);
  if (J(await rowButtons()) !== J(["Restart server"])) fail(`its row has the buttons ${J(await rowButtons())}: Restart server alone while it works (no Edit, Remove or Test; its log is the app's)`);
  await set("not_started", { detail: REASON });
  if (!await until(async () => J(await rowButtons()) === J(["Restart server", "Retry"]), 10000)) fail(`not started, its row has ${J(await rowButtons())}`);
  if (!(await text(byTid(row, "servers-reason"))).includes("Set it up once with")) fail("not started, its row does not give the reason");
  await press(page, row.getByRole("button", { name: "Retry", exact: true }));
  if (!await until(async () => (await text(byTid(row, "servers-state"))) === "Connected", 10000)) fail("Retry in the Servers dialog did not start the server");
  await closeServers();
  // the listener down is told as down (read when the dialog opens)
  await mockEval("flags.mcp = { up: false };", url);
  await openServers();
  if (!await until(async () => (await text(byTid(serversDialog, "servers-row"))).includes("(down)"), 10000)) fail("the MCP listener that is down is not told as down");
  await mockEval("delete flags.mcp;", url);
  await closeServers();

  note("first of the sections; connecting, not started (the reason as text, twelve lines, Retry that fails and works), too old and of another build (Restart server, the question when agents run, the page not loaded again), a failed restart and its Retry; the +s; the collapse under `local`; the Servers row");
}, { viewports, page: false });
