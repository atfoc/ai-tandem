// The headless writer fails (goal 6.5, plans/headless-board/architecture.md section 6, E3), on real server processes, the real
// headless writer (packages/headless, built into the temp folder), the repository's scripted stand-in for the agent
// (internal/agenttest/fake-claude) and a real page in a headless Chrome. No paid model is called: the only agent is the stand-in.
//
// A board that no window holds is edited by the headless writer, a Node process the server starts for an agent's call. Two cases:
//
//   (1) The process is killed in the middle of a change. The server runs with AIWB_HEADLESS_TEST=hold-before-save:2 (the process
//       holds its second `apply` after running it and before saving it, and prints `HOLD apply <board>`). A chat on a board is
//       sent two applies in one message; when the server's log shows the HOLD, the script kills the process (the pid of
//       `status -json`). Then:
//         - the board's file is valid JSON and holds exactly the first change, byte for byte what it was at the HOLD,
//           and `scene.rev` is the first save's;
//         - the board is free: the page, which shows it as a reader, presses "Edit here" and holds it at once (not after the
//           hand-off time);
//         - the agent's reply to the second apply is the text of a background editor that stopped (boardapi.AwayLostText);
//         - the agent's next call, on another board, starts a new process, which saves what it does.
//   (2) A server whose headless writer cannot run (-headless-node names a program that is not there) answers an agent's board
//       call that no window answers with the text that names the button (a page is connected), starts no process, says why in
//       `status -json`, and a chat, a board shown in a page and the page's own drawing work as ever.
//
// It spends no money and never touches the installed app: it builds its own server binary and headless bundle into a temp folder,
// runs scratch servers on temp data folders and free ports (the MCP listener too), and stops them at the end. Not part of `npm test`.
//
//   cd web && npm install --no-save playwright@1.64.1 && npx playwright install chromium
//   node web/e2e/headlessfail.e2e.mjs                (about 10–25 s; builds the server, the page and the headless bundle)
//
// It prints one line per check and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve (AIWB_E2E_CLIENT too), as the other scripts of web/e2e read it
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import {
  Scratch, finish, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, repo, serverBinary, standInAgent, waitFor,
} from "./lib/rig.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;
const OUT = makeOut("headlessfail");

// The texts an agent is told (internal/boardapi/mcp.go: AwayLostText, NoEditorText).
const AWAY_LOST = "The board's background editor stopped while it ran this call, so the call did not finish.";
const NO_EDITOR = "Nobody is editing this board in a window, and this server cannot edit a board without one.";
const NO_CLIENT = "The board isn't open: the AI Whiteboard window is closed.";

// ---- checks: one line each

let failed = 0, passed = 0;
function check(name, pass, detail = "") {
  if (pass) passed++; else failed++;
  const d = (typeof detail === "string" ? detail : JSON.stringify(detail) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  console.log(`${pass ? "ok  " : "FAIL"} - ${name}${d ? `  (${d})` : ""}`);
  return pass;
}
async function step(name, fn) {
  console.log(`# ${name}`);
  try { await fn(); }
  catch (e) {
    check(`${name}: the step ran to its end`, false, e.message);
    await Promise.all(pages.map((p, i) => shot(p, `failed-${name.slice(1, 2)}-p${i + 1}`)));
  }
}

// ---- the scratch servers

// A scratch server whose flags add the headless writer's (the program that runs it, the folder of its bundle), and whose
// environment lowers the waits (quiet time, start limit, idle look) and sets the test knob.
class HeadlessScratch extends Scratch {
  constructor(o) { super(o); this.headlessNode = o.headlessNode; this.knob = o.knob ?? ""; }
  get flags() { return [...super.flags, "-headless-node", this.headlessNode, "-headless-dir", BUNDLE]; }
  get env() {
    return {
      ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: this.cursorCfg,
      AIWB_TEST_WAITS: "quiet=5s,linger=1s,hstart=60s",
      ...(this.knob ? { AIWB_HEADLESS_TEST: this.knob } : {}),
    };
  }
  /** What `status -json` says of the headless writer. */
  async headless() { return (await this.status()).running?.headless ?? null; }
  logText() { try { return fs.readFileSync(this.log, "utf8"); } catch { return ""; } }
}

let BUNDLE = "";
let bin = "";
let agent = "";
const scratches = [];
async function prepare() {
  bin = serverBinary(OUT);
  agent = standInAgent(OUT);
  BUNDLE = path.join(OUT, "headless");
  execFileSync(process.execPath, [path.join(repo, "packages/headless/build.mjs"), "--out", BUNDLE], { cwd: path.join(repo, "packages/headless"), stdio: ["ignore", "inherit", "inherit"] });
  if (!fs.existsSync(path.join(BUNDLE, "headless.mjs"))) throw new Error(`the headless bundle was not built into ${BUNDLE}`);
}
/** A started server with a host (the app's main process) that finds it, and a page on that host. */
async function serverWithPage(tag, o) {
  const S = new HeadlessScratch({ out: OUT, bin, agent, tag, name: tag, ...o });
  scratches.push(S);
  await S.setUp();
  await S.launch();
  const host = await hostFor({ out: OUT, name: tag, local: S });
  const page = await openPage(host);
  return { S, page };
}

// ---- the page

let browser = null;
const pages = [];
const hosts = [];
async function openPage(host) {
  hosts.push(host);
  const page = await openHostPage(browser, host, { viewport: { width: 1400, height: 900 }, timeout: 8000, wait: q.rootVisible });
  await page.waitForSelector(ui.treeWait, { timeout: 20000 });
  await ui.stateOfSection(page, "local").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  pages.push(page);
  return page;
}
const shot = (page, label) => page.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {});
const sel = ui.selection;
const own = (key) => String(key ?? "").split("~").pop();
const bar = (p) => p.locator(q.boardRole);
/** Opens a board's row (by name) and waits for the page to have it on screen with its bar. */
async function openBoard(p, name, id) {
  await ui.openRow(p, ui.rowOf(p, "board", name));
  await waitFor(`the page shows board ${name}`, async () => own((await sel(p)).board) === id);
  await p.locator(q.boardCanvas).waitFor({ timeout: 20000 });
}
/** The bar's data: { role, writer } of a page that is not the writer, null while it has none. */
const barOf = async (p) => (await bar(p).count()) ? bar(p).evaluate((el) => ({ role: el.dataset.role, writer: el.dataset.writer, text: el.innerText })) : null;
const editing = (p) => p.locator(q.boardEditing);

// ---- the server's boards and chats, through a client of the script's own

// The client that creates a board holds it, and a client that has a stream (the page's app) is a window: the boards and chats are
// made, and the chat is talked to, by a client with an id of its own that opens no stream (as the Go tests' `testClient` does), so
// that no window holds anything and every call of the agent is an away call.
const CLIENT = "5f0c2a7e-3b1d-4c6a-9e2f-7a8b9c0d1e2f";
/** One call of the client API of server S: { status, json, text, rev }. The server is a scratch one on this machine's loopback
 *  address with a certificate of its own, so the certificate is not checked here (the pages' apps pin it). */
function call(S, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1", port: S.port, path: p, method, rejectUnauthorized: false, timeout: 30000,
      headers: { "X-AIWB-Secret": S.secret, "X-AIWB-Client": CLIENT, "X-AIWB-Level": "7", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        const rev = res.headers["x-aiwb-scene-rev"];
        resolve({ status: res.statusCode, json, text, rev: rev === undefined ? null : Number(rev) });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${p}: no answer in 30 s`)));
    req.on("error", reject);
    req.end(data);
  });
}
async function must(S, method, p, body) {
  const r = await call(S, method, p, body);
  if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 200)}`);
  return r;
}
const newBoard = async (S, name) => (await must(S, "POST", "/api/boards", { name, group: "__ungrouped__" })).json.id;
async function newChat(S, board) {
  const id = (await must(S, "POST", "/api/chats", { agent: "claude", board })).json.id;
  await must(S, "PATCH", `/api/chats/${id}`, { cwd: S.work });
  return id;
}
const itemsOf = async (S, chat) => (await must(S, "GET", `/api/chats/${chat}/items`)).json.items ?? [];
const endsOf = async (S, chat) => (await itemsOf(S, chat)).filter((it) => it.kind === "end").length;
/** Sends the text and answers a function that waits for the end of the turn and gives the whole reply (the stand-in writes each tool's result in it). */
async function say(S, chat, text) {
  const first = (await itemsOf(S, chat)).length, before = await endsOf(S, chat);
  await must(S, "POST", `/api/chats/${chat}/messages`, { text });
  return async (timeout = 90000) => {
    await waitFor("the agent's turn ends", async () => (await endsOf(S, chat)) > before, { timeout });
    return (await itemsOf(S, chat)).slice(first).map((it) => it.text ?? "").join("\n");
  };
}
const apply = (board, key, extra) => `[[mcp apply ${JSON.stringify({ board, create: [{ type: "rectangle", key, x: 10, y: 10, width: 120, height: 70, ...extra }] })}]]`;

// ---- the board's file and the stored revision

const fileOf = (S, board) => path.join(S.home, "boards", board, "drawing.excalidraw");
/** The board's file: { raw, scene } (scene null when it is not valid JSON). */
function stored(S, board) {
  const raw = fs.readFileSync(fileOf(S, board), "utf8");
  try { return { raw, scene: JSON.parse(raw) }; } catch { return { raw, scene: null }; }
}
const live = (scene) => (scene?.elements ?? []).filter((e) => !e.isDeleted);
const revOf = async (S, board) => (await must(S, "GET", `/api/boards/${board}/scene`)).rev;
/** The lines of a server log about the headless writer. */
const logLines = (log) => log.split("\n").filter((l) => /headless/.test(l.replace(/\S*\/headless\S*/g, "")));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid) => { try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); } catch { return ""; } };

// ---- (1) the process is killed in the middle of a change

async function partOne() {
  const { S, page } = await serverWithPage("s1", { headlessNode: process.execPath, knob: "hold-before-save:2" });
  const main = await newBoard(S, "main-board");
  const second = await newBoard(S, "second-board");
  const chat = await newChat(S, main);
  await openBoard(page, "main-board", main);
  const rev0 = await revOf(S, main);
  check("the headless writer is available and not running before any call", await (async () => { const h = await S.headless(); return h?.available === true && h.running === false; })(), await S.headless());
  check("the page shows the board as a reader, with the button", (await barOf(page)) !== null && await page.locator(q.boardTake).isVisible() && !(await editing(page).count()), await barOf(page));

  // One message, two applies: the first is saved and answered, the second is held after it ran and before it is saved.
  const done = await say(S, chat, `${apply(main, "first")} ${apply(main, "second", { x: 300 })}`);
  const hold = await waitFor("the server's log shows the HOLD line", () => S.logText().split("\n").find((l) => l.includes(`headless: HOLD apply ${main}`)), { timeout: 90000 });
  check("the server's log has the HOLD line once, with one prefix", hold.endsWith(`headless: HOLD apply ${main}`) && !hold.includes("headless: headless:") && S.logText().split(`HOLD apply ${main}`).length === 2, hold);
  const h1 = await S.headless();
  check("status -json names the running process (pid, one board)", h1?.running === true && h1.pid > 0 && h1.boards === 1, h1);
  const atHold = stored(S, main);
  const revAtHold = await revOf(S, main);
  const firstOnly = live(atHold.scene);
  check("at the HOLD the file is valid JSON with the first change only, saved at a newer revision", atHold.scene !== null && firstOnly.length === 1 && firstOnly[0].type === "rectangle" && firstOnly[0].x === 10 && revAtHold > rev0, { elements: firstOnly.length, rev0, revAtHold });
  const writing = await waitFor("the page shows that an agent is editing", async () => (await barOf(page))?.writer === "headless" ? await barOf(page) : null, { timeout: 20000 });
  check("the page, a reader, is told that an agent is editing", /An agent is editing this board/.test(writing.text), writing);

  // The kill: the process of status -json, after a look at what it is.
  if (!/headless\.mjs/.test(commandOf(h1.pid))) throw new Error(`pid ${h1.pid} is not the headless writer: ${commandOf(h1.pid)}`);
  const killedAt = Date.now();
  process.kill(h1.pid, "SIGKILL");

  const reply = await done();
  check("the agent's reply to the call that was cut has the text of a background editor that stopped", reply.includes(AWAY_LOST) && reply.includes("Read the board again before you change it."), reply.slice(-700));
  check("the agent's reply to the first apply is its result, not an error", /apply -> (?!The board's background editor stopped)/.test(reply) && reply.split(AWAY_LOST).length === 2, reply.slice(0, 400));
  check("the turn ended soon after the kill, not at the call's time limit", Date.now() - killedAt < 20000, `${Date.now() - killedAt} ms`);

  const after = stored(S, main);
  check("the board's file is valid JSON", after.scene !== null && typeof after.scene === "object", after.raw.slice(0, 120));
  check("the board's file has exactly the first change, as it was at the HOLD", after.raw === atHold.raw && live(after.scene).length === 1 && live(after.scene).every((e) => e.x === 10), { elements: live(after.scene).map((e) => [e.type, e.x]) });
  check("scene.rev is the first save's: the killed change moved nothing", (await revOf(S, main)) === revAtHold, { atHold: revAtHold, now: await revOf(S, main) });
  check("no temporary file of a half-written save is left in the board's folder", fs.readdirSync(path.dirname(fileOf(S, main))).every((f) => !/\.tmp|\.part|~$/.test(f)), fs.readdirSync(path.dirname(fileOf(S, main))));

  const gone = await waitFor("the process is gone", () => !alive(h1.pid), { timeout: 20000 });
  check("the killed process is gone and status -json no longer shows it", gone === true && await waitFor("status no longer shows the pid", async () => { const h = await S.headless(); return h && h.pid !== h1.pid; }, { timeout: 20000 }).then(() => true, () => false), await S.headless());

  // Free at once: the page was a reader, and presses the button.
  const freed = await waitFor("the page's bar no longer names an agent", async () => { const b = await barOf(page); return b && b.writer !== "headless" ? b : null; }, { timeout: 20000 });
  check("the page's bar says the board is View only, with no writer", /^View only\.\s*Edit here$/.test(freed.text.trim()) && (freed.writer === "none" || freed.writer === ""), freed);
  const pressed = Date.now();
  await ui.click(page, page.locator(q.boardTake));
  await editing(page).waitFor({ timeout: 8000 });
  const took = Date.now() - pressed;
  check("Edit here got the board at once (well inside the hand-off time), and the page is its writer", took < 6000 && !(await page.locator(q.boardTake).count()), `${took} ms`);
  const rolePage = (await barOf(page));
  check("the page has no bar of a reader any more", rolePage === null, rolePage);

  // The agent's next call starts a new process: on the second board (the first is the page's now).
  const done2 = await say(S, chat, `${apply(second, "third", { x: 40 })} [[mcp read_board ${JSON.stringify({ board: second })}]]`);
  const reply2 = await done2();
  check("the agent's next call was answered (no error text)", !reply2.includes(AWAY_LOST) && !reply2.includes(NO_CLIENT) && !reply2.includes(NO_EDITOR) && /apply -> \{[^\n]*\n?read_board -> second-board/.test(reply2), reply2.slice(-500));
  const h2 = await S.headless();
  check("a new process was started for it (another pid, the old one gone)", h2?.running === true && h2.pid > 0 && h2.pid !== h1.pid && !alive(h1.pid), { before: h1.pid, now: h2 });
  const sec = stored(S, second);
  check("the new process saved its change in the second board", sec.scene !== null && live(sec.scene).length === 1 && live(sec.scene)[0].x === 40, live(sec.scene).map((e) => e.x));
  const log = S.logText();
  check("the log tells that the process started twice", (log.match(/headless writer: started/g) ?? []).length === 2, logLines(log).slice(0, 12).join(" | "));
  check("the page threw no uncaught exception", page.errors.filter((e) => e.startsWith("uncaught")).length === 0, page.errors.filter((e) => e.startsWith("uncaught")).slice(0, 3));
  await shot(page, "part1-end");

  // The server's stop ends the process the new call started (the next part looks for processes of the bundle).
  await S.stop();
  check("the server's stop ended the headless writer it had started", await waitFor("the process is gone", () => !alive(h2.pid), { timeout: 20000 }).then(() => true, () => false), h2.pid);
}

// ---- (2) a server on which the headless writer cannot run

const TOOLBAR = '[data-testid="toolbar-rectangle"]';
async function partTwo() {
  const missing = path.join(OUT, "no-such-dir", "node");
  const { S, page } = await serverWithPage("s2", { headlessNode: missing });
  const board = await newBoard(S, "plain-board");
  const chat = await newChat(S, board);
  await openBoard(page, "plain-board", board);

  const h0 = await S.headless();
  check("status -json says the headless writer is not available, and why", h0 && h0.available === false && h0.running === false && h0.pid === 0 && h0.reason.includes("-headless-node") && h0.reason.includes(missing), h0);

  // An away call, with a page connected: the text that names the button.
  const reply = await (await say(S, chat, `before [[mcp read_board ${JSON.stringify({ board })}]]`))();
  check("an away call is answered with the text that names the Edit here button", reply.includes(NO_EDITOR) && reply.includes("press Edit here") && !reply.includes(NO_CLIENT), reply.slice(-500));
  const reply2 = await (await say(S, chat, `again ${apply(board, "x")}`))();
  check("an apply is answered the same way, and the board is not written", reply2.split(NO_EDITOR).length === 2 && live(stored(S, board).scene).length === 0, reply2.slice(-300));
  const h1 = await S.headless();
  check("nothing was started: status -json shows no process", h1?.running === false && h1.pid === 0, h1);
  const log = S.logText();
  check("the log has one line about the start that failed and none about a start", (log.match(/headless writer: not started/g) ?? []).length === 1 && !/headless writer: started/.test(log), logLines(log).join(" | "));
  const ps = execFileSync("ps", ["-Ao", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(path.join(BUNDLE, "headless.mjs")));
  check("no process of the headless bundle exists on this machine", ps.length === 0, ps.slice(0, 3));

  // Everything else works: a chat, and a board shown in a page, with its drawing.
  const plain = await (await say(S, chat, "hello there"))();
  check("a chat goes on: a plain message is answered", /FAKE\([^)]*\):[\s\S]*hello there/.test(plain) && !plain.includes(NO_EDITOR), plain.slice(-200));
  check("the board is shown in the page, as a reader, with the button", (await barOf(page)) !== null && await page.locator(q.boardCanvas).isVisible() && await page.locator(q.boardTake).isVisible(), await barOf(page));
  await ui.click(page, page.locator(q.boardTake));
  await editing(page).waitFor({ timeout: 8000 });
  await page.locator(TOOLBAR).waitFor({ state: "attached", timeout: 20000 });
  const c = await page.locator(q.boardCanvas).boundingBox();
  await page.keyboard.press("Escape");
  await page.locator("label", { has: page.locator(TOOLBAR) }).click();
  const x = c.x + c.width * 0.4, y = c.y + c.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 120, y + 70, { steps: 4 });
  await page.mouse.up();
  const drawn = await waitFor("the page's rectangle is in the board's file", () => live(stored(S, board).scene).find((e) => e.type === "rectangle") ?? null, { timeout: 15000 }).then(() => true, () => false);
  check("the page took the board and drew on it: the drawing is in the file", drawn);
  const h2 = await S.headless();
  check("after all that, still nothing was started", h2?.running === false && h2.pid === 0, h2);
  check("the page threw no uncaught exception", page.errors.filter((e) => e.startsWith("uncaught")).length === 0, page.errors.filter((e) => e.startsWith("uncaught")).slice(0, 3));
  await shot(page, "part2-end");
}

// ---- main

let code = 0;
const closeAll = async () => { await browser?.close().catch(() => {}); for (const h of hosts) await h.close().catch(() => {}); };
onSignal(async () => { await closeAll(); await finish(scratches); });
try {
  await prepare();
  console.log(`# files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  await step("(1) the headless writer is killed in the middle of a change", partOne);
  await step("(2) a server on which the headless writer cannot run", partTwo);
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  await closeAll();
}
for (const S of scratches) { const pid = S.info?.pid; if (pid && !S.pids.includes(pid)) S.pids.push(pid); }
const end = await finish(scratches);
if (scratches.length && !check("the servers are stopped and their ports are free", end.free && end.alive.length === 0, `processes left: ${end.alive.join(", ") || "none"}`) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(`# ${passed} checks passed, ${failed} failed`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
