// This computer's server as the first section of the sidebar, in every state it can be in, through the real page
// (app-as-client-goal.md, 3.1 to 3.7, 4.2, 4.4, 4.7, 4.9 and 7.1).
//
// The app is the client of every server, this computer's included. Its main process finds this computer's server or starts
// it with the server program (`launch -json`), takes its secret from `secret`, and connects as to any other server, over
// HTTPS with the secret and the certificate accepted by its fingerprint. Here the main process is the test host
// (web/dev/host.mjs, with --local-bin), the page is the real page in a headless Chrome (Playwright), and the server is
// the real server program: nothing of the server is simulated except where a state needs a program that cannot be had
// (a server of the build before, a failing start), and then the program the host runs is wrapped (Scratch.wrapper):
// it passes every command to the real server program unless the script says otherwise.
//
// It spends no money: the server runs the stand-in agent internal/agenttest/fake-claude and has no Cursor and no pi. It
// never touches the installed app: the script builds two binaries of the server (two builds, to be of another build than the
// page) and two builds of the page into a temp folder, runs the servers on temp data folders and on free ports (the MCP
// listener too), and stops them at the end. Not part of `npm test`.
//
//   cd web && npm ci && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/localserver.e2e.mjs
//
// Steps:
//   1 a server that was never set up: the page opens at once, this computer's section says "Not started" with the
//     server's own reason, which names the set-up command; its "+" is off; a remote server added in the Servers dialog
//     connects meanwhile, and works; a Retry still fails with the same reason
//   2 the set-up is run by hand, once; Retry (and nothing else, the back-off is long) starts the server: the section
//     fills; the old server list in the data folder is deleted by the new server and not moved; the app's list holds the
//     remote server alone; this computer is in the Servers dialog first, with the MCP listener's state
//   3 the server is killed while the page is open, then stopped by its command: the section says that it is not
//     connected, the app starts it again by itself with the page not loaded again, a chat of this computer on screen
//     is level again, and the remote server's section does not move
//   4 a start that fails (the program says why; its output is no JSON): the section shows the reason and Retry, the other
//     section works, and Retry starts the server once it can
//   5 another build than the page's: the section says so and offers "Restart server", which brings it to the page's build
//     with the page not loaded again; a server too old (a stand-in at feature level 5) and one of the build before (the
//     program says "old build") say "Too old" and are brought to the build by the same restart
//   6 the secret is replaced while the page is open: the stream ends, the app reads the new secret and connects again
//     by itself
//   7 the app quits: the server goes on running
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a screenshot for a
// failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildDist } from "../dev/shot.mjs";
import {
  Scratch, all, finish, holds, hostApp, hostCall, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, parseAppWaits, portFree, serverBinary, sleep, standInAgent, waitFor,
} from "./lib/rig.mjs";

const require = createRequire(import.meta.url);
const { standin } = require("../../desktop/test/conn/standin");

const OUT = makeOut("localserver");

// ---- checks: one line each

let failed = 0, n = 0;
let page = null; // a failed check takes its screenshot and what the page logged since the last check
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  const d = String(seen).replace(/\s+/g, " ").trim();
  if (pass === true) { console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`); }
  else {
    failed++;
    const extra = [];
    if (typeof pass === "string") extra.push(pass);
    if (page) {
      const errs = page.errors.slice(told.errors), reqs = page.failedRequests.slice(told.requests);
      if (errs.length) extra.push(`console: ${errs.slice(-4).join(" ; ")}`);
      if (reqs.length) extra.push(`requests: ${reqs.slice(-6).join(" ; ")}`);
      const file = path.join(OUT, `fail-${n}.png`);
      await page.screenshot({ path: file, timeout: 5000 }).then(() => extra.push(`screenshot ${file}`), () => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  console.log(`# ${name}`);
  try { await fn(); }
  catch (e) {
    console.log(`# ${String(e.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
    await check(`${name}: the step ran to its end`, false, e.message);
    await page?.keyboard.press("Escape").catch(() => {});
  }
}
const one = (o) => JSON.stringify(o);

// ---- the servers, the page's builds and the host

const A_NAME = "This computer", B_NAME = "Studio B";
let bin1 = "", bin2 = "", dist1 = "", dist2 = "";
let S = null, B = null, wrapper = null;
let host = null, hostPort = 0;
let browser = null;
let ENTRY = ""; // B's id in the app's list
let standIn = null;

const LONG = { backoff: [60000], tooOld: 300000 };            // a new try of the app is far off: only Retry is soon
const SHORT = parseAppWaits("backoff=1s");                      // a new try of the app is soon
const aTiming = (t) => ({ ...t, hello: 8000, firstEvent: 8000, launch: 60000, relaunch: 90000 });

/** The app: a host of the page's build `dist`, with this computer's server S (the wrapper program), and B's entry in its list. */
async function startApp(dist, timing) {
  host = await hostFor({ out: OUT, name: "app", local: S, wrapper, extra: { dist, timing: aTiming(timing), ...(hostPort ? { port: hostPort } : {}) } });
  hostPort = host.port;
}
async function stopApp() { await host?.close().catch(() => {}); host = null; }
/** The app again with other waits or another build of the page (the page is loaded anew): the same list, the same port. */
async function restartApp(dist, timing) {
  await stopApp();
  await startApp(dist, timing);
  await page.reload();
  await page.waitForSelector("#root .side-tree", { timeout: 20000 });
}

async function prepare() {
  bin1 = serverBinary(OUT, { version: "e2e-1", name: "aiwb-1" });
  bin2 = serverBinary(OUT, { version: "e2e-2", name: "aiwb-2" });
  dist1 = buildDist(path.join(OUT, "dist-1"), { version: "e2e-1" });
  dist2 = buildDist(path.join(OUT, "dist-2"), { version: "e2e-2" });
  const agent = standInAgent(OUT);
  S = new Scratch({ out: OUT, bin: bin1, agent, tag: "s", name: A_NAME }); // never set up
  B = new Scratch({ out: OUT, bin: bin1, agent, tag: "b", name: B_NAME });
  await B.setUp();
  await B.launch();
  S.port = 0;
  wrapper = S.wrapper();
}

// ---- the page

const sel = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const exact = (s) => new RegExp(`^\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
const menuItem = (p, text) => p.locator(".menu .menu-item", { hasText: exact(text) });
const here = (p = page) => p.locator('.side-section[data-server="local"]');
/** What a section shows: its state, its tone, the lines and the reason in it, its rows, its "+", its buttons. */
const look = (p, selector) => p.evaluate((selector) => {
  const s = document.querySelector(selector);
  if (!s) return null;
  return {
    state: s.querySelector(".side-section-state")?.textContent ?? "", tone: ["ok", "wait", "bad"].find((t) => s.classList.contains(t)) ?? "",
    // (lines: what the section says of its tree; extra: what this computer's section says of its server)
    lines: [...s.querySelectorAll(".side-section-body > .side-section-line")].map((e) => e.textContent?.trim() ?? ""),
    extra: [...s.querySelectorAll(".side-section-extra .side-section-line")].map((e) => e.textContent?.trim() ?? ""), reason: s.querySelector(".side-section-reason")?.textContent ?? "",
    buttons: [...s.querySelectorAll(".side-section-actions button")].map((b) => b.textContent?.trim() ?? ""), rows: s.querySelectorAll(".side-row, .side-group-head").length,
    add: !!s.querySelector(".side-section-head button[title^='New on']"),
  };
}, selector);
const mine = (p = page) => look(p, '.side-section[data-server="local"]');
const theirs = (p = page) => look(p, `.side-section[aria-label="${B_NAME}"]`);
const isState = (words) => async () => (await mine())?.state === words;
const startOf = (words, timeout = 60000) => holds(`this computer's section says "${words}"`, isState(words), { timeout, every: 50 });
const pid = () => host?.client.localInfo()?.pid ?? 0;
const connectedAgain = (what, timeout = 120000) => holds(what, async () => { const l = await mine(); return l?.state === "Connected" && l.extra.length === 0 && l.reason === "" && l.buttons.length === 0; }, { timeout, every: 100 });
const click = async (label) => { await here().locator(".side-section-actions button", { hasText: exact(label) }).click(); };

/** The remote server B is added in the Servers dialog, as a user adds one. */
async function addB() {
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  await dlg.locator("button", { hasText: /^Add server$/ }).click();
  const form = dlg.locator(".servers-form");
  const fields = form.locator(".servers-field input");
  await fields.nth(0).fill(B_NAME);
  await fields.nth(1).fill(`https://127.0.0.1:${B.port}`);
  await fields.nth(2).fill(B.secret);
  await form.locator(".servers-check input").check();
  await form.locator("button", { hasText: /^Test connection$/ }).click();
  const accept = form.locator("button", { hasText: /^Accept fingerprint$/ });
  await accept.waitFor({ timeout: 30000 });
  await accept.click();
  const save = form.locator("button.primary", { hasText: /^Save$/ });
  await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  await save.click();
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(B_NAME) }) });
  const ok = await holds("B's row reads Connected", async () => (await row.locator(".servers-state").innerText()) === "Connected", { timeout: 60000 });
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  ENTRY = ((await hostApp(host, "servers.list")).json?.servers ?? []).find((v) => v.name === B_NAME)?.id ?? "";
  return ok === true && !!ENTRY;
}

// ---- 1: a server that was never set up

async function step1() {
  const t0 = Date.now();
  await startApp(dist1, LONG);
  page = await openHostPage(browser, host, { timeout: 10000, wait: "#root .side-tree" });
  const opened = Date.now() - t0;
  const said = await startOf("Not started");
  const l = await mine();
  await check("1 the window opens at once, with this computer's server not set up: nothing waits for it", opened < 20000 && said === true, `${opened} ms; ${one(l)}`);
  await check("1 this computer's section says \"Not started\" with the reason the server gave, which names the set-up command and the program, and offers Retry",
    said === true && l.tone === "bad" && l.reason.includes("remote setup") && l.reason.includes(bin1) && l.buttons.includes("Retry") && l.rows === 0 && !l.add, one(l));
  await check("1 in a browser there is no server log to open (the app opens it)", !l.buttons.includes("Open server log"), one(l.buttons));
  await check("1 nothing of the server exists: no control socket, no server file, no listener", !fs.existsSync(path.join(S.home, "server.json")) && !fs.existsSync(path.join(S.home, "control.sock")) && (await S.status().then((s) => s.running === null && s.files?.setUp === false, () => false)), "");
  await check("1 the head's \"+\" is off while this computer's server is not connected", (await page.locator("button.icon-btn.new").isDisabled()) === true);
  const home = page.locator("main.home");
  await check("1 the first screen does not offer a chat to make", (await home.locator("button.btn.primary:not([disabled])", { hasText: /New chat/ }).count()) === 0, await home.innerText().catch(() => ""));

  // another server meanwhile: added in the Servers dialog, it connects and works
  const ok = await addB();
  await check("1 a remote server added in the Servers dialog connects while this computer's does not", ok === true && (await theirs())?.state === "Connected", one(await theirs()));
  const head = page.locator(`.side-section[aria-label="${B_NAME}"] .side-section-head`);
  await head.hover();
  await head.locator("button[title^='New on']").click();
  await menuItem(page, "Chat").click();
  const key = await waitFor("the page selects a new chat on B", async () => { const c = (await sel(page)).chat; return c && c.startsWith(`${ENTRY}~`) ? c : null; });
  const made = (await hostCall(host, ENTRY, "GET", `/api/chats/${key.split("~")[1]}`)).status;
  await check("1 B works all the while: a chat is made on it and this computer's section still says \"Not started\"", made === 200 && (await mine())?.state === "Not started", `chat ${key}; B answers ${made}; ${one(await mine())}`);
  const before = (await mine()).reason;
  await click("Retry");
  await sleep(1500);
  const after = await mine();
  await check("1 Retry of a server that is still not set up fails again with the same reason, and the section stays", after.state === "Not started" && after.reason === before, one(after));
}

// ---- 2: the set-up by hand, then Retry

async function step2() {
  // The server list the old server kept in its data folder (a file and a copy set aside): the new server deletes both and moves nothing.
  const list = { version: 1, servers: [{ id: "s_0123456789ab", name: "Old server", address: "https://10.0.0.9:4748", secret: "an-old-secret-of-the-list", selfSigned: true, pin: "AB:CD" }] };
  fs.writeFileSync(path.join(S.home, "servers.json"), JSON.stringify(list), { mode: 0o600 });
  fs.writeFileSync(path.join(S.home, "servers.json.unreadable-20260101"), "not json");
  await S.setUp(); // the command the user runs by hand, once, before the server's first start
  await check("2 the set-up is run by hand once: remote access has its certificate, secret and port", fs.existsSync(path.join(S.home, "remote-cert.pem")) && !!S.secret && !!S.fingerprint, S.port);
  await sleep(2500);
  await check("2 the section does not start the server by itself before its time (the back-off is long): it still says \"Not started\"", (await mine())?.state === "Not started", one(await mine()));
  await click("Retry");
  const up = await connectedAgain("this computer's section is connected after Retry and shows no reason and no button");
  const l = await mine();
  await check("2 Retry starts the server: this computer's section fills", up === true && l.rows === 0 && l.add === true, one(l)); // (a server with nothing on it: no row)
  S.pids.push(pid());
  await waitFor("the head's + is on", async () => !(await page.locator("button.icon-btn.new").isDisabled()));
  const gone = !fs.existsSync(path.join(S.home, "servers.json")) && fs.readdirSync(S.home).every((f) => !f.startsWith("servers.json"));
  const apps = (await hostApp(host, "servers.list")).json?.servers ?? [];
  const stateFile = fs.readFileSync(path.join(host.stateDir, "servers.json"), "utf8");
  await check("2 the old server list was deleted from the data folder by the server and moved nowhere: the app's list holds B alone, and not this computer, its secret or the old entry",
    gone && one(apps.filter((v) => !v.local).map((v) => v.name)) === one([B_NAME]) && !stateFile.includes("Old server") && !stateFile.includes("an-old-secret") && !stateFile.includes(S.secret) && !stateFile.includes('"local"'),
    `data folder: ${one(fs.readdirSync(S.home))}; list ${one(apps.map((v) => v.name))}`);
  const snap = (await hostCall(host, "local", "GET", "/api/state")).json;
  await check("2 the server answers the client API over HTTPS with the secret and serves no list of servers", !!snap && !("servers" in snap) && !("sections" in snap), one(Object.keys(snap ?? {})));
  await check("2 a call without the secret is refused on this computer as from another machine", await refusedWithoutSecret(), "");

  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  const names = await dlg.locator(".servers-name").allInnerTexts();
  const first = dlg.locator(".servers-row").first();
  const mcp = await holds("the dialog shows this computer's MCP listener", async () => /^MCP listener: http:\/\/localhost:\d+\/mcp \(up\)$/.test(((await first.locator(".servers-line", { hasText: /^MCP listener/ }).first().innerText().catch(() => "")) ?? "").trim()), { timeout: 20000 });
  const buttons = await first.locator("button").allInnerTexts();
  await check("2 the Servers dialog lists this computer first, with its state, address, version and the MCP listener's state, and Restart server; it cannot be edited, tested or removed",
    names[0] === A_NAME && names[1] === B_NAME && (await first.locator(".servers-state").innerText()) === "Connected" && mcp === true && buttons.includes("Restart server") && !buttons.some((b) => /Edit|Remove|Test connection/.test(b)),
    `names ${one(names)}; buttons ${one(buttons)}; ${await first.innerText()}`);
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
}

/** The server's client port, asked without the secret and then with a wrong one: both are refused, only hello is answered. */
async function refusedWithoutSecret() {
  const { default: https } = await import("node:https");
  const ask = (p, headers) => new Promise((resolve) => {
    const r = https.request({ host: "127.0.0.1", port: S.port, path: p, headers: { "X-AIWB-Client": "8b0f6c0e-3a55-4a39-9b52-0a5c0ed1d9a1", "X-AIWB-Level": "6", ...headers }, rejectUnauthorized: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", () => resolve(0));
    r.end();
  });
  const results = [await ask("/api/state", {}), await ask("/api/state", { "X-AIWB-Secret": "not-the-secret" }), await ask("/", {}), await ask("/api/hello", {})];
  console.log(`# without the secret: /api/state ${results[0]}, wrong secret ${results[1]}, / ${results[2]}, hello ${results[3]}`);
  return results[0] === 401 && results[1] === 401 && results[2] === 401 && results[3] === 200;
}

// ---- 3: killed while the page is open

async function step3() {
  await restartApp(dist1, SHORT);
  await connectedAgain("this computer's section is connected after the app started anew");
  // a chat of this computer, open
  const had = (await sel(page)).chat ?? null;
  await page.click("button.icon-btn.new");
  await menuItem(page, "New chat").click();
  const chat = await waitFor("the page selects its new chat", async () => { const c = (await sel(page)).chat; return c && c !== had ? c : null; });
  await page.locator(".composer .composer-input").waitFor();
  await page.evaluate(() => { window.__notReloaded = true; });
  const bStates = new Set();
  const watch = setInterval(async () => { const l = await theirs().catch(() => null); if (l) bStates.add(l.state); }, 40);
  try {
    for (const [how, stop] of [["killed", () => process.kill(pid(), "SIGKILL")], ["stopped by its command", () => S.stop()]]) {
      const was = pid();
      await stop();
      const dipped = await holds("this computer's section leaves Connected", async () => (await mine())?.state !== "Connected", { timeout: 30000, every: 20 });
      const dip = await mine();
      const read = await page.locator(".composer .composer-input").getAttribute("aria-readonly").catch(() => null);
      const back = await connectedAgain(`this computer's server, ${how}, is started again by the app and its section is connected`);
      const now = pid();
      S.pids.push(now);
      await check(`3 the server ${how} while the page is open: its section says that it is not connected, and the app starts it again by itself`,
        all(dipped, back) === true && now !== was && now > 0, `during: ${one(dip)}; pid ${was} -> ${now}`);
      const level = await holds("the composer takes text again", async () => (await page.locator(".composer .composer-input").getAttribute("aria-readonly")) !== "true", { timeout: 30000 });
      await check(`3 the page was not loaded again, the chat is still on screen and level with its server (the composer takes text again)`,
        (await page.evaluate(() => window.__notReloaded === true)) && (await sel(page)).chat === chat && level === true, `read-only during: ${read}; ${level}`);
    }
  } finally { clearInterval(watch); }
  await check("3 the remote server's section never moved: it said \"Connected\" at every look of the whole time", one([...bStates]) === one(["Connected"]), one([...bStates]));
}

// ---- 4: a start that fails

async function step4() {
  // an output that is no JSON line is a failed start with a sentence of what was wrong
  wrapper.set({ launch: { stdout: "this is not the line the app waits for\n", code: 0 } }); // (before the server stops: the app starts it again at once)
  await S.stop();
  const bad = await holds("the reason is the sentence about the output", async () => { const x = await mine(); return x?.state === "Not started" && x.reason.length > 0; }, { timeout: 60000 });
  await check("4 a program that prints no line for the app is a failed start with a reason of its own, and Retry", bad === true && (await mine()).buttons.includes("Retry"), one(await mine()));
  wrapper.clear();
  await click("Retry");
  const up0 = await connectedAgain("this computer's section is connected after the start can succeed");
  S.pids.push(pid());
  await check("4 Retry starts the server once it can: the section fills and the reason and buttons are gone", up0 === true, one(await mine()));

  // a start that fails with the server's own words: the reason, as it was given
  const why = "AI Whiteboard: the server was not started\nthe disk of this computer is full\nsecond line of the reason\n";
  wrapper.set({ launch: { stderr: why, code: 1 } });
  await S.stop();
  const said = await startOf("Not started", 60000);
  const l = await mine();
  await check("4 a start that fails: the section says \"Not started\" with the reason the start gave and Retry, and this computer's section has no row", said === true && l.reason.includes("the disk of this computer is full") && l.reason.includes("second line") && l.buttons.includes("Retry") && l.rows === 0, one(l));
  await check("4 no dialog stands in front of the other section, which goes on", (await page.locator(".dialog, [role=dialog]").count()) === 0 && (await theirs())?.state === "Connected", one(await theirs()));
  await click("Retry");
  await sleep(1500);
  await check("4 Retry while the start still fails shows the reason again", (await mine()).state === "Not started" && (await mine()).reason.includes("disk of this computer"), one(await mine()));
  wrapper.clear();
  await click("Retry");
  const up = await connectedAgain("this computer's section is connected after the start can succeed");
  S.pids.push(pid());
  await check("4 Retry starts the server once it can: the section fills and the reason and buttons are gone", up === true, one(await mine()));
}

// ---- 5: builds

async function step5() {
  // the page of another build than the server
  await restartApp(dist2, SHORT);
  const other = await holds("this computer's section says that its server runs another build, and offers Restart server", async () => {
    const l = await mine();
    return l?.state === "Connected" && l.extra.some((x) => x.includes("runs another build (e2e-1)")) && l.buttons.includes("Restart server");
  }, { timeout: 60000 });
  await check("5 the server of another build than the page's is found and kept, not restarted: the section says so and offers Restart server", other === true, one(await mine()));
  await page.evaluate(() => { window.__notReloaded = true; });
  const was = pid();
  wrapper.set({ bin: bin2 }); // the program the app carries is of the page's build
  await click("Restart server");
  const restarting = await holds("the section says Restarting…", async () => (await mine())?.extra.some((x) => x.includes("Restarting")), { timeout: 20000, every: 20 });
  const done = await holds("the section is of the page's build: connected, with no line and no button", async () => { const l = await mine(); return l?.state === "Connected" && l.extra.length === 0 && l.buttons.length === 0; }, { timeout: 120000, every: 100 });
  S.pids.push(pid());
  await check("5 Restart server restarts it on the page's build: the section says \"Restarting…\", then is connected with nothing else, and the page was not loaded again",
    all(restarting, done) === true && pid() !== was && (await page.evaluate(() => window.__notReloaded === true)), `pid ${was} -> ${pid()}; ${one(await mine())}`);
  const version = await versionInDialog();
  await check("5 the Servers dialog shows the server's version, the page's", version === "e2e-2", version);

  // a server too old for the app: a stand-in at feature level 5 stands where the server was
  standIn = await standin({ level: 5, version: "0.9.5", secret: "secret-of-the-old-server" });
  wrapper.set({ bin: bin2, launch: { stdout: JSON.stringify({ state: "running", address: standIn.address, fingerprint: standIn.fingerprint, version: "0.9.5", featureLevel: 5, instanceId: standIn.instanceId, pid: 1, home: S.home }) + "\n" }, secret: standIn.secret });
  await S.stop();
  const old = await holds("this computer's section says Too old, with its version and Restart server", async () => {
    const l = await mine();
    return l?.state === "Too old" && l.tone === "bad" && l.buttons.includes("Restart server") && l.rows === 0 && !l.add;
  }, { timeout: 90000 });
  await check("5 a server too old for the app: this computer's section says \"Too old\" and offers Restart server", old === true, one(await mine()));
  wrapper.set({ bin: bin2 });
  await click("Restart server");
  const fresh = await connectedAgain("the restart brings the server to the build: this computer's section is connected");
  S.pids.push(pid());
  await check("5 Restart server brings the too old server to the app's build", fresh === true && pid() > 1, `pid ${pid()}; ${one(await mine())}`);
  await standIn.close();
  standIn = null;

  // a server of the build before, still running: the program says so, and nothing is started a second time
  wrapper.set({ bin: bin2, launch: { stdout: JSON.stringify({ state: "old_build", version: "0.9.0", featureLevel: 5, pid: 123, home: S.home }) + "\n" } });
  await S.stop();
  const before = await holds("this computer's section says Too old and that an older build runs", async () => {
    const l = await mine();
    return l?.state === "Too old" && l.buttons.includes("Restart server");
  }, { timeout: 90000 });
  await check("5 a server of the build before is found, not started a second time: the section says \"Too old\" and offers Restart server", before === true, one(await mine()));
  wrapper.set({ bin: bin2 });
  await click("Restart server");
  const again = await connectedAgain("the restart starts the new build");
  S.pids.push(pid());
  await check("5 Restart server brings it to the build: this computer's section is connected", again === true, one(await mine()));
}

async function versionInDialog() {
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  const text = await holds("the dialog's first row shows a version", async () => /Version \S+/.test(await dlg.locator(".servers-row").first().innerText()), { timeout: 15000 });
  const v = /Version (\S+)/.exec(await dlg.locator(".servers-row").first().innerText())?.[1] ?? "";
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  return text === true ? v : "";
}

// ---- 6: the secret replaced while open

async function step6() {
  const was = pid();
  const out = execFileSync(bin2, ["secret", "-new", "-home", S.home], { env: S.env, encoding: "utf8" });
  const lost = await holds("this computer's section leaves Connected when its stream is ended by the new secret", async () => (await mine())?.state !== "Connected", { timeout: 30000, every: 20 });
  const back = await connectedAgain("this computer's section is connected again with the new secret, by itself");
  const ok = (await hostCall(host, "local", "GET", "/api/state")).status === 200;
  await check("6 the secret is replaced while the page is open: the stream ends, the app reads the new secret and connects again by itself, with the same server",
    back === true && ok && pid() === was && out.trim().length > 0, `lost: ${lost}; pid ${was} -> ${pid()}`);
  S.secret = out.trim().split("\n").pop().trim();
}

// ---- 7: the app quits

async function step7() {
  const running = pid();
  await stopApp();
  await sleep(500);
  let alive = true;
  try { process.kill(running, 0); } catch { alive = false; }
  const status = await S.status();
  await check("7 the app quits and the server goes on: its process is alive and its listener answers", alive && status.running?.client?.listening === true && !(await portFree(S.port)), `pid ${running}; ${one(status.running?.client)}`);
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await stopApp(); await standIn?.close(); for (const s of [S, B]) if (s) await s.stop(); });
try {
  await prepare();
  console.log(`# S (this computer's server) is not set up, in ${S.home}; B on https://127.0.0.1:${B.port}; files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  await step("1 a server that was never set up", step1);
  if (!ENTRY) throw new Error("B was not added: nothing else can be checked");
  await step("2 the set-up by hand, Retry, the list", step2);
  await step("3 killed and stopped while the page is open", step3);
  await step("4 a start that fails", step4);
  await step("5 builds: another build, too old, the build before", step5);
  await step("6 the secret replaced while open", step6);
  await step("7 the app quits", step7);
  console.log(`# the page's console errors (${page.errors.length}): ${[...new Set(page.errors)].slice(0, 8).join(" ; ") || "none"}`);
  console.log(`# the page's requests that failed (${page.failedRequests.length}): ${[...new Set(page.failedRequests)].slice(0, 12).join(" ; ") || "none"}`);
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopApp();
  await standIn?.close().catch(() => {});
}
for (const s of [S, B]) if (s?.info?.pid && !s.pids.includes(s.info.pid)) s.pids.push(s.info.pid);
const end = S && B ? await finish([S, B]) : { alive: [], free: true };
page = null;
if (S && !(await check("both servers are stopped and their ports are free", end.free && end.alive.length === 0, `ports ${S.port}, ${B.port}; processes left: ${end.alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? `# passed (${n} checks)` : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
