// Voice against a real server, and the key's whole life, through the real page (voice-chats goal 4.1, 4.2, 6.1, 6.3, 6.7;
// plans/voice-chats/architecture.md §14.3), and the names of the audio devices (voice-devices goal 4.7, 6.1, 6.6;
// plans/voice-devices/architecture.md §12.3).
//
// A spoken turn is an ordinary chat message: the server sees the same calls and the same message it sees for a typed one, and nothing of
// voice. The key never leaves the device except as the `xi-api-key` header to the voice service. This script runs the app's web build through
// the test host (web/dev/host.mjs) against a scratch server with the stand-in agent (internal/agenttest/fake-claude), and the voice service
// is the stand-in of web/dev/voicestandin.mjs that the host mounts at /voice (voice: true). The page's microphone is the checks' (web/dev/
// checks/mic.mjs: Chromium's fake device, or a synthetic stream where that never answers). It spends no money: no call to ElevenLabs or to a
// model, no key but the canary below. The devices are the stand-ins of web/dev/checks/devices.mjs (persist: false, so that no name is kept in
// the tab's sessionStorage by the stand-in), named CANARY-MIC-<random> and CANARY-OUT-<random>.
//
// It never touches the installed app: the script builds its own binary and its own build of the page into a temp folder (the version
// "uicheck", so that the page has the checks' seam `window.__aiwbVoice`; a build named by DIST has it or not, and what needs it is skipped),
// sets a server up there on a temp data folder and free ports, and stops it at the end. Not part of `npm test`.
//
//   cd web && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/voice.e2e.mjs
//
// Steps:
//   1 a page that never used voice (with the stand-in devices, which count): no request to /voice, no getUserMedia call, no enumerateDevices
//     call, nothing logged by the voice service; it chats in text
//   2 Settings > Voice with a canary key (sk_test_CANARY_<random>): Test key finds the stand-in's six voices, Save keeps the key in memory
//   3 speech mode: the scripted words become a message on the server by the calls a typed message makes (compared with a typed one), the
//     stored message has the words and no audio, it carries the mic mark in this window, and the model's reply is spoken sentence by sentence
//   4 Dictate puts words in the box and sends nothing; Read aloud speaks a message
//   5 a rejected key and an empty plan: each shows its sentence, none of them holds the key
//   6 the search for the canary (where it must not be): the page's storage (localStorage, sessionStorage, IndexedDB, cookies, caches), every
//     request the page made and every answer to a call, the voice service's socket, the console, the page's text, the server's data folder
//     and log, the host's state and log, what the agent was given, this script's output. The voice service saw it only as the header of
//     its token, voices and TTS requests, and its socket only with a token
//   7 the web build keeps the key in memory only: after a reload it is gone (Settings, the no-key popover), and Remove clears it
//   8 device names: a page with a microphone and a speaker named CANARY-MIC-<random> and CANARY-OUT-<random> lists them in Settings (Test
//     microphone grants the permission), picks both, Test speaker, then a spoken turn and its spoken reply: the microphone really heard
//     (the stand-in service hears its tone) and the speaker really played (its sink id); then the search for the two names: not in any request or
//     answer of the page (the voice service's included), the socket, the console, the voice service's log, the server's folders and log, the
//     host's state and log, what the agent was given; in the page's storage only as the saved choice (localStorage `aiwb.voice.settings`); the
//     voice service saw nothing of the choosing, listing and testing
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a screenshot for a failed check, and exits with
// 1 when a check failed (2 when it could not run). Neither the canary nor a device name appears in a line it prints.
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve; the default is a build of this script's own with the version "uicheck"
//   AIWB_MIC           device | synthetic               (web/dev/checks/mic.mjs: the microphone, probed by default)
//   AIWB_E2E_KEEP=1    keep the temp folder after a run that passed; after a failed run it is always kept, and its path is printed
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launchChromium, loadPlaywright } from "../dev/shot.mjs";
import { useMic } from "../dev/checks/mic.mjs";
import { installDevices } from "../dev/checks/devices.mjs";
import { pressAct } from "../dev/checks/fork.mjs";
import { Scratch, buildPage, finish, hostCall, hostFor, makeOut, onSignal, openPage as openHostPage, serverBinary, sleep, standInAgent, waitFor, writesFrom } from "./lib/rig.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;

const OUT = makeOut("voice");
const CANARY = `sk_test_CANARY_${crypto.randomBytes(6).toString("hex")}`;
const BAD = `bad-${CANARY}`; // a key the voice service rejects, with the canary in it, to see what a rejection shows
// the stand-in devices of step 8 (and of step 1, which counts the calls): the ids carry no name, the labels are what the person sees
const MIC = { id: "canary-mic", label: `CANARY-MIC-${crypto.randomBytes(6).toString("hex")}`, hz: 523 };
const SPK = { id: "canary-out", label: `CANARY-OUT-${crypto.randomBytes(6).toString("hex")}` };
const NAMES = [MIC.label, SPK.label];
const scrub = (s) => String(s).split(CANARY).join("<canary>").split(MIC.label).join("<mic-name>").split(SPK.label).join("<out-name>");

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null;
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  const d = scrub(seen).replace(/\s+/g, " ").trim();
  if (pass === true) console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`);
  else {
    failed++;
    const extra = [];
    if (typeof pass === "string") extra.push(scrub(pass));
    if (page) {
      const errs = page.errors.slice(told.errors), reqs = page.failedRequests.slice(told.requests);
      if (errs.length) extra.push(`console: ${errs.slice(-4).map(scrub).join(" ; ")}`);
      if (reqs.length) extra.push(`requests: ${reqs.slice(-6).map(scrub).join(" ; ")}`);
      const file = path.join(OUT, `fail-${n}.png`);
      await page.screenshot({ path: file }).then(() => extra.push(`screenshot ${file}`), () => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
const skipped = (what, why) => console.log(`skip - ${what}  (${why})`);
const note = (line) => console.log(`# ${scrub(line)}`);
async function step(name, fn) {
  try { await fn(); } catch (e) { await check(`${name}: the step ran to its end`, false, e.stack || e.message); }
}

// ---- the scratch server, the host with the voice service, the page

let A = null;
let host = null;
let browser = null;
const keysSeen = [];   // every key the voice service was shown in a header, in order
const hostLog = [];    // every line the host logged
const agentLog = path.join(OUT, "a", "fake-claude.log");
let distDir = "";
let seam = true;       // whether the page has the checks' seam (a build made with the version "uicheck")
const recs = [];       // what each page opened here did, for the search

async function prepare() {
  fs.mkdirSync(path.dirname(agentLog), { recursive: true });
  if (!(process.env.DIST || process.env.AIWB_E2E_CLIENT)) process.env.DIST = distDir = buildPage(path.join(OUT, "app-dist"), { version: "uicheck" });
  const bin = serverBinary(OUT);
  A = new Scratch({
    out: OUT, bin, agent: standInAgent(OUT), tag: "a", name: "This computer",
    envFn: () => ({ ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: A.cursorCfg, FAKE_CLAUDE_LOG: agentLog }),
  });
  await A.setUp();
  host = await hostFor({
    out: OUT, name: "a", local: A,
    extra: { voice: { keys: (k) => { keysSeen.push(k); return /^sk_test_/.test(k); } }, log: (line) => hostLog.push(line) },
  });
}

const control = () => host.voice.control;
const voiceLog = () => control().log();

/** What a page did, kept for the search: every request (url, headers, body), every answer to a call, the sockets' frames and the console. */
function record(p, tag) {
  const rec = { tag, requests: [], answers: [], sockets: [], console: [], gum: 0 };
  recs.push(rec);
  p.rec = rec;
  p.on("request", (r) => rec.requests.push({ url: r.url(), method: r.method(), headers: r.headers(), post: r.postData() ?? "" }));
  p.on("response", (r) => {
    const type = r.headers()["content-type"] ?? "";
    if (!/json|text/.test(type) || /event-stream/.test(type)) return;
    r.text().then((body) => rec.answers.push({ url: r.url(), status: r.status(), body }), () => {});
  });
  p.on("websocket", (ws) => {
    const s = { url: ws.url(), sent: [], received: [] };
    rec.sockets.push(s);
    ws.on("framesent", (f) => s.sent.push(typeof f.payload === "string" ? f.payload : "<binary>"));
    ws.on("framereceived", (f) => s.received.push(typeof f.payload === "string" ? f.payload : "<binary>"));
  });
  p.on("console", (m) => rec.console.push(`${m.type()}: ${m.text()}`));
  p.on("pageerror", (e) => rec.console.push(`uncaught: ${e.message}`));
}

/** A page of the host in a context of its own, its calls to getUserMedia counted from before the app runs (window.__gum). */
async function openPage(tag, { devices = false } = {}) {
  const p = await openHostPage(browser, host, { context: { viewport: { width: 1400, height: 900 }, permissions: ["microphone"] }, wait: q.rootVisible, timeout: 8000 });
  record(p, tag);
  // (before the counting script below, which wraps the stand-in's getUserMedia; the first load is without them, they are there from the reload)
  if (devices) await installDevices(p.ctx, { inputs: [MIC], outputs: [SPK], granted: false, persist: false });
  await p.ctx.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = (...a) => { window.__gum++; return real(...a); };
  });
  await p.reload(); // (the init script is there from the next load)
  await p.waitForSelector(q.rootVisible, { timeout: 15000 });
  await ui.stateOfSection(p, "local").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  await p.locator(`${q.newBtn}:not([disabled])`).waitFor({ timeout: 20000 });
  seam = await p.evaluate(() => !!window.__aiwbVoice);
  return p;
}

const stateOf = async () => (await hostCall(host, "local", "GET", "/api/state")).json;
const itemsOf = async (chat) => (await hostCall(host, "local", "GET", `/api/chats/${chat}/items`)).json?.items ?? [];

/** "+" → "New chat", and the chat it makes is the one on screen. */
async function newChat(p) {
  const before = new Set((await stateOf()).chats.map((c) => c.id));
  await ui.click(p, p.locator(q.newBtn));
  await ui.click(p, ui.menuItem(p, "New chat"));
  const id = await waitFor("a new chat is selected", async () => { const c = (await ui.selection(p)).chat; return c && !before.has(c) ? c : null; });
  await ui.box(p).waitFor();
  return id;
}

const assistantTexts = (p) => p.locator(q.msgAssistant).allInnerTexts();
const gone = (loc, timeout = 10000) => waitFor("it is gone", async () => (await loc.count()) === 0, { timeout }).then(() => true, (e) => e.message);
const shownIn = (loc, timeout = 15000) => waitFor("it is shown", () => loc.first().isVisible().catch(() => false), { timeout }).then(() => true, (e) => e.message);
const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const seamCall = (p, fn, arg) => p.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`);
const phase = (p) => p.evaluate(() => window.__aiwbVoice?.state().session.phase ?? null);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The calls that change something, with the ids of a chat made the same, so that two turns can be compared. */
const shape = (calls) => calls.map((c) => c.replace(/\/chats\/[A-Za-z0-9_-]+/g, "/chats/<id>"));

// ---- the search for the canary

const needle = Buffer.from(CANARY);
/** Every file under `dir` that holds the canary (a file bigger than 64 MB is not read). */
function filesWith(dir, what = needle) {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        try { if (fs.statSync(f).size <= (64 << 20) && fs.readFileSync(f).includes(what)) found.push(f); } catch { /* gone */ }
      }
    }
  };
  walk(dir);
  return found;
}

/** What a page holds in its storage, by store: localStorage, sessionStorage, every IndexedDB store, the Cache storage and the cookies. */
async function storageOf(p) {
  const inPage = await p.evaluate(async () => {
    const out = { local: {}, session: {}, idb: [], caches: [] };
    for (const [store, into] of [[localStorage, out.local], [sessionStorage, out.session]]) for (let i = 0; i < store.length; i++) { const k = store.key(i); into[k] = store.getItem(k); }
    try {
      for (const info of (await indexedDB.databases?.()) ?? []) {
        const db = await new Promise((ok, no) => { const r = indexedDB.open(info.name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        for (const name of db.objectStoreNames) {
          const rows = await new Promise((ok, no) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          out.idb.push({ db: info.name, store: name, rows: JSON.stringify(rows) });
        }
        db.close();
      }
    } catch (e) { out.idb.push({ error: String(e) }); }
    try { out.caches = await caches.keys(); } catch { /* none */ }
    return out;
  });
  return { ...inPage, cookies: await p.ctx.cookies() };
}
/** The same as one text. */
const storageText = async (p) => JSON.stringify(await storageOf(p));

/** What the page shows now: its text, its markup and the value of every box. */
const shownText = (p) => p.evaluate(() => [document.body.innerText, document.documentElement.outerHTML, ...[...document.querySelectorAll("input, textarea")].map((e) => e.value + " " + (e.getAttribute("placeholder") ?? ""))].join("\n"));

/** Where `what` (the canary key, or a device name) is in a page's record: the places it must not be. A request to the voice service carries the key
 *  in its `xi-api-key` header only; a device name is allowed nowhere. */
function leaksOf(rec, what = CANARY) {
  const at = [];
  const has = (s) => String(s).includes(what);
  for (const r of rec.requests) {
    const voice = what === CANARY && new URL(r.url).pathname.startsWith("/voice/");
    const headers = Object.entries(r.headers).filter(([k, v]) => has(v) && !(voice && k.toLowerCase() === "xi-api-key")).map(([k]) => k);
    if (has(r.url)) at.push(`${rec.tag}: the address of ${r.method} ${new URL(r.url).pathname}`);
    if (has(r.post)) at.push(`${rec.tag}: the body of ${r.method} ${new URL(r.url).pathname}`);
    for (const h of headers) at.push(`${rec.tag}: the header ${h} of ${r.method} ${new URL(r.url).pathname}`);
  }
  for (const a of rec.answers) if (has(a.body) || has(a.url)) at.push(`${rec.tag}: the answer to ${new URL(a.url).pathname}`);
  for (const s of rec.sockets) if (has(s.url) || s.sent.some(has) || s.received.some(has)) at.push(`${rec.tag}: the socket ${new URL(s.url).pathname}`);
  for (const c of rec.console) if (has(c)) at.push(`${rec.tag}: the console`);
  return at;
}

// ---- step 1: a page that never used voice

async function step1() {
  voiceReset();
  const p = await openPage("never", { devices: true });
  page = p;
  await newChat(p);
  await ui.send(p, "no voice here");
  const got = await waitFor("the stand-in agent answers", async () => (await assistantTexts(p)).some((t) => t.includes("FAKE(") && t.includes("no voice here")), { timeout: 30000 }).then(() => true, (e) => e.message);
  await check("1 a page that never used voice chats in text with the stand-in agent", got === true, got === true ? "" : got);
  await sleep(500);
  const toVoice = p.rec.requests.filter((r) => new URL(r.url).pathname.startsWith("/voice"));
  const gum = await p.evaluate(() => window.__gum);
  await check("1 it made no request to /voice and no getUserMedia call", toVoice.length === 0 && gum === 0, `requests to /voice: ${toVoice.map((r) => r.url).join(", ") || "none"}; getUserMedia calls: ${gum}`);
  // (the stand-in devices count what the page asked of them, from the reload on; a page that lists devices at its start would show here)
  const asked = await p.evaluate(() => window.__aiwbDevices?.calls() ?? null);
  await check("1 it made no enumerateDevices, getUserMedia or setSinkId call", !!asked && asked.enumerateDevices === 0 && asked.getUserMedia === 0 && asked.setSinkId === 0, asked ? JSON.stringify(asked) : "the page has no device stand-in");
  await check("1 the voice service saw nothing", voiceLog().length === 0, `its log has ${voiceLog().length} entries`);
  await check("1 no socket was opened and no key was asked for", p.rec.sockets.length === 0 && keysSeen.length === 0, `sockets ${p.rec.sockets.length}, keys shown ${keysSeen.length}`);
  page = null;
  await p.ctx.close();
}
const voiceReset = () => control().reset();

// ---- steps 2 to 5: the voice page

const SAID = "Please tell me three things. First the plan. Second the boxes. Third the arrows.";
let main = null;
let devs = null;
let chatId = "";
let spokenWrites = [];

async function savedKey(p) {
  await ui.openVoiceSettings(p);
  // a rejected key: its sentence, and neither the sentence nor the page's text holds the key that was typed
  await p.locator(q.voiceKey).fill(BAD);
  await ui.click(p, p.locator(q.voiceKeyTest));
  const rejected = await waitFor("Test key answers", async () => /accept/.test(await textOf(p.locator(q.voiceKeyResult))), { timeout: 20000 }).then(() => textOf(p.locator(q.voiceKeyResult)), (e) => e.message);
  const shown = await p.evaluate(() => document.body.innerText);
  await check("2 Test key with a rejected key says so, and no sentence on the page holds the key typed", rejected === "ElevenLabs did not accept this key." && !shown.includes(CANARY), rejected);
  await p.locator(q.voiceKey).fill(CANARY);
  await ui.click(p, p.locator(q.voiceKeyTest));
  const works = await waitFor("Test key answers", async () => /Works/.test(await textOf(p.locator(q.voiceKeyResult))), { timeout: 20000 }).then(() => textOf(p.locator(q.voiceKeyResult)), (e) => e.message);
  await check("2 Test key finds the stand-in's voices with the key typed in the secret box", works === "Works: 6 voices found.", works);
  await ui.click(p, p.locator(q.voiceKeySave));
  const kept = await waitFor("the key is saved", async () => (await p.locator(q.voiceKeyRemove).count()) > 0, { timeout: 10000 }).then(() => true, (e) => e.message);
  await check("2 Save keeps the key: the box empties and Remove is offered", kept === true && (await p.locator(q.voiceKey).inputValue()) === "", kept === true ? "" : kept);
  await ui.closeVoiceSettings(p);
}

async function step2to5() {
  main = await openPage("voice");
  page = main;
  await useMic(main, note);
  chatId = await newChat(main);
  await step("2 the key", () => savedKey(main));
  const log2 = voiceLog();
  await check("2 the voice service saw the keys as the header of the voices call only", log2.length > 0 && log2.every((e) => e.kind === "voices" && e.keyHeader && !e.token), log2.map((e) => `${e.kind}${e.keyHeader ? "+header" : ""}`).join(", "));

  await step("3 speech mode", step3);
  await step("4 dictation and Read aloud", step4);
  await step("5 a rejected key and an empty plan", step5);
}

async function step3() {
  const p = main;
  voiceReset();
  control().script([{ after: 3, partial: "please tell" }, { after: 6, committed: SAID }]);
  const base = writesFrom(p);
  await ui.pressVoiceControl(p, q.voiceSpeech, q.moreSpeech);
  const listening = await waitFor("speech mode listens", async () => (await p.locator(q.speechBar).count()) > 0 && (!seam || (await phase(p)) !== "starting"), { timeout: 30000 }).then(() => true, (e) => e.message);
  await check("3 speech mode starts: the speech bar is shown", listening === true, listening === true ? "" : `${listening}; session ${seam ? JSON.stringify(await p.evaluate(() => window.__aiwbVoice.state())) : "?"}`);

  // the words become a message: the stored message is the words, once the pause has run out
  const stored = await waitFor("the spoken message is stored on the server", async () => (await itemsOf(chatId)).find((i) => (i.text ?? "") === SAID), { timeout: 40000 }).then((x) => x, (e) => e.message);
  const item = typeof stored === "object" ? stored : null;
  await check("3 the spoken words are a message on the server", !!item, item ? "" : String(stored));
  if (item) {
    const known = new Set(["kind", "role", "text", "id", "at", "time", "ts", "done", "context", "references", "images", "branch", "n", "index", "label", "seq", "uuid", "created", "updated"]);
    const odd = Object.keys(item).filter((k) => !known.has(k));
    await check("3 the stored message holds the text and nothing of voice or audio", odd.length === 0 && !/audio|voice|mic|speech|spoken/i.test(JSON.stringify(item).replace(SAID, "")), `its fields: ${Object.keys(item).join(", ")}; unknown: ${odd.join(", ") || "none"}`);
  }
  spokenWrites = shape(base());
  const posted = p.rec.requests.filter((r) => r.method === "POST" && /\/host\/call/.test(r.url) && /messages/.test(decodeURIComponent(r.url)) && !r.post.includes("typed one"));
  await check("3 one call sent the message, with the text and no audio", posted.length === 1 && /"text"/.test(posted[0].post) && !/audio|base_64|xi-api-key/.test(posted[0].post), posted.map((r) => r.post).join(" | ").slice(0, 300));

  // the mic mark is this window's
  const mine = p.locator(q.msgUser).filter({ hasText: "Please tell me three things" }).last();
  const marked = await waitFor("the mic mark", async () => (await mine.locator(q.micMark).count()) === 1, { timeout: 10000 }).then(() => true, (e) => e.message);
  await check("3 the spoken message carries the mic mark in this window", marked === true, marked === true ? "" : marked);

  // the reply of the stand-in agent, spoken sentence by sentence
  const reply = await waitFor("the agent's reply is stored", async () => (await itemsOf(chatId)).find((i) => /FAKE\(/.test(i.text ?? "") && (i.text ?? "").includes("Third")), { timeout: 40000 }).then((x) => x, (e) => e.message);
  const replyText = typeof reply === "object" ? reply.text : "";
  await check("3 the stand-in agent answered the spoken turn", !!replyText, replyText || String(reply));
  const tts = await waitFor("the reply is spoken", async () => { const t = voiceLog().filter((e) => e.kind === "tts"); return t.length >= 4 && t.every((e) => e.finishedAt || e.cancelled) ? t : null; }, { timeout: 60000 }).then((x) => x, (e) => e.message);
  const spoken = Array.isArray(tts) ? tts : voiceLog().filter((e) => e.kind === "tts");
  await check("3 the reply is spoken sentence by sentence: one request for each, in order, none for the whole", Array.isArray(tts) && spoken.length >= 4 && spoken.every((e) => e.text.length < replyText.length) && spoken.every((e, i) => !i || e.at >= spoken[i - 1].at) && norm(spoken.map((e) => e.text).join(" ")) === norm(replyText),
    `${spoken.length} requests: ${JSON.stringify(spoken.map((e) => e.text))}; the reply: ${JSON.stringify(replyText)}`);
  await check("3 the voice service saw nothing against its protocol", voiceLog().every((e) => !e.problems?.length), JSON.stringify(voiceLog().flatMap((e) => e.problems ?? [])));
  const stt = voiceLog().filter((e) => e.kind === "stt");
  await check("3 the listening socket was opened with a single-use token, never with the key, and carried 16 kHz audio of about 100 ms", stt.length === 1 && stt[0].token && !stt[0].keyHeader && stt[0].sampleRates.join() === "16000" && stt[0].chunks > 5 && stt[0].chunkMsMin >= 50 && stt[0].chunkMsMax <= 300,
    stt.map((e) => `token ${e.token}, header ${e.keyHeader}, rates ${e.sampleRates}, chunks ${e.chunks}, ${e.chunkMsMin}-${e.chunkMsMax} ms`).join("; ") || "no socket");
  if (seam) {
    const pl = await p.evaluate(() => window.__aiwbVoice.player());
    const last = spoken[spoken.length - 1];
    await check("3 the first sentence was playing before the last one was finished", !!pl.firstWriteAt && (!last?.finishedAt || pl.firstWriteAt < last.finishedAt), `first write ${pl.firstWriteAt}, last sentence finished ${last?.finishedAt}`);
  } else skipped("3 the first sentence was playing before the last one was finished", "the page has no seam (a build that is not the checks')");

  // a typed message makes the same calls, and has no mark
  await waitFor("speech mode listens again after the reply", async () => !seam || (await phase(p)) === "listening", { timeout: 40000 }).catch(() => {});
  const was = voiceLog().filter((e) => e.kind === "stt")[0]?.chunks ?? 0;
  await ui.click(p, p.locator(q.speechEnd));
  const over = await gone(p.locator(q.speechBar), 10000);
  await sleep(700);
  const after = voiceLog().filter((e) => e.kind === "stt")[0];
  await check("3 End closes the socket and no audio goes up after it", over === true && after.closeCode !== null && after.chunks - was < 8, `closed ${after.closeCode}, chunks ${was} -> ${after.chunks}`);

  const typed = writesFrom(p);
  await ui.box(p).waitFor();
  await ui.send(p, "a typed one");
  const typedItem = await waitFor("the typed message is stored", async () => (await itemsOf(chatId)).find((i) => (i.text ?? "") === "a typed one"), { timeout: 30000 }).then((x) => x, (e) => e.message);
  await waitFor("the agent answers it", async () => (await assistantTexts(p)).some((t) => t.includes("a typed one")), { timeout: 30000 }).catch(() => {});
  const typedShape = shape(typed());
  await check("3 a typed message is sent by the same calls as the spoken one", typeof typedItem === "object" && JSON.stringify([...new Set(typedShape)].sort()) === JSON.stringify([...new Set(spokenWrites)].sort()),
    `spoken: ${JSON.stringify([...new Set(spokenWrites)])}; typed: ${JSON.stringify([...new Set(typedShape)])}`);
  await check("3 a typed message has no mic mark, and the thread has just the one", (await p.locator(q.msgUser).filter({ hasText: "a typed one" }).locator(q.micMark).count()) === 0 && (await p.locator(q.micMark).count()) === 1, `${await p.locator(q.micMark).count()} marks`);
}

async function step4() {
  const p = main;
  // Dictate: words in the box, nothing sent
  voiceReset();
  const calls = writesFrom(p); // (the box saves a draft as it changes, as it does for typing: that is no send)
  const sends = () => calls().filter((c) => /\/messages(\?|$)/.test(c));
  await ui.box(p).waitFor();
  control().script([{ after: 3, partial: "dictated" }, { after: 6, committed: "dictated words" }]);
  await ui.pressVoiceControl(p, q.voiceDictate, q.moreDictate);
  const words = await waitFor("the dictated words are in the box", async () => (await ui.boxText(p)).includes("dictated words"), { timeout: 30000 }).then(() => true, (e) => e.message);
  await sleep(2500); // (well past the pause of Auto-send: dictation never sends)
  await check("4 Dictate puts the words in the box and sends nothing", words === true && sends().length === 0, `box ${JSON.stringify(await ui.boxText(p))}; writes ${JSON.stringify(calls())}`);
  await ui.pressVoiceControl(p, q.voiceDictate, q.moreDictate); // (a second press stops)
  const idle = await waitFor("dictation stops", async () => !seam || (await phase(p)) === "idle", { timeout: 15000 }).then(() => true, (e) => e.message);
  await check("4 a second press stops Dictate and its socket", idle === true && voiceLog().filter((e) => e.kind === "stt").every((e) => e.closeCode !== null), idle === true ? "" : idle);
  await ui.click(p, ui.box(p));
  await p.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await p.keyboard.press("Backspace");

  // Read aloud on the model's reply
  voiceReset();
  const reply = p.locator(q.msgAssistant).filter({ hasText: "Third" }).last();
  await pressAct(p, reply, "read");
  const read = await waitFor("the reply is read", async () => voiceLog().filter((e) => e.kind === "tts").length >= 4, { timeout: 40000 }).then(() => true, (e) => e.message);
  await waitFor("reading ends", async () => (await p.locator(q.voiceReading).count()) === 0, { timeout: 40000 }).catch(() => {});
  const tts = voiceLog().filter((e) => e.kind === "tts");
  await check("4 Read aloud speaks the reply by the key's header, sentence by sentence", read === true && tts.every((e) => e.keyHeader && !e.token) && !tts.some((e) => /[*_`#<>]|:\/\//.test(e.text)), `${tts.length} requests: ${JSON.stringify(tts.map((e) => e.text))}`);
}

/** The text of the popover that is on the page (waited for), its kind and its buttons; null when none comes. */
async function problemShown(p) {
  const ok = await waitFor("the popover", async () => (await p.locator(q.voiceProblem).count()) > 0, { timeout: 15000 }).then(() => true, () => false);
  if (!ok) return null;
  const pop = p.locator(q.voiceProblem).first();
  return { kind: await pop.getAttribute("data-kind"), text: await textOf(p.locator(q.voiceProblemText)), buttons: (await pop.getByRole("button").allTextContents()).map((s) => s.trim()) };
}

async function step5() {
  const p = main;
  await ui.box(p).waitFor();
  const reply = p.locator(q.msgAssistant).filter({ hasText: "Third" }).last();
  for (const [name, fail, kind, sentence, act] of [
    ["a rejected key", "key_rejected", "key_rejected", "ElevenLabs did not accept this key.", "Open Settings"],
    ["an empty plan", "no_credits", "no_credits", "Your ElevenLabs plan has no credits left.", "Open ElevenLabs"],
    ["a service that cannot be reached", "offline", "offline", "Can't reach ElevenLabs.", "Try again"],
  ]) {
    voiceReset();
    control().fail(fail);
    await pressAct(p, reply, "read");
    const pop = await problemShown(p);
    await check(`5 ${name}: Read aloud shows its sentence and its action`, !!pop && pop.kind === kind && pop.text === sentence && pop.buttons.join() === `Not now,${act}`, pop ? JSON.stringify(pop) : "no popover");
    const html = await shownText(p);
    await check(`5 ${name}: nothing shown holds the key`, !html.includes(CANARY), "");
    if (pop) await ui.click(p, p.locator(q.voiceProblemDismiss));
    await gone(p.locator(q.voiceProblem));
    control().fail(null);
  }
}

// ---- step 6: the search

const stateFiles = () => [path.join(OUT, "state-a")];

async function search(when) {
  await sleep(500);
  const found = [];
  for (const rec of recs) found.push(...leaksOf(rec));
  for (const pg of [main, devs]) {
    if (!pg || pg.isClosed()) continue;
    const stored = await storageText(pg);
    if (stored.includes(CANARY)) found.push(`the page's storage (localStorage, sessionStorage, IndexedDB, caches or cookies) of ${pg.rec.tag}`);
    if ((await shownText(pg)).includes(CANARY)) found.push(`the text, markup or boxes of ${pg.rec.tag}`);
  }
  for (const f of filesWith(A.home)) found.push(`the server's data folder: ${path.relative(OUT, f)}`);
  for (const f of filesWith(A.work)) found.push(`the server's work folder: ${path.relative(OUT, f)}`);
  for (const dir of stateFiles()) for (const f of filesWith(dir)) found.push(`the host's state: ${path.relative(OUT, f)}`);
  if (fs.existsSync(agentLog) && fs.readFileSync(agentLog).includes(needle)) found.push("what the agent was given (fake-claude.log)");
  if (hostLog.some((l) => l.includes(CANARY))) found.push("the host's log");
  await check(`6 ${when}: the canary is in none of the places it must not be`, found.length === 0, found.join("; "));
}

/** The search finds the canary where it is put: in the page's storage, in a file, in a request's body, a header, an answer and a socket. */
async function searchWorks() {
  const p = main;
  await p.evaluate((k) => localStorage.setItem("probe", k), CANARY);
  const inStorage = (await storageText(p)).includes(CANARY);
  await p.evaluate(() => localStorage.removeItem("probe"));
  const dir = path.join(OUT, "probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "x.log"), `a line with ${CANARY} in it\n`);
  const inFile = filesWith(dir).length === 1;
  fs.rmSync(dir, { recursive: true, force: true });
  const rec = { tag: "probe", requests: [
    { url: "http://x/host/call", method: "POST", headers: {}, post: `{"a":"${CANARY}"}` },
    { url: "http://x/host/call", method: "POST", headers: { "x-other": CANARY }, post: "" },
    { url: "http://x/voice/v2/voices", method: "GET", headers: { "xi-api-key": CANARY }, post: "" },
    { url: `http://x/voice/v2/voices?k=${CANARY}`, method: "GET", headers: {}, post: "" },
  ], answers: [{ url: "http://x/host/call", status: 400, body: CANARY }], sockets: [{ url: "ws://x/voice/s", sent: [CANARY], received: [] }], console: [`error: ${CANARY}`] };
  const at = leaksOf(rec);
  const allowed = leaksOf({ ...rec, requests: [rec.requests[2]], answers: [], sockets: [], console: [] });
  await check("6 the search itself finds a canary in storage, a file, a body, a header, an address, an answer, a socket and the console, and lets the voice header pass",
    inStorage && inFile && at.length === 6 && allowed.length === 0, `storage ${inStorage}, file ${inFile}, found ${at.length} of 6 in the record, ${allowed.length} in the allowed header`);
}

/** The same probe for a device name: found in the same six places, and now in the voice service's header as well (the name is allowed nowhere). */
async function searchWorksForNames() {
  const probes = [];
  for (const name of NAMES) {
    const rec = { tag: "probe", requests: [
      { url: "http://x/host/call", method: "POST", headers: {}, post: `{"a":"${name}"}` },
      { url: "http://x/host/call", method: "POST", headers: { "x-other": name }, post: "" },
      { url: "http://x/voice/v2/voices", method: "GET", headers: { "xi-api-key": name }, post: "" },
      { url: `http://x/voice/v2/voices?k=${name}`, method: "GET", headers: {}, post: "" },
    ], answers: [{ url: "http://x/host/call", status: 400, body: name }], sockets: [{ url: "ws://x/voice/s", sent: [name], received: [] }], console: [`error: ${name}`] };
    const dir = path.join(OUT, "probe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.log"), `a line with ${name} in it\n`);
    const inFile = filesWith(dir, Buffer.from(name)).length === 1;
    fs.rmSync(dir, { recursive: true, force: true });
    probes.push({ found: leaksOf(rec, name).length, inFile });
  }
  await check("6 the search finds a device name in a file, a body, a header (the voice service's too), an address, an answer, a socket and the console",
    probes.every((x) => x.found === 7 && x.inFile), probes.map((x) => `found ${x.found} of 7 in the record, file ${x.inFile}`).join("; "));
}

async function audioSearch() {
  const marks = ["audio_base_64", "input_audio_chunk"];
  const bad = [];
  for (const rec of recs) {
    for (const r of rec.requests) if (!new URL(r.url).pathname.startsWith("/voice/") && marks.some((m) => r.post.includes(m) || r.url.includes(m))) bad.push(`${rec.tag}: ${new URL(r.url).pathname}`);
    for (const a of rec.answers) if (new URL(a.url).pathname.startsWith("/host/") && marks.some((m) => a.body.includes(m))) bad.push(`${rec.tag}: an answer to ${new URL(a.url).pathname}`);
  }
  for (const m of marks) for (const f of [...filesWith(A.home, Buffer.from(m)), ...(fs.existsSync(agentLog) && fs.readFileSync(agentLog).includes(m) ? [agentLog] : [])]) bad.push(path.relative(OUT, f));
  await check("6 no audio reached the server, its files, its log or the agent", bad.length === 0, bad.join("; "));
}

/** The paths of the voice service a key goes to: the token, the voices and a sentence's speech (a request that the stand-in refused as offline is one of them). */
const KEYED = /^\/voice\/(v1\/(single-use-token\/realtime_scribe|text-to-speech\/\w+\/stream)|v2\/voices)$/;

async function step6() {
  await searchWorks();
  await search("after a full run, with the key held in memory");
  await audioSearch();
  const log = voiceLog();
  const withKey = log.filter((e) => e.keyHeader);
  await check("6 the voice service was shown the key only as a header, on its token, voices and TTS requests", withKey.length > 0 && withKey.every((e) => KEYED.test(e.path)) && log.filter((e) => e.kind === "stt").every((e) => !e.keyHeader && e.token) && keysSeen.length > 0 && keysSeen.every((k) => k === CANARY || k === BAD),
    `with the header: ${[...new Set(withKey.map((e) => `${e.kind} ${e.path}`))].join(", ")}; sockets: ${log.filter((e) => e.kind === "stt").map((e) => `token ${e.token}, header ${e.keyHeader}`).join("; ") || "none"}; keys shown: ${keysSeen.length}`);
  const withKeyUrls = main.rec.requests.filter((r) => Object.entries(r.headers).some(([k, v]) => v.includes(CANARY)));
  await check("6 the page sent the key only in the xi-api-key header of requests to /voice", withKeyUrls.length > 0 && withKeyUrls.every((r) => new URL(r.url).pathname.startsWith("/voice/") && Object.entries(r.headers).filter(([, v]) => v.includes(CANARY)).every(([k]) => k.toLowerCase() === "xi-api-key")),
    withKeyUrls.map((r) => new URL(r.url).pathname).join(", "));
}

// ---- step 7: gone with the page

async function step7() {
  const p = main;
  voiceReset();
  await p.reload();
  await p.waitForSelector(q.rootVisible, { timeout: 15000 });
  await ui.stateOfSection(p, "local").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  await ui.openVoiceSettings(p);
  const saved = (await p.locator(q.voiceKeyRemove).count()) > 0 || (await p.locator(q.voiceKey).getAttribute("placeholder")) === "A key is saved on this device";
  await ui.click(p, p.locator(q.voiceKeyTest));
  const told = await waitFor("Test key answers", async () => /key/.test(await textOf(p.locator(q.voiceKeyResult))), { timeout: 15000 }).then(() => textOf(p.locator(q.voiceKeyResult)), (e) => e.message);
  await check("7 after a reload the web build has no key: Settings offers no Remove, Test key says the key is missing", !saved && told === "Voice needs your ElevenLabs key. It stays on this device.", `saved: ${saved}; Test key says ${JSON.stringify(told)}`);
  await ui.closeVoiceSettings(p);
  await ui.box(p).waitFor();
  await ui.pressVoiceControl(p, q.voiceDictate, q.moreDictate);
  const pop = await problemShown(p);
  await check("7 after a reload Dictate shows the no-key popover and asks the voice service for nothing", !!pop && pop.kind === "no_key" && pop.buttons.join() === "Not now,Open Settings" && voiceLog().length === 0, `${pop ? JSON.stringify(pop) : "no popover"}; service log ${voiceLog().length}`);
  if (pop) await ui.click(p, p.locator(q.voiceProblemDismiss));
  await search("after a reload");

  // Remove clears a key that is held
  await ui.openVoiceSettings(p);
  await p.locator(q.voiceKey).fill(CANARY);
  await ui.click(p, p.locator(q.voiceKeySave));
  await waitFor("the key is saved", async () => (await p.locator(q.voiceKeyRemove).count()) > 0, { timeout: 10000 });
  await ui.click(p, p.locator(q.voiceKeyRemove));
  await ui.click(p, ui.button(p.locator(`${q.dialog}`), "Remove key"));
  const removed = await waitFor("the key is removed", async () => (await p.locator(q.voiceKeyRemove).count()) === 0, { timeout: 10000 }).then(() => true, (e) => e.message);
  await ui.closeVoiceSettings(p);
  voiceReset();
  await ui.pressVoiceControl(p, q.voiceDictate, q.moreDictate);
  const again = await problemShown(p);
  await check("7 Remove key from this device clears it: the popover asks for a key again and nothing is requested", removed === true && again?.kind === "no_key" && voiceLog().length === 0, `${removed === true ? "" : removed}; ${again ? again.kind : "no popover"}; service log ${voiceLog().length}`);
  if (again) await ui.click(p, p.locator(q.voiceProblemDismiss));
  await search("after Remove");
}

// ---- step 8: device names

const tid = (p, id) => p.locator(`[data-testid="${id}"]`);
const devCall = (p, fn) => p.evaluate((f) => window.__aiwbDevices[f](), fn);

/** Opens a picker of the devices card and presses the item named `label` (exactly: "System default (<label>)" is another item) once the list holds it
 *  (the list fills after the permission); true when it was pressed, else what was seen. */
async function pickDevice(p, picker, label) {
  const named = new RegExp(`^[\\s✓]*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const done = await waitFor(`${picker} offers the device`, async () => {
    await ui.click(p, tid(p, picker));
    const item = p.locator(q.menuItem).filter({ hasText: named }).first();
    if (await item.isVisible().catch(() => false)) { await ui.click(p, item); await gone(p.locator(q.menu)); return true; }
    await p.keyboard.press("Escape");
    await gone(p.locator(q.menu));
    return false;
  }, { timeout: 20000, every: 300 }).then(() => true, (e) => e.message);
  return done;
}

async function step8() {
  voiceReset();
  const p = devs = await openPage("devices", { devices: true });
  page = p;
  chatId = await newChat(p);

  // Settings > Voice: the key, then the card. Before the permission the page lists no name at all.
  await ui.openVoiceSettings(p);
  await p.locator(q.voiceKey).fill(CANARY);
  await ui.click(p, p.locator(q.voiceKeySave));
  await waitFor("the key is saved", async () => (await p.locator(q.voiceKeyRemove).count()) > 0, { timeout: 10000 });
  voiceReset(); // (Save asks the voice service for its voices: that is the key's, not a device's)
  const blind = (await shownText(p));
  const gumBefore = (await devCall(p, "calls")).getUserMedia;
  await check("8 before the microphone is allowed the card lists no device name and asked for no microphone", NAMES.every((x) => !blind.includes(x)) && gumBefore === 0, `getUserMedia calls: ${gumBefore}`);

  // Test microphone is the tap that asks; then both devices are listed, chosen, and the microphone is tested and the speaker too
  await ui.click(p, tid(p, "vs-mic-test"));
  const meter = await shownIn(tid(p, "vs-mic-level"));
  const micPicked = await pickDevice(p, "vs-mic", MIC.label);
  const spkPicked = await pickDevice(p, "vs-speaker", SPK.label);
  await check("8 Test microphone lists the stand-in devices, and both can be chosen", meter === true && micPicked === true && spkPicked === true, `meter ${meter}; microphone ${micPicked}; speaker ${spkPicked}`);
  const shownMic = await textOf(tid(p, "vs-mic")), shownSpk = await textOf(tid(p, "vs-speaker"));
  await check("8 the pickers show the chosen devices", shownMic.includes(MIC.label) && shownSpk.includes(SPK.label), `microphone "${shownMic}", speaker "${shownSpk}"`);
  if (seam) {
    const saved = await p.evaluate(() => window.__aiwbVoice.settings());
    await check("8 the saved choice is the two devices", saved.mic?.id === MIC.id && saved.mic?.name === MIC.label && saved.speaker?.id === SPK.id && saved.speaker?.name === SPK.label, JSON.stringify({ mic: saved.mic?.id, speaker: saved.speaker?.id }));
  } else skipped("8 the saved choice is the two devices", "the page has no seam (a build that is not the checks')");
  const testing = await waitFor("the test microphone is opened", async () => (await devCall(p, "opened")).some((o) => o.deviceId === MIC.id && o.live), { timeout: 15000 }).then(() => true, (e) => e.message);
  await check("8 the microphone test goes on with the chosen microphone", testing === true, testing === true ? "" : testing);
  await ui.click(p, tid(p, "vs-mic-test")); // stops
  await ui.click(p, tid(p, "vs-speaker-test"));
  await waitFor("the speaker test plays on the chosen sink", async () => (await devCall(p, "sinks")).some((x) => x.sinkId === SPK.id), { timeout: 15000 }).catch(() => {});
  await waitFor("the speaker test ends", async () => (await tid(p, "vs-speaker-test").getAttribute("data-playing")) === "false", { timeout: 20000 }).catch(() => {});
  const sinks1 = await devCall(p, "sinks");
  await check("8 Test speaker played on the chosen output", sinks1.some((x) => x.sinkId === SPK.id), JSON.stringify(sinks1.map((x) => ({ sinkId: x.sinkId ? "<set>" : "", default: x.default }))));
  const idle = voiceLog();
  await check("8 choosing, listing and testing the devices made no request of the voice service", idle.length === 0, `${idle.length} entries: ${idle.map((e) => `${e.kind} ${e.path}`).join(", ")}`);
  await ui.closeVoiceSettings(p);

  // a spoken turn with the chosen devices, and its reply spoken
  voiceReset();
  control().script([{ after: 3, partial: "please tell" }, { after: 6, committed: SAID }]);
  await ui.box(p).waitFor();
  await ui.pressVoiceControl(p, q.voiceSpeech, q.moreSpeech);
  const stored = await waitFor("the spoken message is stored", async () => (await itemsOf(chatId)).find((i) => (i.text ?? "") === SAID), { timeout: 40000 }).then((x) => x, (e) => e.message);
  await check("8 a spoken turn with the chosen devices becomes a message", typeof stored === "object", typeof stored === "object" ? "" : String(stored));
  const spoken = await waitFor("the reply is spoken", async () => { const t = voiceLog().filter((e) => e.kind === "tts"); return t.length >= 1 && t.every((e) => e.finishedAt || e.cancelled) ? t : null; }, { timeout: 60000 }).then((x) => x, (e) => e.message);
  await check("8 the reply is spoken", Array.isArray(spoken), Array.isArray(spoken) ? `${spoken.length} requests` : String(spoken));
  const heard = voiceLog().filter((e) => e.kind === "stt");
  const hz = heard[0]?.toneHz ?? null;
  await check("8 the voice service heard the chosen microphone (its tone)", heard.length === 1 && hz !== null && Math.abs(hz - MIC.hz) <= MIC.hz * 0.05, `tone ${hz} Hz, expected about ${MIC.hz}; sockets ${heard.length}`);
  const opened = await devCall(p, "opened");
  await check("8 the microphone opened for the turn is the chosen one", opened.some((o) => o.deviceId === MIC.id && o.requested === MIC.id), JSON.stringify(opened.map((o) => ({ requested: o.requested, deviceId: o.deviceId, live: o.live }))));
  const sinks2 = await devCall(p, "sinks");
  await check("8 the reply played on the chosen output, and on no other sink", sinks2.length > 0 && sinks2.filter((x) => x.sinkId !== "").every((x) => x.sinkId === SPK.id) && sinks2.some((x) => x.sinkId === SPK.id && x.calls.includes(SPK.id)), JSON.stringify(sinks2.map((x) => ({ state: x.state, set: x.sinkId === SPK.id, default: x.default }))));
  await waitFor("speech mode listens again after the reply", async () => !seam || (await phase(p)) === "listening", { timeout: 40000 }).catch(() => {});
  await ui.click(p, p.locator(q.speechEnd));
  await gone(p.locator(q.speechBar), 10000);

  // the search for the two names
  await searchWorksForNames();
  await searchNames();
  await search("after the device run");
  page = null;
}

/** The search for the device names: they are in none of the places they must not be. The page shows them (it is the person's own choice) and keeps
 *  the saved choice in localStorage; nowhere else in its storage. */
async function searchNames() {
  await sleep(500);
  for (const [what, name] of [["microphone", MIC.label], ["speaker", SPK.label]]) {
    const needleOf = Buffer.from(name);
    const found = [];
    for (const rec of recs) found.push(...leaksOf(rec, name));
    if (voiceLog().some((e) => JSON.stringify(e).includes(name))) found.push("what the voice service logged");
    if (JSON.stringify(keysSeen).includes(name)) found.push("a key shown to the voice service");
    for (const f of filesWith(A.home, needleOf)) found.push(`the server's data folder: ${path.relative(OUT, f)}`);
    for (const f of filesWith(A.work, needleOf)) found.push(`the server's work folder: ${path.relative(OUT, f)}`);
    for (const dir of stateFiles()) for (const f of filesWith(dir, needleOf)) found.push(`the host's state: ${path.relative(OUT, f)}`);
    if (fs.existsSync(agentLog) && fs.readFileSync(agentLog).includes(needleOf)) found.push("what the agent was given (fake-claude.log)");
    if (hostLog.some((l) => l.includes(name))) found.push("the host's log");
    if (devs.errors.some((e) => e.includes(name))) found.push("the page's errors");
    await check(`8 the ${what}'s name is in none of the places it must not be (requests, answers, sockets, console, voice service, server, host, agent)`, found.length === 0, found.join("; "));
  }
  const st = await storageOf(devs);
  const where = [];
  for (const [k, v] of Object.entries(st.local)) if (NAMES.some((x) => String(v).includes(x))) where.push(`localStorage ${k}`);
  for (const k of ["session", "idb", "caches", "cookies"]) if (NAMES.some((x) => JSON.stringify(st[k]).includes(x))) where.push(k);
  await check("8 the page keeps the names only as the saved choice (localStorage aiwb.voice.settings), not in sessionStorage, IndexedDB, caches or cookies", where.join() === "localStorage aiwb.voice.settings", `kept in: ${where.join(", ") || "nowhere"}`);
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host?.close().catch(() => {}); if (A) await A.stop(); });
try {
  await prepare();
  console.log(`# server on ${A.info?.address ?? `https://127.0.0.1:${A.port}`}, host on ${host.url}; files in ${OUT}`);
  browser = await launchChromium(await loadPlaywright());
  const pid = host.client.localInfo()?.pid;
  if (pid) A.pids.push(pid);
  await step("1 a page that never used voice", step1);
  const pid2 = host.client.localInfo()?.pid;
  if (pid2 && !A.pids.includes(pid2)) A.pids.push(pid2);
  await step("2 to 5 the voice page", step2to5);
  await step("6 the search", step6);
  await step("7 gone with the page", step7);
  await step("8 device names", step8);
  if (main) {
    // (the browser's own line for a call answered 400 or more, which step 5 makes on purpose, names no address)
    const errors = [...new Set([...main.errors, ...(devs?.errors ?? [])])].filter((e) => !/^Failed to load resource/.test(e));
    await check("the page's console has no error", errors.length === 0, errors.slice(0, 5).join(" ; "));
  }
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${scrub(e.stack || e)}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host?.close().catch(() => {});
}
page = null;
const end = A ? await finish([A]) : { alive: [], free: true };
if (A?.port && !(await check("the server is stopped and its port is free", end.free && end.alive.length === 0, `port ${A.port}; processes left: ${end.alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? `# passed (${n} checks)` : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
