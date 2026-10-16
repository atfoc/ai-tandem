// Away: an agent works on boards while no window is connected, and a window that connects afterwards shows the result
// (headless-board-goal.md 6.2; plans/headless-board/architecture.md, wave 5, E1).
//
// With no window, a chat's agent reads a board, changes it, asks for a picture of it and makes another board; the headless writer
// (packages/headless, a Node process the server starts for the first call) answers those calls. Then a window connects and shows the
// board: every change is there, in the order made, the revision is the stored one, and the window is a reader. The agent is never
// told that no board is open.
//
// How it runs. A scratch server (web/e2e/lib/rig.mjs: its own data folder, free ports, `AIWB_MCP_PORT=0`) with the stand-in agent
// internal/agenttest/fake-claude, no Cursor, no pi, and the headless writer: the bundle `packages/headless/dist` built here into the
// temp folder (`node packages/headless/build.mjs`, the version of the server built without a version, "dev") and the Node that runs
// this script. Nothing is connected to the server while the agent works: the chat and the board are made through the client API
// with a client that opens no event stream, so there is no window. The server's quiet time (how long the headless writer keeps a
// board after the agent's last call) is lowered with `AIWB_TEST_WAITS=quiet=3s,linger=1s`. After the agent's turns the test host
// (web/dev/host.mjs) and a page in a headless Chromium (Playwright) connect and open the board.
//
// It spends no money: the agent is the stand-in, no paid model is called. It never touches the installed app or the user's server.
// It builds its own binary and its own web build (or uses DIST), starts the scratch server and stops it at the end; about 10 seconds with the Go build cached, more when it builds.
// Not part of `npm test`.
//
//   cd web && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/away.e2e.mjs
//
// Steps:
//   1 no window: the server has no client connected and the headless writer is available but not running
//   2 the agent's turn, one message: read_board, apply (three creates, an arrow bound to two of them, an update), get_image of all,
//     create_board "second". Checked: every call is answered, none with the text of a closed window or of a board nobody edits, the
//     picture is a PNG, the board file holds the changes in the order made, and the headless writer ran
//   3 the second message (it needs the id create_board answered): apply on the second board. Checked: its file holds the elements
//   4 a window connects (the page) and opens the first board. Checked: the page holds the same elements in the same order as the
//     board file; the revision it read is the stored one, `scene.rev`; it is a reader, with the bar's reader text ("View only." or
//     "View only. An agent is editing this board."), and after the quiet time with "View only."; it made no call that writes,
//     and the board file and `scene.rev` are as the agent left them
//   5 the second board in the page, the same checks
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a screenshot for a failed check, and
// exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve (AIWB_E2E_CLIENT too): `cd app && npm run build:web`, then `DIST=app/dist-web`;
//                      see newchat.e2e.mjs; without DIST the script builds its own into the temp folder
//   AIWB_E2E_KEEP=1    keep the temp folder (server log, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { Scratch, finish, holds, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, repo, serverBinary, standInAgent, waitFor, writesFrom } from "./lib/rig.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;
const OUT = makeOut("away");

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null; // a failed check takes its screenshot and what the page logged since the last check
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  const d = String(seen).replace(/\s+/g, " ").trim();
  if (pass === true) console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`);
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
  catch (e) { await check(`${name}: the step ran to its end`, false, e.stack || e.message); }
}
const J = (o) => JSON.stringify(o);

// ---- the scratch server: the stand-in agent and the headless writer

const QUIET_MS = 3000;
class AwayServer extends Scratch {
  get env() {
    return { ...super.env, AIWB_TEST_WAITS: `quiet=${QUIET_MS}ms,linger=1s` };
  }
  get flags() {
    return [...super.flags, "-headless-node", process.execPath, "-headless-dir", this.headlessDir];
  }
}

let A = null;    // the server
let host = null; // the test host, once a window is to connect
let browser = null;

/** A call of the client API as a client that holds no event stream (there is no window): { status, json, text, rev }. The certificate
 *  is accepted by its fingerprint and by nothing else, as the app does it. */
const CLIENT = crypto.randomUUID();
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1", port: A.port, path: p, method, rejectUnauthorized: false, timeout: 30000,
      headers: { "X-AIWB-Secret": A.secret, "X-AIWB-Client": CLIENT, "X-AIWB-Level": "7", ...(data === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) },
      checkServerIdentity: (_, cert) => (cert.fingerprint256 === A.fingerprint ? undefined : new Error(`certificate ${cert.fingerprint256} is not the pinned one`)),
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
    if (data !== null) req.write(data);
    req.end();
  });
}
async function must(method, p, body) {
  const r = await api(method, p, body);
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

/** Sends the text to the chat and waits for the end of its turn; answers the text of the turn (the stand-in writes each tool's result in it). */
async function say(chat, text) {
  const items = async () => (await must("GET", `/api/chats/${chat}/items`)).items ?? [];
  const ends = (list) => list.filter((it) => it.kind === "end").length;
  const before = ends(await items());
  await must("POST", `/api/chats/${chat}/messages`, { text });
  const list = await waitFor("the turn ends", async () => { const l = await items(); return ends(l) > before ? l : null; }, { timeout: 90000, every: 200 });
  // (the text of this turn alone: the items after the end mark of the turn before)
  let seen = 0, from = 0;
  if (before > 0) list.forEach((it, i) => { if (it.kind === "end" && ++seen === before) from = i + 1; });
  return { text: list.slice(from).filter((it) => it.kind === "text").map((it) => it.text).join("\n"), items: list };
}

// ---- the files of the server

const boardDir = (id) => path.join(A.home, "boards", id);
const sceneFile = (id) => JSON.parse(fs.readFileSync(path.join(boardDir(id), "drawing.excalidraw"), "utf8"));
const storedRev = (id) => Number(fs.readFileSync(path.join(boardDir(id), "scene.rev"), "utf8").trim());
const liveOf = (scene) => (scene.elements ?? []).filter((e) => !e.isDeleted);
const summary = (e) => `${e.type}${e.text ? `:${e.text}` : ""}`;

// ---- the agent's messages

/** One directive of the stand-in: [[mcp TOOL {json}]]. The JSON holds arrays, and a directive ends at "]]", so no array ends right at another. */
const mcp = (tool, args) => `[[mcp ${tool} ${J(args)}]]`;
const CREATES = [
  { type: "rectangle", key: "alpha", x: 100, y: 100, width: 180, height: 90, label: "Alpha" },
  { type: "ellipse", key: "beta", x: 420, y: 100, width: 180, height: 90, label: "Beta" },
  { type: "text", key: "note", x: 100, y: 300, text: "Made while away" },
  { type: "arrow", key: "link", start: { key: "alpha" }, end: { key: "beta" } },
];
const UPDATE = { ref: { key: "alpha" }, label: "Alpha (updated)", moveBy: [0, 40] };
const FIRST = [
  "Away work.",
  mcp("read_board", {}),
  mcp("apply", { create: CREATES, update: [UPDATE] }),
  mcp("get_image", { scope: "all" }),
  mcp("create_board", { name: "second" }),
].join(" ");
const SECOND_CREATES = [
  { type: "diamond", key: "d", x: 50, y: 50, width: 240, height: 160, label: "Two" },
  { type: "text", key: "t2", x: 50, y: 250, text: "On the second board" },
];

// What an agent is told when no window is open, or nobody edits the board (internal/boardapi/mcp.go).
const NO_BOARD_TEXTS = ["The board isn't open", "the AI Whiteboard window is closed", "Nobody is editing this board", "cannot edit a board without one", "Board work needs the window open"];

async function prepare() {
  const bin = serverBinary(OUT);
  const dist = path.join(OUT, "headless");
  execFileSync(process.execPath, [path.join(repo, "packages/headless/build.mjs"), "--out", dist], { stdio: ["ignore", "inherit", "inherit"] });
  A = new AwayServer({ out: OUT, bin, agent: standInAgent(OUT), tag: "a", name: "This computer" });
  A.headlessDir = dist;
  await A.setUp();
  await A.launch();
}

// ---- the page

/** The elements the page holds (the live ones, in the scene's order): read from Excalidraw's own scene through the React tree of its
 *  container. null when the page shows no board. */
const onPage = (p) => p.evaluate(() => {
  const root = document.querySelector(".excalidraw");
  if (!root) return null;
  const key = Object.keys(root).find((k) => k.startsWith("__reactFiber$"));
  for (let f = key ? root[key] : null; f; f = f.return) {
    const s = f.stateNode;
    if (s && s.scene && typeof s.scene.getNonDeletedElements === "function") return s.scene.getNonDeletedElements().map((e) => ({ id: e.id, type: e.type, version: e.version, text: e.text ?? "" }));
  }
  return undefined;
});
const bar = async (p) => ({
  text: ((await p.locator(q.boardRole).innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim(),
  role: await p.locator(q.boardRole).getAttribute("data-role").catch(() => null),
  writer: await p.locator(q.boardRole).getAttribute("data-writer").catch(() => null),
});

/** A reader: the bar offers the button and the window is neither the writer nor taking the board. */
const isReader = (b) => b.role !== "held" && b.role !== "taking" && b.role !== "lost";

async function openBoard(p, name) {
  await ui.openRow(p, ui.rowOf(p, "board", name));
  await p.locator(q.boardRole).waitFor({ timeout: 30000 });
}

/** The checks of one board shown in the page: same elements in the same order as the file, the stored revision, a reader. */
async function shown(what, p, id, expectedTypes) {
  const file = liveOf(sceneFile(id));
  const stored = storedRev(id);
  const sameAsFile = () => onPage(p).then((els) => (Array.isArray(els) && els.length === file.length && els.every((e, i) => e.id === file[i].id && e.version === file[i].version) ? els : null));
  const els = await waitFor(`${what}: the page holds the board's elements`, sameAsFile, { timeout: 30000 }).catch(() => null);
  await check(`${what}: the page holds every element of the board file, in the order made`, !!els, `file: ${J(file.map(summary))}; page: ${J((await onPage(p))?.map?.(summary))}`);
  await check(`${what}: the elements are the ones the agent made, in order`, J(file.map((e) => e.type).sort()) === J([...expectedTypes].sort()), `file: ${J(file.map(summary))}`);
  // The scene the page read, and its revision (the header of GET scene, through the host): the stored one.
  const read = await ui.selection(p);
  const via = await fetch(`${p.host.url}host/call?server=local&method=GET&path=${encodeURIComponent(`/api/boards/${id}/scene`)}`, { method: "POST" });
  const rev = via.headers.get("x-aiwb-scene-rev");
  await check(`${what}: the revision the page reads is the stored one (scene.rev)`, Number(rev) === stored && stored > 0, `header ${rev}, scene.rev ${stored}; the page's selection ${J(read)}`);
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host?.close().catch(() => {}); if (A) await A.stop(); });
let boards = null; // { first, second } ids
let headlessPid = 0;
try {
  await prepare();
  console.log(`# server on https://127.0.0.1:${A.port}; files in ${OUT}`);
  await step("1 no window", async () => {
    const st = await A.status();
    const h = st.running?.headless;
    await check("1 no window is connected, the headless writer is available and not running", !!h?.available && !h.running, J(h));
  });
  let first = "", chat = "", second = "";
  await step("2 the agent's turn", async () => {
    first = (await must("POST", "/api/boards", { name: "away", group: "__ungrouped__" })).id;
    chat = (await must("POST", "/api/chats", { agent: "claude", board: first })).id;
    await must("PATCH", `/api/chats/${chat}`, { cwd: A.work });
    const r = await say(chat, FIRST);
    const reply = r.text;
    const pieces = (tool) => new RegExp(`${tool} -> ([\\s\\S]*?)(?=\\n(?:read_board|apply|get_image|create_board) -> |$)`).exec(reply)?.[1] ?? null;
    const got = Object.fromEntries(["read_board", "apply", "get_image", "create_board"].map((t) => [t, pieces(t)]));
    await check("2 the four calls were answered", Object.values(got).every((v) => v !== null), J(got).slice(0, 700));
    const told = NO_BOARD_TEXTS.filter((t) => reply.includes(t));
    await check("2 the reply has no text of a closed window or of a board nobody edits", told.length === 0, told.join(" ; "));
    await check("2 the board was read empty, then the picture was of the four elements made", /\(rev 0, 0 elements\)/.test(got.read_board ?? "") && /scope all, .* 4 elements/.test(got.get_image ?? ""), `read_board: ${got.read_board}; get_image: ${got.get_image}`);
    second = /created second \((b_\w+)\)/.exec(got.create_board ?? "")?.[1] ?? "";
    await check("2 create_board made the board \"second\"", !!second && (await must("GET", "/api/state")).boards?.some((b) => b.id === second && b.name === "second"), `create_board: ${got.create_board}`);

    // The picture the agent asked for, taken the way its own call is made (the stand-in keeps only the text of a result): a PNG.
    const cfg = JSON.parse(fs.readFileSync(path.join(A.home, "chats", chat, "mcp.json"), "utf8")).mcpServers.board;
    const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", ...cfg.headers }, body: J({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_image", arguments: { scope: "all" } } }) });
    const content = (await res.json()).result?.content ?? [];
    const img = content.find((c) => c.type === "image");
    const png = img ? Buffer.from(img.data, "base64") : Buffer.alloc(0);
    const isPng = png.length > 8 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const [w, h] = isPng ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
    await check("2 the picture of the whole board is a PNG of the size of what was drawn", isPng && img.mimeType === "image/png" && w >= 500 && h >= 227, `mime ${img?.mimeType}, ${png.length} bytes, ${w}x${h}; text: ${content.filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 120)}`);
    if (isPng) fs.writeFileSync(path.join(OUT, "away.png"), png);

    // The board file: what the apply made, in the order made.
    const made = JSON.parse(got.apply ?? "{}");
    const scene = sceneFile(first), live = liveOf(scene);
    const at = (key) => live.findIndex((e) => e.id === made.created?.[key]);
    const el = (key) => live[at(key)];
    const order = ["alpha", "beta", "note", "link"].map(at);
    await check("2 the file holds the three elements and the arrow, in the order made", order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]) && live.filter((e) => ["rectangle", "ellipse", "text", "arrow"].includes(e.type) && !e.containerId).length === 4, J(live.map(summary)));
    const label = (key) => live.find((e) => e.containerId === made.created?.[key] && e.type === "text");
    await check("2 the update was applied: the rectangle moved down 40 and says Alpha (updated); the others are as made", el("alpha")?.y === 140 && label("alpha")?.text === "Alpha (updated)" && el("beta")?.y === 100 && label("beta")?.text === "Beta" && el("note")?.text === "Made while away", J(live.map((e) => [summary(e), e.y])));
    const arrow = el("link");
    await check("2 the arrow is bound to the rectangle and the ellipse", arrow?.startBinding?.elementId === made.created?.alpha && arrow?.endBinding?.elementId === made.created?.beta, J({ start: arrow?.startBinding, end: arrow?.endBinding }));
    await check("2 the stored revision is the one the apply answered", made.rev >= 1 && storedRev(first) === made.rev, `apply rev ${made.rev}, scene.rev ${storedRev(first)}`);
    const h2 = (await A.status()).running?.headless;
    headlessPid = h2?.pid ?? 0;
    await check("2 the headless writer ran for the calls", !!h2?.available && !!headlessPid, J(h2));
    boards = { first, made };
  });
  await step("3 the second board", async () => {
    if (!second) throw new Error("create_board made no board");
    const r = await say(chat, `Now the second board. ${mcp("apply", { board: second, create: SECOND_CREATES })}`);
    const told = NO_BOARD_TEXTS.filter((t) => r.text.includes(t));
    const m = /apply -> (\{[\s\S]*\})/.exec(r.text);
    const made = m ? JSON.parse(m[1].split("\n")[0]) : null;
    await check("3 the apply on the second board was answered, with no text of a closed window", !!made && made.id === second && told.length === 0 && (made.conflicts ?? []).length === 0, r.text.slice(-400));
    const live = liveOf(sceneFile(second));
    await check("3 the second board's file holds its elements, in order", J(live.map((e) => e.type)) === J(["diamond", "text", "text"]) && live[0].id === made?.created?.d && live[1].id === made?.created?.t2, J(live.map(summary)));
    await check("3 the second board's stored revision is the apply's", !!made && made.rev >= 1 && storedRev(second) === made.rev, `apply rev ${made?.rev}, scene.rev ${storedRev(second)}`);
    await check("3 the first board's file is as it was", storedRev(first) === boards.made.rev, `scene.rev ${storedRev(first)}`);
    boards.second = second;
  });
  await step("4 a window connects", async () => {
    if (!boards?.second) throw new Error("the boards were not made");
    const files = { first: fs.readFileSync(path.join(boardDir(first), "drawing.excalidraw"), "utf8"), second: fs.readFileSync(path.join(boardDir(second), "drawing.excalidraw"), "utf8") };
    const revs = { first: storedRev(first), second: storedRev(second) };
    host = await hostFor({ out: OUT, name: "p", local: A });
    browser = await (await loadChromium()).launch({ headless: true });
    page = await openHostPage(browser, host, { wait: q.rootVisible, timeout: 15000 });
    await ui.stateOfSection(page, "local").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
    const writes = writesFrom(page);

    await openBoard(page, "away");
    await shown("4 first board", page, first, ["rectangle", "ellipse", "text", "arrow", "text", "text"]);
    const first_bar = await bar(page);
    await check("4 the page is a reader, and the bar says what a reader's bar says", isReader(first_bar) && /^View only\.( An agent is editing this board\.)?\s*Edit here$/.test(first_bar.text) && (await page.locator(q.boardTake).count()) === 1 && (await page.locator(q.boardEditing).count()) === 0, J(first_bar));
    // After the quiet time the headless writer lets the board go: nobody writes it, and the bar says no more than "View only.".
    const quiet = await holds("the bar says View only. once the agent's quiet time is over", async () => /^View only\.\s*Edit here$/.test((await bar(page)).text), { timeout: 30000 });
    const freed = await holds("the headless writer holds no board", async () => (await A.status()).running?.headless?.boards === 0, { timeout: 30000 });
    await check("4 after the quiet time the bar says View only., nobody writes the board, and the headless writer holds none",
      quiet === true && freed === true && (await bar(page)).writer === "none", `bar first: "${first_bar.text}" (writer ${first_bar.writer}); now ${J(await bar(page))}; ${quiet === true ? "" : quiet} ${freed === true ? "" : freed}`);

    await openBoard(page, "second");
    await shown("5 second board", page, second, ["diamond", "text", "text"]);
    await check("5 the second board's page is a reader too", isReader(await bar(page)), J(await bar(page)));

    await check("4 the page made no call that writes a board, and the files and revisions are as the agent left them",
      writes().filter((w) => /^(PUT|PATCH|DELETE) |\/(scene|take|release|rpc-reply)\b/.test(w)).length === 0 &&
      files.first === fs.readFileSync(path.join(boardDir(first), "drawing.excalidraw"), "utf8") && files.second === fs.readFileSync(path.join(boardDir(second), "drawing.excalidraw"), "utf8") &&
      revs.first === storedRev(first) && revs.second === storedRev(second), `calls: ${J(writes())}; revs ${J(revs)} then ${J({ first: storedRev(first), second: storedRev(second) })}`);
    await check("4 the page's console has no error and no request failed", page.errors.length === 0 && page.failedRequests.length === 0, [...new Set([...page.errors, ...page.failedRequests])].slice(0, 5).join(" ; "));
  });
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host?.close().catch(() => {});
}
page = null;
const end = A ? await finish([A]) : { alive: [], free: true };
const headlessLeft = headlessPid ? await holds("the headless writer is gone", () => { try { process.kill(headlessPid, 0); return false; } catch { return true; } }, { timeout: 15000 }) : true;
if (A?.port && !(await check("the server is stopped, its port is free and the headless writer is gone", end.free && end.alive.length === 0 && headlessLeft === true, `port ${A.port}; processes left: ${end.alive.join(", ") || "none"}; headless pid ${headlessPid}: ${headlessLeft === true ? "gone" : headlessLeft}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? `# passed (${n} checks)` : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
