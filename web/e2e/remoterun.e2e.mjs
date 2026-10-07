// A remote run through the real page (plans/multiple-remote-servers.md, phase 9).
//
// A remote run is a run (a multi-agent job) that works on another AI Whiteboard server and shows
// in this one's sidebar. The Go tests show that with two scratch servers and no page; this script
// shows it with the page itself in a headless Chrome (Playwright): two scratch servers, A (the
// local one, whose page is driven) and B (the remote one, reached through its remote listener).
//
// It spends no money: both servers run the stand-in agent internal/agenttest/fake-claude and have
// no Cursor and no pi; the run's goal carries the stand-in's directives, so the run adds one task
// that writes a file and then ends as achieved. It never touches the installed app: the script
// builds its own binary into a temp folder, runs both servers on temp data folders and on free
// ports, and stops them at the end. Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/remoterun.e2e.mjs
//
// Steps (the page is A's):
//   1 add B in the Servers dialog
//   2 "New run"; B is picked in the composer's server choice: the agents and models are B's,
//     and the run bar no longer offers "+ Chat on this run" (it does again once the run started)
//   3 B's repository is picked in the folder picker: the chip says "git" and names B
//   4 the goal, Enter: the row shows the run with B's name, turn 1 shows in the timeline
//   5 the orchestrator's transcript ("Transcript ›") has text
//   6 B is restarted while the task works: the row turns "not connected" and back, and the run
//     ends on the page with no reload and no click; the dock's Goal tab, read before the restart,
//     shows its text and not "Loading…"; B's repository has the result on main
//   7 "+" on the run and a first message in that chat: answered, on B, in the run's folder
//   8 B stops: the row is off, the detail keeps what it had with the bar, "Delete" offers
//     "Remove from this sidebar only" (not taken); B is started again
//   9 the run is deleted: the row goes, B answers 404 for it
//   FS the start of another run while B does not answer for the whole wait (45 s): the line says
//     it is not known whether the run started; B goes on, and with no click the run shows as
//     started, the line is gone, and B has the run once
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = path.resolve(process.env.AIWB_E2E_CLIENT || path.join(repo, "web/dist"));

// Everything the run makes: the binary, both servers' folders, the logs, screenshots.
// realpath: on macOS the temp folder is a symlink, and the server reports folders resolved.
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-remoterun-")));
const BIN = path.resolve(process.env.AIWB_E2E_BIN || path.join(OUT, "aiwb"));
const FAKE = path.join(OUT, "bin", "fake-claude");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, { timeout = 15000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = "threw: " + e.message; }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(every);
  }
}
/** true when fn turned true in time, else the sentence of what was last seen. */
const holds = (what, fn, o) => waitFor(what, fn, o).then(() => true, (e) => e.message);

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null; // A's page: a failed check takes its screenshot and what it logged since the last check
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
      await page.screenshot({ path: file }).then(() => extra.push(`screenshot ${file}`), () => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) { await check(`${name}: the step ran to its end`, false, e.message); await page?.keyboard.press("Escape").catch(() => {}); }
}

// ---- the two scratch servers

function freePort() {
  return new Promise((resolve, reject) => {
    const l = net.createServer();
    l.once("error", reject);
    l.listen(0, "127.0.0.1", () => { const { port } = l.address(); l.close(() => resolve(port)); });
  });
}
function portFree(port) {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    c.once("connect", () => { c.destroy(); resolve(false); });
    c.once("error", () => resolve(true));
  });
}

const scratch = (tag, name) => ({
  tag, name, home: path.join(OUT, tag, "home"), work: path.join(OUT, tag, "work"), cursorCfg: path.join(OUT, tag, "cursor-config"),
  log: path.join(OUT, `server-${tag}.log`), port: 0, remotePort: 0, base: "", proc: null, pids: [],
});
const A = scratch("a", "This computer"); // the local server: the page is its
const B = scratch("b", "Studio B");      // the remote one, an entry of A's server list; its work folder is the run's repository
const B_ONLY = "only-on-b";              // a folder in B's work folder: the folder picker must list it

// git for B's repository, away from the user's and the system's config.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (dir, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const envOf = (s) => ({ ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: s.cursorCfg });

async function prepare() {
  fs.mkdirSync(path.dirname(FAKE), { recursive: true });
  if (!process.env.AIWB_E2E_BIN) execFileSync("go", ["build", "-o", BIN, "./cmd/ai-whiteboard"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  fs.copyFileSync(path.join(repo, "internal/agenttest/fake-claude"), FAKE);
  fs.chmodSync(FAKE, 0o755);
  for (const s of [A, B]) {
    for (const d of [s.home, s.work, s.cursorCfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(s.work, "README.md"), `scratch ${s.tag}\n`);
    s.port = await freePort();
    s.base = `http://127.0.0.1:${s.port}`;
  }
  fs.mkdirSync(path.join(B.work, B_ONLY));
  fs.writeFileSync(path.join(B.work, B_ONLY, "note.txt"), "a folder of B\n");
  // B's work folder is a git repository with one commit on main: the run delivers its result there.
  git(B.work, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Run Tester"], ["user.email", "run-tester@localhost"], ["commit.gpgsign", "false"]]) git(B.work, "config", k, v);
  git(B.work, "add", "-A");
  git(B.work, "commit", "-q", "-m", "start");
  // B's remote listener: the certificate, secret and port are made before its start. The command
  // names the data folder and both ports, so it cannot reach the installed app. It prints the
  // fingerprint; the secret it writes to a file of the data folder and does not print.
  B.remotePort = await freePort();
  const out = execFileSync(BIN, ["remote", "setup", "-home", B.home, "-server-port", String(B.port), "-port", String(B.remotePort), "-name", "127.0.0.1"],
    { env: envOf(B), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  B.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(out)?.[1] ?? "";
  B.secret = fs.readFileSync(path.join(B.home, "remote-secret"), "utf8").trim();
  if (!B.fingerprint || !B.secret) throw new Error(`remote setup gave no fingerprint or no secret: ${out}`);
}

async function start(s) {
  const fd = fs.openSync(s.log, "a");
  const p = spawn(BIN, ["serve", "-home", s.home, "-port", String(s.port), "-client", CLIENT, "-cwd", s.work,
    "-claude", FAKE, "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"],
    { cwd: s.work, env: envOf(s), stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  s.proc = { p, exited: new Promise((r) => p.once("exit", r)) };
  s.pids.push(p.pid);
  await waitFor(`server ${s.tag} answers /api/hello`, async () => {
    if (p.exitCode !== null) throw new Error(`server ${s.tag} exited with ${p.exitCode}`);
    return (await fetch(`${s.base}/api/hello`, { signal: AbortSignal.timeout(1000) })).ok;
  }, { timeout: 20000 });
}

async function stop(s) {
  if (!s.proc) return;
  const { p, exited } = s.proc;
  s.proc = null;
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(15000).then(() => false)])) return;
  p.kill("SIGKILL");
  await exited;
}

const get = async (s, p) => { const r = await fetch(s.base + p, { signal: AbortSignal.timeout(5000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const stateOf = async (s) => (await get(s, "/api/state")).json;
const chatOn = async (s, id) => (await stateOf(s))?.chats?.find((c) => c.id === id) ?? null;
/** The user messages of a chat, as B's own loopback API gives them. */
const userTexts = async (s, id) => ((await get(s, `/api/chats/${id}/items`)).json?.items ?? []).filter((it) => it.kind === "user").map((it) => String(it.text ?? ""));
/** B's entry in A's server list. */
const entry = async () => ((await get(A, "/api/servers")).json?.servers ?? []).find((v) => v.name === B.name) ?? null;
const connected = (timeout) => holds("A is connected to B", async () => (await entry())?.state === "connected", { timeout, every: 250 });

// ---- the page

let browser = null;
// openPage opens A's app in a context of its own and keeps what its console says. errors: console
// errors and uncaught exceptions; failedRequests: requests that failed or were answered with 400 or more.
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.errors = [];
  p.failedRequests = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(`uncaught: ${e.message}`));
  p.on("requestfailed", (r) => p.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  p.on("response", (r) => { if (r.status() >= 400) p.failedRequests.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`); });
  await p.goto(A.base);
  await p.waitForSelector("#root *", { timeout: 15000 });
  return p;
}
const sel = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const menuItem = (p, text) => p.locator(".menu .menu-item", { hasText: text });
const rowLook = async (row) => ({ cls: (await row.getAttribute("class").catch(() => null)) ?? "no row", sub: await row.locator(".side-sub").innerText().catch(() => ""), title: (await row.getAttribute("title").catch(() => "")) ?? "" });
const one = (o) => JSON.stringify(o);
const box = (p) => p.locator(".composer .composer-input");
const boxText = (p) => box(p).evaluate((el) => ("value" in el ? el.value : el.innerText));
const serverChip = (p) => p.locator(".composer .server-pick button.tchip");
const msgs = async (p) => ({ user: await p.locator(".thread .msg.user").allInnerTexts(), assistant: await p.locator(".thread .msg.assistant").allInnerTexts() });
const counts = (m) => `${m.user.length} user, ${m.assistant.length} assistant`;
const replied = (p, text, timeout = 20000) => holds(`the reply to "${text}"`, async () => (await msgs(p)).assistant.some((t) => t.includes(`): ${text}`) || t.includes(text)), { timeout });

async function pickServer(p, name) {
  await p.locator('.composer button.tchip[title^="Server"]').click();
  await p.locator('.composer .server-pick [role="option"]', { hasText: name }).click();
  await waitFor(`the server chip shows ${name}`, async () => (await serverChip(p).innerText()).includes(name));
}
async function send(p, text) {
  await box(p).click();
  await box(p).fill(text);
  await box(p).press("Enter");
}
async function rowMenu(p, row, item) {
  await row.hover();
  await row.locator('button.side-hover[title="More"]').click();
  await p.locator(".menu .menu-item", { hasText: new RegExp(`^\\s*${item}\\s*$`) }).click();
}

// ---- the run: its goal for the stand-in agent, and what B says about it

const RUN_FILE = "result.txt", RUN_TEXT = "written by the run";
const TASK_SLEEP = 8; // seconds the task's agent waits before it writes, every time it is launched: B is restarted in that time
const FIRST_LINE = "Write the result file.";
/** The goal: turn 1 sets the notes and adds one writing task; the turn that starts when nothing
 *  is left running finishes the run as achieved. As apiGoal of cmd/ai-whiteboard/apiruns_test.go. */
function goal() {
  const brief = `Write ${RUN_FILE}, and change nothing else. <<if You have one task.>> <<sleep ${TASK_SLEEP}>> <<write ${RUN_FILE} ${RUN_TEXT}>> <<cost 0.01>> <<block completed>>`;
  const task = JSON.stringify({ brief, kind: "implement", tier: "standard", tier_reason: "A later task checks it.", title: "Write the file", writes: true });
  if (task.includes("]]")) throw new Error("the task's arguments would end the directive early");
  return `${FIRST_LINE} [[if This is turn 1.]] [[mcp set_notes {"notes":"Done means: the file is written. T01 writes it."}]] [[mcp add_task ${task}]] ` +
    `[[if Nothing is running and nothing can start]] [[mcp finish_run {"outcome":"achieved","summary":"Everything the goal asked for is there."}]] [[if]]`;
}
const runOn = async (s, id) => (await stateOf(s))?.runs?.find((r) => r.id === id) ?? null;
const detailOn = async (s, id) => (await get(s, `/api/runs/${id}/detail`)).json;
const runRow = (p) => p.locator(`.side-row.is-run`).filter({ has: p.locator(".side-name", { hasText: new RegExp(`^${RUN_NAME}$`) }) });
const RUN_NAME = "Remote result";
const runBox = (p) => p.locator(".composer.run-composer .composer-input");
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const barChat = (p) => p.locator(".run-bar button.run-bar-chat"); // the run bar's "+ Chat on this run"
const dockTab = (p, tab) => p.locator(`.run-follow .dock-tabs [data-tab="${tab}"]`);
/** What the dock's Goal tab shows: whether it is on screen, whether it says "Loading…", and its text. */
const goalTab = async (p) => ({ tabs: await p.locator(".run-follow .run-goal-tab").count(), loading: await p.locator(".run-goal-tab .rd-loading").count(), text: short(await p.locator(".run-goal-tab .rd-text").innerText().catch(() => ""), 80) });
const START_UNKNOWN = `${B.name} did not answer: it is not known whether the run started. Start again: it starts only once.`;

// ---- the steps

let run = "", runChat = "", run2 = "";

async function step1() {
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  await dlg.locator("button", { hasText: /^Add server$/ }).click();
  const form = dlg.locator(".servers-form");
  const fields = form.locator(".servers-field input");
  await fields.nth(0).fill(B.name);
  await fields.nth(1).fill(`https://127.0.0.1:${B.remotePort}`);
  await fields.nth(2).fill(B.secret);
  await form.locator(".servers-check input").check();
  await form.locator("button", { hasText: /^Test connection$/ }).click();
  const accept = form.locator("button", { hasText: /^Accept fingerprint$/ });
  await accept.waitFor();
  const shown = (await form.locator(".servers-result .servers-fp").last().innerText()).trim();
  await check("1 the form shows the fingerprint that `remote setup` printed", shown === B.fingerprint, `shown ${shown}, printed ${B.fingerprint}`);
  await accept.click();
  const save = form.locator("button.primary", { hasText: /^Save$/ });
  await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  await save.click();
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: new RegExp(`^${B.name}$`) }) });
  const state = row.locator(".servers-state");
  const ok = await holds("the row reads Connected", async () => (await state.innerText()) === "Connected", { timeout: 20000 });
  await check('1 B is added in the Servers dialog and its row reads "Connected"', ok, `row: ${(await row.innerText().catch(() => "no row")).replace(/\n/g, " / ")}`);
  await check("1 A's server list has B as connected", (await entry())?.state === "connected", one(await entry()).slice(0, 200));
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
}

async function step2() {
  const before = new Set(((await stateOf(A)).runs ?? []).map((r) => r.id));
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New run\s*$/).click();
  run = await waitFor("the page selects its new run", async () => { const r = (await sel(page)).run; return r && !before.has(r) ? r : null; });
  await runBox(page).waitFor();
  const local = (await serverChip(page).innerText()).replace(/\s+/g, " ").trim();
  await check('2 "New run" makes a draft run whose server choice reads "This computer"', local.includes(A.name) && (await runOn(A, run))?.status === "draft" && !(await runOn(A, run))?.server,
    `chip "${local}"; A's run: ${one(await runOn(A, run)).slice(0, 200)}`);
  const offeredHere = await barChat(page).count();

  await pickServer(page, B.name);
  const e = await entry();
  const onB = await holds("the run is on B's entry in A's state", async () => !!e && (await runOn(A, run))?.server === e.id);
  await check("2 B is picked in the composer's server choice: the chip shows its name and A's run has B's entry", onB, `chip "${short(await serverChip(page).innerText())}"; A's run: server ${one((await runOn(A, run))?.server ?? null)}`);

  const gone = await holds('the bar has no "+ Chat on this run"', async () => (await barChat(page).count()) === 0, { timeout: 5000 });
  await check(`2 the run bar offers "+ Chat on this run" for the draft on this computer and no longer with ${B.name} picked`, offeredHere === 1 && gone === true && (await page.locator(".run-bar").count()) === 1,
    `buttons on this computer ${offeredHere}; with ${B.name} picked ${await barChat(page).count()}; run bars ${await page.locator(".run-bar").count()}`);

  const agentChip = page.locator('.composer button.tchip[title^="Agent"]');
  await agentChip.click();
  const options = page.locator('.composer .menu [role="option"]');
  await options.first().waitFor();
  const listed = (await options.allInnerTexts()).map((t) => short(t));
  const offered = e?.agents ?? [];
  await check("2 the agent choice lists B's agents", listed.length === offered.length && listed.length > 0 && listed.every((t) => /Claude/.test(t)), `listed: ${listed.join(", ")}; B's entry: ${offered.join(", ")}`);
  await options.first().click();

  // The models: the picker of the first tier lists the models of B's catalog (B's own GET /api/state has it).
  const cat = ((await stateOf(B))?.catalogs ?? (await stateOf(B))?.catalog ?? {});
  const models = (cat.claude?.models ?? []).map((m) => m.label);
  await page.locator('.composer button.tchip[title^="Models"]').click();
  const tiers = page.locator(".composer .run-tiers");
  await tiers.waitFor();
  await tiers.locator('.run-tier[data-tier="deep"] button.tchip').first().click();
  const mopts = tiers.locator('[role="option"]');
  await mopts.first().waitFor();
  const mlisted = (await mopts.allInnerTexts()).map((t) => short(t));
  await check("2 the models of a tier are the models of B's catalog", models.length > 0 && mlisted.length === models.length && models.every((m, i) => mlisted[i].includes(m)),
    `listed: ${mlisted.join(", ")}; B's catalog: ${models.join(", ")}`);
  // Both menus are closed again, the inner one first.
  for (let i = 0; i < 3 && (await page.locator(".menu-backdrop, .composer .run-tiers").count()) > 0; i++) await page.keyboard.press("Escape");
  await tiers.waitFor({ state: "detached" });
}

async function step3() {
  const folder = page.locator('.composer button.tchip[title^="Folder on"]');
  await folder.click();
  const dirs = page.locator(".composer .menu.dirs");
  const head = (await dirs.locator(".menu-head").textContent()) ?? ""; // not innerText: the head is drawn in capitals
  await dirs.locator(".dir-input").fill(B.work);
  await dirs.locator(".dir-input").press("Enter");
  const there = await holds("the picker lists the folder made in B's repository", async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(B_ONLY)));
  await check(`3 the folder picker is titled "Folder on ${B.name}" and lists folders of B's machine`, head.trim() === `Folder on ${B.name}` && there === true,
    `head "${head.trim()}"; listed: ${(await dirs.locator(".dir-list").innerText().catch(() => "")).replace(/\n/g, ", ")}`);
  await dirs.locator(".dir-foot button").click();
  const picked = await holds("the run's folder is B's repository", async () => { const r = await runOn(A, run); return r?.cwd === B.work && r?.git === true; });
  await check("3 B's repository is picked: A's run has the folder, as a git folder", picked, `A's run: cwd ${one((await runOn(A, run))?.cwd)}, git ${one((await runOn(A, run))?.git ?? null)}`);
  const chip = page.locator(".composer.run-composer .context-row .ctx-chip");
  const text = short(await chip.innerText().catch(() => "no chip")), git = short(await chip.locator(".git").innerText().catch(() => ""));
  await check(`3 the chip above the box says "git" and names ${B.name}`, git === "git" && text.includes(` on ${B.name}`) && !/\bmissing\b/.test((await chip.getAttribute("class")) ?? ""),
    `chip "${text}", title "${await chip.getAttribute("title").catch(() => "")}"`);
}

async function step4() {
  // The run's name first, so that its row can be found by name.
  const row0 = page.locator(".side-row.is-run.on");
  await row0.hover();
  await row0.locator('button.side-hover[title="More"]').click();
  await menuItem(page, /^\s*Rename\s*$/).click();
  const input = page.locator(".side-run .name-input, .side-row.is-run .name-input, .side-row.is-run input").first();
  await input.fill(RUN_NAME);
  await input.press("Enter");
  await waitFor(`the run is named ${RUN_NAME}`, async () => (await runOn(A, run))?.name === RUN_NAME);
  const row = runRow(page);
  await row.waitFor();

  await runBox(page).click();
  await runBox(page).fill(goal());
  const send = page.locator(".composer.run-composer button.send");
  const can = await holds("Send is enabled", async () => !(await send.isDisabled()), { timeout: 5000 });
  if (can !== true) await check("4 Send is enabled with the goal typed", false, `title "${await send.getAttribute("title")}"; line "${short(await page.locator(".composer-err, .run-note").allInnerTexts())}"`);
  await runBox(page).press("Enter");

  const started = await holds("the run is running in A's list", async () => { const r = await runOn(A, run); return !!r && r.status !== "draft"; }, { timeout: 30000 });
  const id = (await sel(page)).run; // the same id, unless B had it already
  if (id && id !== run && started !== true) run = id;
  const look = await holds("the row shows B's name", async () => (await rowLook(row)).sub.endsWith(`· ${B.name}`), { timeout: 15000 });
  await check("4 the goal is sent with Enter: the row shows the run with B's name", started === true && look === true, `${started === true ? "" : started + "; "}row ${one(await rowLook(row))}; line "${short(await page.locator(".composer-err, .run-note").allInnerTexts())}"`);
  const bar = page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]');
  const turn = await bar.waitFor({ timeout: 20000 }).then(() => true, (e) => e.message.split("\n")[0]);
  await check("4 turn 1 shows in the timeline", turn, `timeline: ${short(await page.locator(".run-follow .tl").innerText().catch(() => "none"), 200)}`);
  const chatBtn = await holds('the bar offers "+ Chat on this run"', async () => (await barChat(page).count()) === 1, { timeout: 5000 });
  await check('4 the started run\'s bar offers "+ Chat on this run"', chatBtn, `buttons ${await barChat(page).count()}: "${short(await barChat(page).first().innerText().catch(() => ""))}"`);
  const there = await runOn(B, run), own = await get(B, `/api/runs/${run}`);
  await check("4 B's own API has the run under the same id, in the picked folder, not a draft", !!there && there.status !== "draft" && there.cwd === B.work && own.status === 200 && own.json?.id === run && !there.server,
    `B's state: ${one(there && { id: there.id, status: there.status, cwd: there.cwd, server: there.server ?? null })}; GET /api/runs/${run} -> ${own.status}`);
  const mine = await runOn(A, run);
  await check("4 A lists the run with B's entry and holds no folder of its own for it", mine?.server === (await entry())?.id && !fs.existsSync(path.join(A.home, "runs", run)),
    `A's run: server ${one(mine?.server ?? null)}; ${path.join(A.home, "runs", run)} exists: ${fs.existsSync(path.join(A.home, "runs", run))}`);
}

async function step5() {
  await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').click();
  const pane = page.locator('.run-follow .run-turn[data-turn="1"]');
  await pane.waitFor();
  const link = pane.locator("button.link", { hasText: "Transcript ›" });
  const agent = await link.getAttribute("data-agent");
  await link.click();
  const foot = page.locator(".agent-foot");
  await foot.waitFor();
  const has = await holds("the transcript has text", async () => { const m = await msgs(page); return m.user.length > 0 && m.assistant.length > 0; }, { timeout: 20000 });
  const m = await msgs(page);
  await check('5 "Transcript ›" of turn 1 opens the orchestrator\'s transcript, and it has text', has === true && m.user.some((t) => t.includes("turn 1")) && m.assistant.join(" ").trim().length > 0,
    `${counts(m)}; user: "${short(m.user[0], 120)}"; assistant: "${short(m.assistant[0], 120)}"`);
  const onB = ((await get(B, `/api/chats/${agent}/items`)).json?.items ?? []).length;
  await check("5 the transcript is read-only, and B's own API has the agent's thread", (await foot.innerText()).includes("Read-only") && onB > 0 && (await page.locator(".agent-foot ~ .composer, .chat-view .composer .composer-input").count()) === 0,
    `foot "${short(await foot.innerText())}"; items of ${agent} on B: ${onB}`);
  await page.keyboard.press("Escape");
  await foot.waitFor({ state: "detached" }).catch(() => {});
}

async function step6() {
  // The task works: its agent has been launched and waits TASK_SLEEP seconds before it writes.
  const working = await holds("T01 is running on B", async () => {
    const d = await detailOn(B, run);
    return Object.values(d?.agents ?? {}).some((a) => a.task === "T01" && a.status === "running");
  }, { timeout: 30000, every: 100 });
  const taskRow = page.locator(".run-follow .tl-rows .tl-id", { hasText: /^T01$/ });
  const rowThere = await taskRow.first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  await check("6 the task T01 works on B and has its row in the timeline", working === true && rowThere, `${working === true ? "" : working}`);
  // The dock's Goal tab is read, left for Usage and opened again: its text now comes from what the page keeps.
  await dockTab(page, "goal").click();
  const read = await holds("the Goal tab shows the goal", async () => (await goalTab(page)).text.includes(FIRST_LINE), { timeout: 10000 });
  await dockTab(page, "usage").click();
  await page.locator(".run-follow .run-goal-tab").waitFor({ state: "detached" });
  await dockTab(page, "goal").click();
  const again = await holds("the Goal tab shows the goal again", async () => { const g = await goalTab(page); return g.loading === 0 && g.text.includes(FIRST_LINE); }, { timeout: 5000 });
  await check('6 the dock\'s tab "Goal" shows the goal, and again after "Usage"', read === true && again === true, one(await goalTab(page)));
  const row = runRow(page);
  page.reloads = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) page.reloads++; });

  await stop(B);
  const off = await holds("the row is off", async () => /\boff\b/.test((await rowLook(row)).cls), { timeout: 20000 });
  const look = await rowLook(row);
  await check('6 B is stopped while the task works: the row gets its "not connected" form', off === true && look.title === `${B.name} is not connected` && (await row.locator(".crow-dot.st-off").count()) === 1, one(look));
  const bar = page.locator(".run-follow .remote-bar.run-remote-bar.off");
  const barOn = await bar.waitFor({ timeout: 5000 }).then(() => true, () => false);
  await check("6 the run's detail stays on screen with the bar", barOn && (await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').count()) === 1 && (await taskRow.count()) > 0, `bar "${short(await bar.innerText().catch(() => "none"))}"`);
  const mid = await runOn(A, run);
  await check("6 while B is away A still lists the run, not as gone", !!mid && mid.gone !== true && mid.status !== "draft" && fs.existsSync(B.work) && !fs.existsSync(path.join(B.work, RUN_FILE)), `A's run: ${one(mid && { status: mid.status, gone: mid.gone ?? false })}`);

  await start(B);
  // No reload, no click, and no call that makes A dial: A's own next attempt is waited for.
  const t0 = Date.now();
  const back = await holds("the row is no longer off", async () => !/\boff\b/.test((await rowLook(row)).cls), { timeout: 90000, every: 250 });
  await check("6 B is started again: the row turns back with no reload and no click", back, `${one(await rowLook(row))} after ${Math.round((Date.now() - t0) / 1000)} s`);
  const ended = await holds("the run's status on the page is completed", async () => (await page.locator(".run-bar .run-status.st-completed").count()) === 1, { timeout: 90000, every: 250 });
  await check("6 the run ends on the page: the bar's status is completed and the bar of the outage is gone", ended === true && (await holds("no bar", async () => (await page.locator(".run-follow .remote-bar").count()) === 0, { timeout: 10000 })) === true,
    `status "${short(await page.locator(".run-bar .run-state").innerText().catch(() => "none"))}"; bar "${short(await page.locator(".run-follow .remote-bar").innerText().catch(() => "none"))}"; row ${one(await rowLook(row))}`);
  const lane = page.locator(".run-follow .tl-lane .tl-turn");
  const tl = await holds("the timeline shows the end", async () => (await lane.count()) >= 2 && (await page.locator(".run-follow .tl-lane .tl-turn.run, .run-follow .tl-lane .tl-turn.st-running").count()) === 0 && (await page.locator(".run-follow .tl-opsum .fin").count()) === 1, { timeout: 20000 });
  await check("6 the timeline shows the end: the finishing turn with its flag, and no turn running", tl,
    `turns ${await lane.count()}: ${one(await lane.evaluateAll((els) => els.map((el) => el.className)))}; lane: ${short(await page.locator(".run-follow .tl-lane").innerText().catch(() => "none"), 120)}`);
  const banner = page.locator(".run-follow .run-now .run-banner.st-completed");
  const said = await holds("the line under the head says applied", async () => (await page.locator('.run-follow .run-now .run-applied[data-applied="true"]').count()) === 1, { timeout: 20000 });
  const line = short(await banner.innerText().catch(() => "no banner"));
  await check('6 the line under the head says "Goal achieved" and that the result is applied to main', said === true && line.includes("Goal achieved") && /applied to main/.test(line), `line "${line}"`);
  const goalNow = await goalTab(page);
  await check('6 after the restart the Goal tab shows the goal\'s text and no "Loading…", with no click', goalNow.tabs === 1 && goalNow.loading === 0 && goalNow.text.includes(FIRST_LINE), one(goalNow));
  await check("6 all of that with no reload of the page and no click", page.reloads === 0, `main frame navigations: ${page.reloads}`);
  // One click now, for the delivery card: it is in the Result tab of the dock.
  await page.locator(".run-follow .run-now .run-banner-link").click();
  const card = page.locator(".run-follow .rd-deliver");
  const applied = await holds("the delivery card says applied", async () => (await card.getAttribute("data-delivery")) === "applied", { timeout: 20000 });
  await check(`6 the Result tab's delivery card says applied, to the folder on ${B.name}`, applied === true && (await card.locator(".rd-deliver-title").innerText()) === `Applied to the folder on ${B.name}`,
    `card: ${short(await card.innerText().catch(() => "no card"), 200)}; dock: ${short(await page.locator(".run-follow .run-dock").innerText().catch(() => "none"), 200)}`);

  const d = await detailOn(B, run), there = await runOn(B, run), mine = await runOn(A, run);
  await check("6 B's own API: the run is completed as achieved, its delivery applied; A's list says the same",
    there?.status === "completed" && there?.outcome === "achieved" && d?.delivery?.state === "applied" && mine?.status === "completed" && mine?.delivery === "applied",
    `B: ${one({ status: there?.status, outcome: there?.outcome, delivery: d?.delivery?.state, how: d?.delivery?.how })}; A: ${one({ status: mine?.status, delivery: mine?.delivery })}`);
  let onMain = "";
  try { onMain = git(B.work, "show", `main:${RUN_FILE}`); } catch (e) { onMain = "threw: " + short(e.message, 160); }
  await check(`6 B's repository has the result on main (${RUN_FILE})`, onMain === RUN_TEXT && fs.readFileSync(path.join(B.work, RUN_FILE), "utf8").trim() === RUN_TEXT, `main:${RUN_FILE} = ${one(onMain)}; log: ${short(git(B.work, "log", "--oneline", "-5", "main"), 200)}`);
}

async function step7() {
  const before = new Set((await stateOf(A)).chats.map((c) => c.id));
  const row = runRow(page);
  await row.hover();
  await row.locator('[title="New chat on this run"]').click();
  runChat = await waitFor("the page selects its new chat", async () => { const c = (await sel(page)).chat; return c && !before.has(c) ? c : null; });
  await box(page).first().waitFor();
  const e = await entry();
  const fixed = page.locator('.composer .tchip.static.server-chip[title^="Server"]');
  const draft = await chatOn(A, runChat);
  await check('7 "+" on the run makes a chat of the run on B, with no server choice', draft?.run === run && draft?.server === e?.id && (await page.locator('.composer button.tchip[title^="Server"]').count()) === 0,
    `A's chat: ${one(draft && { run: draft.run, server: draft.server, cwd: draft.cwd })}; fixed server chips ${await fixed.count()}: "${short(await fixed.innerText().catch(() => ""))}"`);
  const text = "hello from the run's chat";
  await send(page, text);
  const reply = await replied(page, text);
  const m = await msgs(page);
  await check("7 a first message in that chat is answered", reply === true && m.user.length === 1 && m.assistant.length === 1, `${reply === true ? "" : reply + " "}${counts(m)}: ${one(m).slice(0, 300)}; line "${short(await page.locator(".composer-err").innerText().catch(() => ""))}"`);
  const onB = await holds("B has the chat", async () => (await userTexts(B, runChat)).length === 1);
  const there = await chatOn(B, runChat);
  await check("7 B's own API has the chat: on the run, in the run's folder, with the message once", onB === true && there?.run === run && there?.cwd === B.work,
    `B's chat: ${one(there && { run: there.run, cwd: there.cwd })}; the run's folder ${B.work}`);
  await waitFor("its turn ends", async () => (await chatOn(B, runChat))?.status === "ready").catch(() => {});
}

async function step8() {
  // The run's detail on screen (the chat of step 7 is beside it), then B stops.
  const row = runRow(page);
  await row.click();
  const turns = page.locator(".run-follow .tl-lane .tl-turn");
  await waitFor("the run's timeline is on screen", async () => (await turns.count()) >= 2);
  const had = { turns: await turns.count(), tasks: await page.locator(".run-follow .tl-rows .tl-id").count() };
  await stop(B);
  const off = await holds("the row is off", async () => /\boff\b/.test((await rowLook(row)).cls), { timeout: 20000 });
  const look = await rowLook(row);
  await check("8 B is stopped: the run's row is off", off === true && look.title === `${B.name} is not connected` && look.sub.endsWith(`· ${B.name}`), one(look));
  const bar = page.locator(".run-follow .remote-bar.run-remote-bar.off");
  const barOn = await bar.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const has = { turns: await turns.count(), tasks: await page.locator(".run-follow .tl-rows .tl-id").count() };
  await check("8 the detail keeps what it had, with the bar", barOn && has.turns === had.turns && has.tasks === had.tasks && (await bar.innerText()).includes(`${B.name} is not connected.`) && (await bar.locator(".remote-servers").count()) === 1,
    `bar "${short(await bar.innerText().catch(() => "none"))}"; turns ${has.turns} of ${had.turns}, task rows ${has.tasks} of ${had.tasks}`);

  await rowMenu(page, row, "Delete");
  const dlg = page.locator(".dialog");
  const first = await dlg.locator(".dialog-title").innerText();
  await dlg.locator("button", { hasText: /^Delete$/ }).click();
  const only = dlg.locator("button", { hasText: /^Remove from this sidebar only$/ });
  const offered = await only.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const second = await dlg.locator(".dialog-title").innerText().catch(() => "closed");
  await check('8 "Delete" is refused and the dialog offers "Remove from this sidebar only"', first === `Delete ${RUN_NAME}?` && offered && second === `Remove ${RUN_NAME} from this sidebar?`,
    `first dialog "${first}"; then "${second}": ${short(await dlg.innerText().catch(() => ""), 300)}`);
  // Not confirmed: the dialog is left, and the run stays in A's list.
  await page.keyboard.press("Escape");
  if (await dlg.count()) await dlg.locator("button", { hasText: /^Cancel$/ }).click().catch(() => {});
  await dlg.waitFor({ state: "detached" }).catch(() => {});
  await check("8 the offer is not taken: the row and A's record stay", (await dlg.count()) === 0 && (await row.count()) === 1 && (await runOn(A, run)) !== null, `dialogs ${await dlg.count()}, rows ${await row.count()}`);

  await start(B);
  const back = await holds("the row is no longer off", async () => !/\boff\b/.test((await rowLook(row)).cls), { timeout: 90000, every: 250 });
  const barGone = await holds("the bar is gone", async () => (await page.locator(".run-follow .remote-bar").count()) === 0, { timeout: 15000 });
  await check("8 B is started again: the row turns back and the bar goes, with the run still on B", back === true && barGone === true && (await get(B, `/api/runs/${run}`)).status === 200, `row ${one(await rowLook(row))}; bar gone: ${barGone}`);
}

async function step9() {
  const up = await connected(90000);
  const row = runRow(page);
  await rowMenu(page, row, "Delete");
  const dlg = page.locator(".dialog");
  const title = await dlg.locator(".dialog-title").innerText();
  const body = await dlg.locator(".dialog-body").innerText().catch(() => "");
  await check(`9 the delete dialog says where the run is removed (${B.name})`, title === `Delete ${RUN_NAME}?` && body.includes(`are removed on ${B.name}`) && body.includes(`on ${B.name} stays`), `connected: ${up}; "${title}": ${short(body, 300)}`);
  await dlg.locator("button", { hasText: /^Delete$/ }).click();
  const gone = await holds("the row and A's record are gone", async () => (await row.count()) === 0 && (await runOn(A, run)) === null, { timeout: 20000 });
  await check("9 the run is deleted: its row goes and A lists it no more", gone, `dialog: ${short(await dlg.innerText().catch(() => "closed"), 200)}`);
  const own = await get(B, `/api/runs/${run}`), there = await runOn(B, run);
  await check("9 B answers 404 for the run and its state has it no more", own.status === 404 && there === null, `GET /api/runs/${run} on B -> ${own.status} ${one(own.json).slice(0, 120)}; in B's state: ${there !== null}`);
  const chatGone = await holds("the run's chat is gone on both", async () => (await chatOn(A, runChat)) === null && (await chatOn(B, runChat)) === null, { timeout: 10000 });
  let onMain = "";
  try { onMain = git(B.work, "show", `main:${RUN_FILE}`); } catch (e) { onMain = "threw: " + short(e.message, 160); }
  await check("9 the run's chat went with it, and what the run changed in B's repository stays", chatGone === true && onMain === RUN_TEXT, `chat gone: ${chatGone}; main:${RUN_FILE} = ${one(onMain)}`);
}

/** The start of a run on B while B does not answer for A's whole wait (45 s): the start ends with
 *  "not known whether the run started". B goes on, and with no click the page shows the run as
 *  started, with B having it once. */
async function stepFrozenStart() {
  const up = await connected(90000);
  const before = new Set(((await stateOf(A)).runs ?? []).map((r) => r.id));
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New run\s*$/).click();
  run2 = await waitFor("the page selects its new run", async () => { const r = (await sel(page)).run; return r && !before.has(r) ? r : null; });
  await runBox(page).waitFor();
  if (up === true && !(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  await page.locator('.composer button.tchip[title^="Folder on"]').click();
  const dirs = page.locator(".composer .menu.dirs");
  await dirs.locator(".dir-input").fill(B.work);
  await dirs.locator(".dir-input").press("Enter");
  await waitFor("the picker lists B's repository", async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(B_ONLY)));
  await dirs.locator(".dir-foot button").click();
  const e = await entry();
  await waitFor("the draft is on B, in B's repository", async () => { const r = await runOn(A, run2); return !!e && r?.server === e.id && r?.cwd === B.work; });
  // The goal ends the run in its first turn: nothing is left working when the servers stop.
  await runBox(page).click();
  await runBox(page).fill('Nothing to do. [[if This is turn 1.]] [[mcp finish_run {"outcome":"achieved","summary":"There was nothing to do."}]] [[if]]');
  const startBtn = page.locator(".composer.run-composer button.send");
  await waitFor("Start is enabled", async () => !(await startBtn.isDisabled()), { timeout: 5000 });
  const row = page.locator(".side-row.is-run.on");
  const line = page.locator(".composer-err", { hasText: START_UNKNOWN });
  const p = B.proc.p;
  p.kill("SIGSTOP");
  try {
    await startBtn.click();
    const t0 = Date.now();
    const said = await holds("the line of a start that got no answer", async () => (await line.count()) > 0, { timeout: 75000, every: 250 });
    await check("FS B does not answer for the whole wait: the line says it is not known whether the run started", said === true && (await runOn(A, run2))?.status === "draft",
      `after ${Math.round((Date.now() - t0) / 1000)} s; line "${short(await page.locator(".composer-err, .run-note").allInnerTexts())}"; A's run: ${one((await runOn(A, run2))?.status ?? null)}`);
  } finally {
    p.kill("SIGCONT");
  }
  // Nothing is pressed from here on.
  const t1 = Date.now();
  const started = await holds("the composer is gone and the run shows as started", async () =>
    (await page.locator(".composer.run-composer").count()) === 0 && (await page.locator(".run-follow").count()) === 1 && !(await rowLook(row)).sub.includes("Not started") && (await line.count()) === 0, { timeout: 40000, every: 250 });
  const took = Math.round((Date.now() - t1) / 1000);
  const mine = await runOn(A, run2), shown = (await sel(page)).run;
  await check("FS B goes on, nothing is pressed: the composer is gone and the run's view and row show it started", started === true && !!mine && mine.status !== "draft" && shown === run2,
    `${started === true ? `after ${took} s; ` : started + " "}composers ${await page.locator(".composer.run-composer").count()}; row ${one(await rowLook(row))}; A's run: ${one(mine && { status: mine.status })}; the page's run ${shown === run2 ? "is the same" : shown}`);
  const red = await page.locator(".composer-err").allInnerTexts();
  await check("FS the line of the start is gone", (await line.count()) === 0 && !(await page.locator("#root").innerText()).includes(START_UNKNOWN), `lines ${one(red)}`);
  const onB = ((await stateOf(B))?.runs ?? []).filter((r) => r.id === run2), own = await get(B, `/api/runs/${run2}`);
  const all = ((await stateOf(B))?.runs ?? []).length;
  await check("FS B's own API lists exactly one run under that id, not a draft", onB.length === 1 && onB[0].status !== "draft" && own.status === 200 && all === 1,
    `runs with the id in B's state: ${onB.length} (${onB.map((r) => r.status).join(", ")}); runs on B in all: ${all}; GET /api/runs/${run2} -> ${own.status}`);
  await waitFor("the run ends on B", async () => { const r = await runOn(B, run2); return !!r && !["running", "stopping", "draft"].includes(r.status); }, { timeout: 30000, every: 250 }).catch(() => {});
}

// ---- main

let code = 0;
try {
  await prepare();
  await start(A);
  await start(B);
  console.log(`# A on ${A.base}; B on ${B.base}, remote listener on https://127.0.0.1:${B.remotePort}; files in ${OUT}`);
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("playwright is not installed: cd web && npm install --no-save playwright && npx playwright install chromium"); }
  browser = await chromium.launch({ headless: true });
  page = await openPage();
  await step("1 add B", step1);
  await step("2 new run on B", step2);
  await step("3 the folder", step3);
  await step("4 the goal", step4);
  await step("5 the transcript", step5);
  await step("6 B restarts while a task works", step6);
  if (!B.proc) await start(B).catch(() => {});
  await step("7 a chat on the run", step7);
  await step("8 B is stopped", step8);
  if (!B.proc) await start(B).catch(() => {});
  await step("9 delete", step9);
  if (!B.proc) await start(B).catch(() => {});
  await step("FS start, no answer in the whole wait", stepFrozenStart);
  // Not checks: the outages and the refused delete are answered 503 by design, and the browser logs those.
  console.log(`# the page's console errors (${page.errors.length}): ${[...new Set(page.errors)].slice(0, 8).join(" ; ") || "none"}`);
  console.log(`# the page's requests that failed (${page.failedRequests.length}): ${[...new Set(page.failedRequests)].slice(0, 12).join(" ; ") || "none"}`);
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop(A);
  await stop(B);
}
const alive = [...A.pids, ...B.pids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
const free = (await Promise.all([A.port, B.port, B.remotePort].filter(Boolean).map(portFree))).every(Boolean);
page = null;
if (A.port && !(await check("both servers are stopped and their ports are free", free && alive.length === 0, `ports ${A.port}, ${B.port}, ${B.remotePort}; processes left: ${alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
