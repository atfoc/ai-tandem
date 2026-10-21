#!/usr/bin/env node
// The runner of the device and simulator tests (architecture AD-83, goal 7.4). One command per flow:
//
//   node app/e2e/run.mjs <flow> --platform ios|android [--device <udid|serial>] [--release] [--build|--no-build] [--clean] [--once] [--out <dir>]
//   node app/e2e/run.mjs <flow> --platform node                 the flow's cases under Node, no device (a check of the cases)
//   node app/e2e/run.mjs --list
//
//   <flow>       a file of app/e2e/maestro (conn-on-hermes, net-selftest, ...), without .yaml
//   --device     the simulator's udid (ios) or the adb serial (android). Yours: other agents run this on theirs, so it is never
//                guessed. Default: the environment's AIWB_IOS_UDID / AIWB_ANDROID_SERIAL.
//   --build      build and install the development build before the run (`expo run:<platform>`); --no-build never builds.
//                Default: build when the app is not installed on the device or its native inputs (app/modules, app.config.ts,
//                package.json, the lock file) changed since the last build this runner made for that device.
//   --release    a Release build (JavaScript and the board page inside the app, no Metro, no development client) instead of the
//                development build; always built, as the JavaScript is part of it. It gets no value of the run (EXPO_PUBLIC_AIWB_SELFTEST=1
//                only): no scratch server, no report url (a Release build on Android may not talk plain http to this computer), so only
//                flows with `needs=` empty run in it; what the app announces (memory phases) is read from the device's log.
//   --clean      with a build: `expo prebuild --clean` first (the generated ios/ and android/ folders are made again, AD-5).
//   --once       one attempt of Maestro, not two (while writing a flow)
//   --hold       no flow runs: the app is opened, everything the flow would have (scratch server, control API, Metro) stays up, the values of the flow's
//                variables are written to <out>/env.json, and the runner waits until the file <out>/stop exists. To drive Maestro by hand while writing a flow
//                (`maestro --device <id> test -e K=V ... file.yaml`, `maestro hierarchy`).
//   --out        the folder of the run's evidence (server logs, Metro and build logs, Maestro's output, the cases the app reported);
//                default: a new one under the system's temporary folder; it is printed at the end.
//
// What a run does: fetches the pinned Maestro and JRE (get-maestro.sh, once), starts a SCRATCH Go server (own home, free port,
// never the user's on 4748/6006) and the stand-ins the flow's header asks for, starts Metro for the development build with the
// run's values in EXPO_PUBLIC_* variables (the app reads them, src/dev/selftestEnv.ts), opens the development build on the
// device, runs the Maestro flow, and stops everything it started. The verdict is Maestro's and the cases the app reported.
// Exit status 0: the flow passed.
//
// The flow's header (its first lines, comments) says what it needs:  `# aiwb-e2e: needs=server,standins`
//   server     a scratch server whose certificate lists 127.0.0.1 and the dotted name localtest.me
//   standins   a refused port, a listener that is not TLS, a TLS server without h2, a listener that never answers
//   agent      the scratch server runs the stand-in agent of the tests (it answers "FAKE(<model>): <message>", no paid model)
//   control    a control API on this computer for the flow's scripts (lib/serverctl.mjs): stop, start and give a new certificate to the
//              scratch server, make a board or a chat (with a message the stand-in answers) through the client API; flow variable CONTROL_URL
//   voice      the stand-in voice service (web/dev/voicestandin.mjs, lib/voice.mjs) alone on a free port of this computer: the development build is
//              given EXPO_PUBLIC_AIWB_VOICE_BASE at it (and shows the status line `voice-dev`), the flow gets VOICE_CONTROL (the stand-in's control
//              over HTTP: `script`, `pace`, `fail`, `reset`, `log`), and with `control` the routes `POST /voice/mic?action=grant|revoke` and `POST /voice/relaunch` (the microphone's answer is reset before each attempt); after
//              the flow the stand-in's log is read and the run fails unless the microphone's chunks were 16 kHz and 100 ms (goal 6.6)
// and `app=1` there: the build shows the app itself (no EXPO_PUBLIC_AIWB_SELFTEST), not the self-test root. Also in the header:
//   report=1       the chip input of the build reports what it holds to the runner (EXPO_PUBLIC_AIWB_REPORT_URL, src/dev/chipreport.ts)
//   gallery=<g>    the build shows a dev gallery (EXPO_PUBLIC_AIWB_GALLERY, src/dev/ChipDocGallery.tsx for `chipdoc`) instead of the app
//   verify=<name>  app/e2e/verify/<name>.mjs: `checks` (named, waited for by the flow's `POST /check?name=` of the control API) and
//                  `verify({ reports, platform, control })`, called after the flow: it answers the list of what did not hold
//   xcuitest=<n>   an XCUITest bundle run after the flow on iOS; adbkeys=<n> a script of adbkeys/ on Android (see below)
//   then=<flow>    another flow run after this one has passed, by this runner, on the same device (a second part of one test)
//   devhooks=1     (needs `control`): the build carries the dev hooks of package V4 (src/dev/StorageProbe.tsx: a line on the screen that says what the secure
// store and MMKV hold, src/dev/forceoutcome.ts: a connection to the dotted name ends as local_network_denied), and the control API gets the routes of the
// device (lib/devicectl.mjs: the photo library, the privacy answers, a relaunch of the app, the app's files) with the pictures of lib/fixtures.mjs.
// Every flow gets these Maestro variables (-e): APP_ID, and with `server`: SERVER_HOST, SERVER_DOTTED, SERVER_PORT,
// SERVER_FINGERPRINT, SERVER_SECRET; they are those of a scratch server of this run, of no value outside it. With `control`: CONTROL_URL.
//
// Android: the emulator is shared; take its lock first (`mkdir /tmp/aiwb-android-emulator.lock`, `rmdir` it when done: the runner
// refuses an emulator without it). The runner makes `adb reverse` for every port the run uses. Environment: ANDROID_HOME (default
// ~/Library/Android/sdk), JAVA_HOME (a JDK 17 for the Gradle build; the JRE of .tools cannot build).
//
// Environment (all optional): AIWB_E2E_TOOLS (where get-maestro.sh puts its tools), AIWB_E2E_BIN (a built server program, else it is
// built into the run's folder), AIWB_IOS_BUNDLE_ID / AIWB_ANDROID_PACKAGE (as app.config.ts reads them), AIWB_IOS_UDID,
// AIWB_ANDROID_SERIAL.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adbPath, androidHome, jdk17 } from "../scripts/lib/devtools.mjs";
import { deviceRoutes } from "./lib/devicectl.mjs";
import { makeFixtures } from "./lib/fixtures.mjs";
import { measure } from "./lib/memory.mjs";
import { freePort, startServer, startStandIns } from "./lib/scratch.mjs";
import { apiClient, startServerControl } from "./lib/serverctl.mjs";
import { checkLog, setMic, startVoiceStandin, voiceRoutes } from "./lib/voice.mjs";
import { runXcuitest } from "./lib/xcuitest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoDir = path.resolve(appDir, "..");
const flowsDir = path.join(here, "maestro");
const toolsDir = path.resolve(process.env.AIWB_E2E_TOOLS || path.join(here, ".tools"));
const stateDir = path.join(here, ".state");

const SLUG = "ai-whiteboard"; // app.config.ts: the development client's scheme is exp+<slug>
const bundleId = process.env.AIWB_IOS_BUNDLE_ID || "local.aiwhiteboard.app";
const androidPackage = process.env.AIWB_ANDROID_PACKAGE || "local.aiwhiteboard.app";
const EMULATOR_LOCK = "/tmp/aiwb-android-emulator.lock";

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flowNames = () => fs.readdirSync(flowsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).map((f) => f.slice(0, -5)).sort();

if (flag("--help") || flag("-h")) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
if (flag("--list")) { for (const f of flowNames()) console.log(f); process.exit(0); }

const flow = argv.find((a, i) => !a.startsWith("-") && !["--platform", "--device", "--out"].includes(argv[i - 1]));
const platform = opt("--platform", "");
if (!flow || !["ios", "android", "node"].includes(platform)) {
  console.error(`usage: node app/e2e/run.mjs <flow> --platform ios|android|node [--device <udid|serial>] [--build|--no-build] [--clean] [--out <dir>]\nflows: ${flowNames().join(", ")}`);
  process.exit(2);
}
const flowFile = path.join(flowsDir, `${flow}.yaml`);
if (!fs.existsSync(flowFile) || flow.startsWith("_")) { console.error(`no flow ${flow}; flows: ${flowNames().join(", ")}`); process.exit(2); }
const header = /^#\s*aiwb-e2e:\s*(.*)$/m.exec(fs.readFileSync(flowFile, "utf8"))?.[1] ?? "";
const release = flag("--release");
const needs = new Set((/needs=(\S*)/.exec(header)?.[1] ?? "").split(",").filter(Boolean));
if (release && platform === "node") { console.error("--release is for a device"); process.exit(2); }
if (release && needs.size) { console.error(`${flow} needs ${[...needs].join(", ")}: a Release build gets no value of the run; run it on the development build`); process.exit(2); }
const nodeKind = /node=(\S+)/.exec(header)?.[1] ?? ""; // what `--platform node` runs: conn | net
const devHooks = /\bdevhooks=1\b/.test(header); // the dev hooks of package V4 and the device routes of the control API
const realApp = /\bapp=1\b/.test(header); // the build shows the app itself, not the self-test root
const adbkeys = /adbkeys=(\S+)/.exec(header)?.[1] ?? ""; // a script of app/e2e/adbkeys run on Android after the flow: hardware keys by `adb shell input`
const xcuitest = /xcuitest=(\S+)/.exec(header)?.[1] ?? ""; // an XCUITest bundle (app/e2e/xcuitest/<name>) run on iOS after the flow, for the keys Maestro cannot send
const reportBox = /\breport=1\b/.test(header); // the build reports what the chip input holds (src/dev/chipreport.ts)
const gallery = /gallery=(\S+)/.exec(header)?.[1] ?? ""; // the build shows this dev gallery, not the app
const verifyName = /verify=(\S+)/.exec(header)?.[1] ?? ""; // app/e2e/verify/<name>.mjs: checks the flow waits for, and a verdict after it
const thenFlow = /then=(\S+)/.exec(header)?.[1] ?? ""; // a flow run after this one passed

const t00 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outArg = path.resolve(opt("--out", "") || fs.mkdtempSync(path.join(os.tmpdir(), `aiwb-e2e-${flow}-`)));
fs.mkdirSync(outArg, { recursive: true });
const out = fs.realpathSync(outArg);

/** Set by main(): what to do when the app announces a memory phase. */
let phase = () => {};
const cleanups = [];
async function cleanup() { for (const f of cleanups.reverse()) { try { await f(); } catch (e) { console.error("cleanup:", e.message); } } cleanups.length = 0; }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanup(); process.exit(130); });

/** What the app's chip input reports (src/dev/chipreport.ts), by post or as a line of Metro's log (`AIWB_REPORT {...}`, the same report): taken
 *  once (run + seq). The app starts again between two attempts and its counter with it: a report of a run seen before is the old process's. */
const posts = [];
const takenPosts = new Set();
const oldRuns = new Set();
const takePost = (o) => {
  if (!o || typeof o.seq !== "number" || typeof o.run !== "string" || oldRuns.has(o.run) || takenPosts.has(`${o.run}:${o.seq}`)) return;
  takenPosts.add(`${o.run}:${o.seq}`);
  posts.push(o);
};
const ordered = () => [...posts].sort((a, b) => a.seq - b.seq);
/** The latest state the box reported (a report with `mark` is a press of the gallery's Mark: not one), or null. */
const latestBox = () => ordered().filter((p) => p.state && p.mark === undefined).pop()?.state ?? null;
const verifyMod = verifyName ? await import(`./verify/${verifyName}.mjs`) : null;

let code = 1;
let androidSerial = null; // the emulator or device of an android run: the stand-in servers started later are reversed to it
try {
  code = await main();
} catch (e) {
  console.error("RUN FAILED:", e.stack || e.message || e);
}
await cleanup();
if (code === 0 && thenFlow && platform !== "node") { // the second part runs with nothing of this one left (its Metro, its server)
  say(`${flow} passed; now ${thenFlow}`);
  const args = [fileURLToPath(import.meta.url), thenFlow, "--platform", platform, "--device", opt("--device", "") || (platform === "ios" ? process.env.AIWB_IOS_UDID : process.env.AIWB_ANDROID_SERIAL) || "", "--no-build", "--out", path.join(out, thenFlow), ...(flag("--once") ? ["--once"] : [])];
  code = spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1;
}
say(code === 0 ? `PASSED ${flow} on ${platform}` : `FAILED ${flow} on ${platform}`);
say(`evidence in ${out}`);
process.exit(code);

// ---------------------------------------------------------------- the run
async function main() {
  say(`flow ${flow} on ${platform}; evidence folder ${out}`);
  const things = {};
  const hooks = {}; // what the control API asks of this process: the box's latest state, a check of the flow's `verify=` module
  if (needs.has("server")) {
    say("starting the scratch server (builds the server program unless AIWB_E2E_BIN is set)");
    things.server = await startServer({ out, agent: needs.has("agent") });
    cleanups.push(() => things.server.stop());
    say(`scratch server on 127.0.0.1:${things.server.port}, fingerprint ${things.server.fingerprint}`);
  }
  if (needs.has("control")) {
    if (!things.server) throw new Error("`control` needs `server`");
    things.control = await startServerControl(things.server, { say: (m) => say(m), hooks });
    cleanups.push(() => things.control.close());
    say(`control API of the scratch server on ${things.control.url}`);
  }
  if (needs.has("voice")) {
    if (!realApp) throw new Error("`voice` needs `app=1`");
    things.voice = await startVoiceStandin({ out });
    cleanups.push(() => things.voice.stop());
    say(`stand-in voice service on ${things.voice.base} (log: ${path.join(out, "voice-standin.log")})`);
  }
  if (needs.has("standins")) {
    // Android reaches the computer through `adb reverse`: the servers the control server starts, one per case, are given to it as they start.
    const reverse = (verb, port) => androidSerial && spawnSync(adbPath(), ["-s", androidSerial, "reverse", ...(verb === "remove" ? ["--remove"] : []), `tcp:${port}`, ...(verb === "remove" ? [] : [`tcp:${port}`])], { stdio: "ignore" });
    things.standins = await startStandIns({ expose: (port) => reverse("add", port), unexpose: (port) => reverse("remove", port) });
    cleanups.push(() => things.standins.close());
    say(`stand-ins: closed ${things.standins.closedPort}, plain ${things.standins.plainPort}, h1 ${things.standins.h1Port}, blackhole ${things.standins.blackholePort}`);
  }
  if (platform === "node") return runUnderNode(things);

  // What the app tells the runner: one POST per case and one per verdict.
  const reports = [];
  const collector = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      // (no kept-alive connection: through adb reverse, OkHttp reusing one that Node has closed hangs instead of failing)
      res.setHeader("connection", "close"); res.end("ok");
      try {
        const r = JSON.parse(b);
        if (!r.kind) { takePost(r); return; } // (the chip input's report, not a case)
        reports.push(r); console.log(`  app| ${r.text}`); fs.appendFileSync(path.join(out, "app-cases.log"), `${r.kind}: ${r.text}\n`);
        if (r.kind === "memory") phase(r.text);
      } catch { /* not ours */ }
    });
  });
  await new Promise((r) => collector.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => { collector.closeAllConnections?.(); collector.close(() => r()); }));
  const reportPort = collector.address().port;

  const device = resolveDevice();
  if (platform === "android") androidSerial = device;
  say(`device ${device}`);
  const toolEnv = prepareTools();
  const metroPort = await freePort();

  // ports the device must reach on this computer (android: adb reverse). Not the closed port: a reversed port accepts the connection
  // and closes it, which is no "refused"; a port nothing is reversed to is refused by the emulator itself.
  const ports = [metroPort, reportPort];
  if (things.server) ports.push(things.server.port);
  if (things.voice) ports.push(things.voice.port);
  // (the control API is called by Maestro, on this computer: the device never reaches it)
  if (things.standins) ports.push(things.standins.plainPort, things.standins.h1Port, things.standins.blackholePort, Number(new URL(things.standins.control).port));

  if (platform === "ios") bootSimulator(device);
  else prepareAndroid(device, ports);

  // `expo prebuild`, `expo run` and `expo start` rewrite app/package.json and app/tsconfig.json (scripts, formatting); a run leaves them as they were.
  const tracked = ["package.json", "tsconfig.json"].map((f) => path.join(appDir, f));
  const before = tracked.map((f) => fs.readFileSync(f));
  cleanups.push(() => tracked.forEach((f, i) => { if (!fs.readFileSync(f).equals(before[i])) fs.writeFileSync(f, before[i]); }));

  prebuildBoard();
  await ensureBuild(device);

  const appId = platform === "ios" ? bundleId : androidPackage;
  if (things.voice && things.control) things.control.add(voiceRoutes({ platform, device, appId, say, terminate: () => terminateApp(device, appId), open: () => openDevClient(device, appId, things.devUrl) }));
  if (devHooks) {
    if (!things.control) throw new Error("`devhooks=1` needs `control`");
    things.devUrl = ""; // (set below, once Metro has its port)
    things.control.add(deviceRoutes({
      platform, device, appId, server: things.server, out, fixtures: makeFixtures(path.join(out, "media")), say,
      terminate: () => terminateApp(device, appId), open: () => openDevClient(device, appId, things.devUrl),
    }));
  }
  // The memory of the processes at the phases the app announces (a "memory" report, or a line in the device's log: the Release build on
  // Android cannot post to this computer), read once per phase after the app's own pause.
  const memory = [];
  const seen = new Set();
  phase = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    setTimeout(() => {
      try {
        const m = measure({ platform, device, app: appId });
        memory.push({ phase: name, ...m });
        fs.writeFileSync(path.join(out, "memory.json"), JSON.stringify(memory, null, 1) + "\n");
        say(`memory at ${name}: ${m.rows.map((r) => `${r.kind} ${r.footprintMB ?? r.pssMB} MB${r.footprintMB != null ? " footprint" : " pss"}`).join(", ")}`);
      } catch (e) { say(`memory at ${name}: could not read (${e.message})`); }
    }, 2500);
  };
  watchLog(device);
  const metro = release ? null : await startMetro({ metroPort, reportPort, things });
  const url = `exp+${SLUG}://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metroPort}`)}`;
  things.devUrl = url;

  const ctx = { platform, server: things.server, api: things.server ? apiClient(things.server) : null, say };
  hooks.box = latestBox;
  hooks.check = async (name) => {
    const f = verifyMod?.checks?.[name];
    if (!f) throw new Error(`the verify module ${verifyName || "(none)"} has no check ${name}`);
    const box = latestBox();
    if (!box && !f.noBox) return "the app has reported no state of the box yet";
    const r = await f(box, ctx);
    return r === true ? true : `${r}${box ? `; the box: ${JSON.stringify(box)}` : ""}`;
  };
  const flowEnv = { APP_ID: appId };
  if (things.control) flowEnv.CONTROL_URL = things.control.url;
  if (things.voice) flowEnv.VOICE_CONTROL = things.voice.control;
  if (things.server) Object.assign(flowEnv, {
    SERVER_HOST: things.server.host, SERVER_DOTTED: things.server.dotted, SERVER_PORT: String(things.server.port),
    SERVER_FINGERPRINT: things.server.fingerprint, SERVER_SECRET: things.server.secret,
  });
  const eArgs = Object.entries(flowEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  if (flag("--hold")) {
    terminateApp(device, appId);
    if (release) openApp(device, appId); else openDevClient(device, appId, url);
    fs.writeFileSync(path.join(out, "env.json"), JSON.stringify(flowEnv, null, 1) + "\n");
    say(`holding: variables in ${path.join(out, "env.json")}; touch ${path.join(out, "stop")} to end`);
    while (!fs.existsSync(path.join(out, "stop"))) await sleep(1000);
    if (metro) fs.writeFileSync(path.join(out, "metro.log"), metro.log());
    return 0;
  }

  // One more attempt when Maestro failed and the app did not say a case failed: a UI driver on a busy machine drops a tap now and then.
  let status = 1;
  for (let attempt = 1; attempt <= (flag("--once") ? 1 : 2); attempt++) {
    reports.length = 0;
    for (const p of posts) oldRuns.add(p.run);
    posts.length = 0;
    if (attempt > 1 && things.control) { say("the scratch server is put back as the run began (control reset)"); await things.control.reset(); }
    if (things.voice) await fetch(`${things.voice.control}/reset`, { method: "POST" }); // (nothing of an earlier attempt in the stand-in's log or script)
    terminateApp(device, appId);
    if (things.voice) setMic({ platform, device, appId, action: "reset" }); // (the system asks again; the app is not running, which the system would end for it)
    if (release) openApp(device, appId); else openDevClient(device, appId, url);
    const dir = path.join(out, `maestro-${attempt}`);
    fs.mkdirSync(dir, { recursive: true });
    say(`maestro test ${flow}.yaml (attempt ${attempt})`);
    // Asynchronous: the collector of the app's reports runs in this process.
    const maestro = (file, extra = []) => new Promise((resolve) => {
      const p = spawn(path.join(toolsDir, "maestro/maestro/bin/maestro"), ["--device", device, "test", ...eArgs, ...extra, file], {
        env: toolEnv, stdio: ["ignore", "inherit", "inherit"], cwd: here,
      });
      p.on("close", (status) => resolve({ status }));
    });
    const r = await maestro(flowFile, ["--test-output-dir", dir]);
    await sleep(500); // the last posts of the app
    const verdicts = reports.filter((r) => r.kind === "verdict");
    const appFailed = verdicts.some((v) => /FAILED/.test(v.text));
    status = r.status === 0 && !appFailed ? 0 : 1;
    say(`maestro exited ${r.status}; the app reported ${verdicts.length} verdict(s)${appFailed ? ", one of them FAILED" : ""}`);
    // The flow left the app on the screen the bundle drives; the bundle's verdict is the run's too, and the screen is photographed.
    if (status === 0 && xcuitest && platform === "ios") {
      say(`XCUITest bundle ${xcuitest} (log: ${path.join(out, `xcuitest-${xcuitest}.log`)})`);
      const x = await runXcuitest({ name: xcuitest, udid: device, appId, out, vars: { __CONTROL_URL__: things.control?.url ?? "" } });
      for (const c of x.cases) say(`  xcuitest| ${c.passed ? "passed" : "FAILED"} ${c.name}`);
      spawnSync("xcrun", ["simctl", "io", device, "screenshot", path.join(out, `${xcuitest}-after-xcuitest.png`)], { stdio: "ignore" });
      if (!x.ok) say(`XCUITest failed; the end of its log:\n${x.log.split("\n").slice(-30).join("\n")}`);
      await sleep(1500); // the app's last post (the verdict of the keys screen)
      status = x.ok && !reports.some((v) => v.kind === "verdict" && /FAILED/.test(v.text)) ? 0 : 1;
      if (status !== 0) break; // the keys were sent: a second attempt would send them again to a screen that already counted them
    }
    if (status === 0 && adbkeys && platform === "android") {
      say(`adb keys ${adbkeys}`);
      const { run } = await import(`./adbkeys/${adbkeys}.mjs`);
      const adb = (args) => spawnSync(adbPath(), ["-s", device, ...args], { encoding: "utf8", maxBuffer: 1 << 24 }).stdout ?? "";
      const x = await run({ adb, say, box: latestBox, maestro: (file) => maestro(path.join(flowsDir, file)) });
      for (const p of x.problems) say(`  adbkeys| FAILED ${p}`);
      spawnSync(adbPath(), ["-s", device, "shell", "screencap", "-p", `/sdcard/${adbkeys}.png`]);
      spawnSync(adbPath(), ["-s", device, "pull", `/sdcard/${adbkeys}.png`, path.join(out, `${adbkeys}-after-adbkeys.png`)], { stdio: "ignore" });
      await sleep(1500); // the app's last post (the verdict of the keys screen)
      status = x.ok && !reports.some((v) => v.kind === "verdict" && /FAILED/.test(v.text)) ? 0 : 1;
      if (status !== 0) break;
    }
    if (status === 0 && things.voice) { // what the stand-in saw of the microphone and the speaker, after everything the flow did
      const { problems, lines } = checkLog(await things.voice.log());
      fs.writeFileSync(path.join(out, "voice-log.json"), JSON.stringify(await things.voice.log(), null, 1) + "\n");
      for (const l of lines) say(`  voice| ${l}`);
      for (const p of problems) say(`  voice| FAILED ${p}`);
      if (!problems.length) say("voice: the microphone's chunks were 16 kHz and 100 ms, and the client broke no rule of the protocol");
      status = problems.length ? 1 : 0;
      if (status !== 0) break;
    }
    if (status === 0 && verifyMod?.verify) { // what the flow's reports and the server say, after everything the flow did
      await sleep(1500); // the app's last reports
      const problems = await verifyMod.verify({ posts: ordered(), box: latestBox(), ...ctx });
      for (const p of problems) say(`  verify| FAILED ${p}`);
      if (!problems.length) say(`verify ${verifyName}: ok`);
      fs.writeFileSync(path.join(out, "reports.json"), ordered().map((p) => JSON.stringify(p)).join("\n") + "\n");
      status = problems.length ? 1 : 0;
      if (status !== 0) break;
    }
    if (status === 0 || appFailed) break;
  }
  terminateApp(device, appId);
  if (metro) fs.writeFileSync(path.join(out, "metro.log"), metro.log());
  return status;
}

// ---------------------------------------------------------------- no device: the same cases under Node
async function runUnderNode(things) {
  if (!nodeKind) throw new Error(`${flow} has no node= in its header: it cannot run under Node`);
  const { line } = await import("../src/dev/selftest.ts");
  const say1 = (o) => console.log(`  case| ${line(o)}`);
  let ok = true;
  if (nodeKind === "conn") {
    const { runConnSelfTest } = await import("../src/dev/connSelfTest.ts");
    const r = await runConnSelfTest(say1);
    say(`conn: ${r.pass} passed, ${r.fail} failed, ${r.skip} skipped`);
    ok = r.ok;
  } else if (nodeKind === "net") {
    const { runNetSelfTest } = await import("../src/dev/netSelfTest.ts");
    const { nodeConnector } = await import("@aiwb/conn/node");
    for (const host of [things.server.host, things.server.dotted]) {
      const cfg = {
        host, port: things.server.port, fingerprint: things.server.fingerprint, secret: things.server.secret,
        closedPort: things.standins.closedPort, plainPort: things.standins.plainPort, h1Port: things.standins.h1Port,
        h1Fingerprint: things.standins.h1Fingerprint, blackholePort: things.standins.blackholePort, control: things.standins.control,
      };
      say(`net self-test as ${host}`);
      const r = await runNetSelfTest(nodeConnector({}), cfg, say1);
      say(`net ${host}: ${r.pass} passed, ${r.fail} failed, ${r.skip} skipped`);
      ok = ok && r.ok;
    }
  } else throw new Error(`unknown node= ${nodeKind}`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------- devices
/** The device is named by the caller, never guessed: the simulators and the emulator are shared with other agents. */
function resolveDevice() {
  const named = opt("--device", "") || (platform === "ios" ? process.env.AIWB_IOS_UDID : process.env.AIWB_ANDROID_SERIAL) || "";
  if (named) return named;
  throw new Error(platform === "ios"
    ? "name your simulator: --device <udid> or AIWB_IOS_UDID (xcrun simctl list devices); other agents use the others"
    : "name your device: --device <serial> or AIWB_ANDROID_SERIAL (adb devices); the emulator is shared, take its lock first");
}

function simulators() {
  const j = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "--json"], { encoding: "utf8" }));
  return Object.values(j.devices).flat();
}

function bootSimulator(udid) {
  if (!simulators().some((s) => s.udid === udid)) throw new Error(`no simulator ${udid} (xcrun simctl list devices)`);
  say("booting the simulator if it is not (simctl bootstatus -b)");
  execFileSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: "ignore" });
}

function adbDevices() {
  if (!fs.existsSync(adbPath())) throw new Error(`no adb at ${adbPath()}: set ANDROID_HOME to the Android SDK`);
  return execFileSync(adbPath(), ["devices"], { encoding: "utf8" }).split("\n").slice(1).map((l) => l.split("\t")).filter((p) => p[1] === "device").map((p) => p[0]);
}

function prepareAndroid(serial, ports) {
  if (!adbDevices().includes(serial)) throw new Error(`adb does not see ${serial} as a device (adb devices)`);
  if (serial.startsWith("emulator-") && !fs.existsSync(EMULATOR_LOCK)) {
    throw new Error(`the emulator is shared: take its lock first (mkdir ${EMULATOR_LOCK}), and rmdir it when you are done`);
  }
  for (const p of ports) execFileSync(adbPath(), ["-s", serial, "reverse", `tcp:${p}`, `tcp:${p}`], { stdio: "ignore" });
  cleanups.push(() => { for (const p of ports) spawnSync(adbPath(), ["-s", serial, "reverse", "--remove", `tcp:${p}`], { stdio: "ignore" }); });
  say(`adb reverse for ports ${ports.join(", ")}`);
}

/** The app's `console.log` lines are in the device's log (Android: tag ReactNativeJS; iOS: the simulator's unified log); a line
 *  "[aiwb-phase] <name>" announces a memory phase. A Release build cannot post to this computer, so it is the way the phases reach the runner. */
function watchLog(device) {
  let p;
  if (platform === "android") {
    spawnSync(adbPath(), ["-s", device, "logcat", "-c"], { stdio: "ignore" });
    p = spawn(adbPath(), ["-s", device, "logcat", "-v", "brief", "ReactNativeJS:V", "*:S"], { stdio: ["ignore", "pipe", "ignore"] });
  } else {
    p = spawn("xcrun", ["simctl", "spawn", device, "log", "stream", "--level", "debug", "--predicate", 'eventMessage CONTAINS "[aiwb-phase]"'], { stdio: ["ignore", "pipe", "ignore"] });
  }
  let rest = "";
  const lines = [];
  p.stdout.on("data", (d) => {
    rest += d;
    const ls = rest.split("\n");
    rest = ls.pop();
    for (const l of ls) {
      lines.push(l);
      const m = /\[aiwb-phase\] (\S+)/.exec(l);
      if (m) phase(m[1]);
    }
  });
  cleanups.push(() => { p.kill(); fs.writeFileSync(path.join(out, "device-log.txt"), lines.join("\n") + "\n"); });
}

/** A Release build has no development client: the app is started as its icon starts it. */
function openApp(device, appId) {
  const r = platform === "ios"
    ? spawnSync("xcrun", ["simctl", "launch", device, appId], { encoding: "utf8" })
    : spawnSync(adbPath(), ["-s", device, "shell", "monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`starting the app failed: ${r.stderr || r.stdout}`);
}

/** The board's page is a Metro asset, so the file must exist when Metro bundles: every build and every Metro of a run goes through
 *  the app's `prebuild:board` (which builds @aiwb/board-view's one-file page), as the install script and a developer's build do. */
function prebuildBoard() {
  say("npm run prebuild:board (the board's page)");
  const r = spawnSync("npm", ["run", "prebuild:board"], { cwd: appDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`prebuild:board failed:\n${(r.stdout + r.stderr).split("\n").slice(-20).join("\n")}`);
  const html = path.join(repoDir, "packages/board-view/dist-webview/board.html");
  if (!fs.existsSync(html)) throw new Error(`prebuild:board left no ${html}`);
}

function terminateApp(device, appId) {
  if (platform === "ios") spawnSync("xcrun", ["simctl", "terminate", device, appId], { stdio: "ignore" });
  else spawnSync(adbPath(), ["-s", device, "shell", "am", "force-stop", appId], { stdio: "ignore" });
}

/** The development client's round button (it opens its menu) stands over the top right of the screen, where the system's picker has its "Add" and a chat
 *  its "Tree": a press there opens the menu. Its preference is written into the app's own preferences before the app is opened (the app is not
 *  running then, so nothing holds the old file in memory): iOS `EXDevMenuShowFloatingActionButton` in the app's plist, Android `showFab` in the
 *  development menu's shared preferences (`run-as`: the development build is debuggable). */
function hideDevMenuButton(device, appId) {
  if (platform === "android") {
    const xml = '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n<boolean name="isOnboardingFinished" value="true" />\n<boolean name="showsAtLaunch" value="false" />\n<boolean name="showFab" value="false" />\n</map>\n';
    const local = path.join(out, "devmenu-prefs.xml");
    fs.writeFileSync(local, xml);
    const adb = (...args) => spawnSync(adbPath(), ["-s", device, ...args], { stdio: "ignore" });
    adb("push", local, "/data/local/tmp/aiwb-devmenu-prefs.xml");
    adb("shell", "run-as", appId, "sh", "-c", "'mkdir -p shared_prefs && cp /data/local/tmp/aiwb-devmenu-prefs.xml shared_prefs/expo.modules.devmenu.sharedpreferences.xml'");
    return;
  }
  const c = spawnSync("xcrun", ["simctl", "get_app_container", device, appId, "data"], { encoding: "utf8" });
  if (c.status !== 0) return;
  const plist = path.join(c.stdout.trim(), "Library/Preferences", `${appId}.plist`);
  if (!fs.existsSync(plist)) fs.mkdirSync(path.dirname(plist), { recursive: true });
  const set = spawnSync("plutil", ["-replace", "EXDevMenuShowFloatingActionButton", "-bool", "false", plist], { encoding: "utf8" });
  if (set.status !== 0) spawnSync("plutil", ["-create", "xml1", plist]), spawnSync("plutil", ["-replace", "EXDevMenuShowFloatingActionButton", "-bool", "false", plist]);
}

function openDevClient(device, appId, url) {
  hideDevMenuButton(device, appId);
  const r = platform === "ios"
    ? spawnSync("xcrun", ["simctl", "openurl", device, url], { encoding: "utf8" })
    : spawnSync(adbPath(), ["-s", device, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${url}'`, appId], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`opening the development build failed: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------- tools
function prepareTools() {
  execFileSync(path.join(here, "get-maestro.sh"), [], { stdio: "inherit", env: { ...process.env, AIWB_E2E_TOOLS: toolsDir } });
  return {
    ...process.env,
    JAVA_HOME: path.join(toolsDir, "java-home"),
    PATH: `${path.join(toolsDir, "maestro/maestro/bin")}:${process.env.PATH}`,
    LANG: "en_US.UTF-8",
    MAESTRO_CLI_NO_ANALYTICS: "1",
  };
}

// ---------------------------------------------------------------- the build
/** The files whose change means the native app must be built again (JavaScript is served by Metro). */
function nativeInputs() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!["node_modules", "build", "Pods", ".gradle"].includes(e.name)) walk(p); } else files.push(p);
    }
  };
  const modules = path.join(appDir, "modules");
  if (fs.existsSync(modules)) for (const m of fs.readdirSync(modules)) {
    const mod = path.join(modules, m);
    for (const sub of ["ios", "android"]) if (fs.existsSync(path.join(mod, sub))) walk(path.join(mod, sub));
    for (const f of ["expo-module.config.json", "package.json"]) if (fs.existsSync(path.join(mod, f))) files.push(path.join(mod, f));
  }
  const plugins = path.join(appDir, "plugins");
  if (fs.existsSync(plugins)) walk(plugins);
  for (const f of [path.join(appDir, "app.config.ts"), path.join(appDir, "package.json"), path.join(repoDir, "package-lock.json")]) if (fs.existsSync(f)) files.push(f);
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) h.update(path.relative(repoDir, f)).update("\0").update(fs.readFileSync(f)).update("\0");
  h.update(`${bundleId}\0${androidPackage}`);
  return h.digest("hex");
}

function installed(device) {
  if (platform === "ios") return spawnSync("xcrun", ["simctl", "get_app_container", device, bundleId, "app"], { stdio: "ignore" }).status === 0;
  const r = spawnSync(adbPath(), ["-s", device, "shell", "pm", "path", androidPackage], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("package:");
}

async function ensureBuild(device) {
  const stampFile = path.join(stateDir, `${platform}-${device.replace(/[^A-Za-z0-9_.-]/g, "_")}.stamp`);
  // (a Release build replaces the development build under the same id, so the stamp says which one is installed; a Release build holds
  // the JavaScript and the board's page, so it is built again whenever it is asked for)
  const want = nativeInputs() + (release ? "-release" : "");
  const have = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : "";
  const must = flag("--build") || (!flag("--no-build") && (release || !installed(device) || have !== want));
  if (!must) { say(`the development build on ${device} is current (${installed(device) ? "installed" : "NOT installed: --no-build"}); not building`); return; }
  const env = { ...process.env, CI: "1", LANG: "en_US.UTF-8" };
  // (the Release build holds the JavaScript, so what the self-test root needs to be shown is built in; nothing of the run is)
  if (release) env.EXPO_PUBLIC_AIWB_SELFTEST = "1";
  if (platform === "android") {
    env.ANDROID_HOME = androidHome();
    env.PATH = `${path.join(androidHome(), "platform-tools")}:${path.join(androidHome(), "emulator")}:${env.PATH}`;
    env.JAVA_HOME = process.env.JAVA_HOME || jdk17();
  }
  const log = fs.openSync(path.join(out, "build.log"), "w");
  const sh = (args, what) => {
    say(`${what} (log: ${path.join(out, "build.log")})`);
    const r = spawnSync("npx", args, { cwd: appDir, env, stdio: ["ignore", log, log] });
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}); the end of the log:\n${fs.readFileSync(path.join(out, "build.log"), "utf8").split("\n").slice(-25).join("\n")}`);
  };
  // The generated native project is made again when the inputs changed or --clean says so; nothing native is committed (AD-5).
  const projectExists = fs.existsSync(path.join(appDir, platform));
  if (flag("--clean") || (projectExists && have !== want)) sh(["expo", "prebuild", "--platform", platform, "--clean", "--no-install"], `expo prebuild ${platform} --clean`);
  const variant = release ? (platform === "ios" ? ["--configuration", "Release"] : ["--variant", "release"]) : [];
  sh(["expo", `run:${platform}`, "--device", platform === "ios" ? device : expoAndroidDevice(device), ...variant, "--no-bundler"], `expo run:${platform}${release ? " (Release)" : ""} on ${device}`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stampFile, want + "\n");
}

/** `expo run:android --device` takes the name of a device, not its adb serial: the AVD's name for an emulator ("Could not find device with name: emulator-5554"). */
function expoAndroidDevice(serial) {
  if (!serial.startsWith("emulator-")) return serial;
  const r = spawnSync(adbPath(), ["-s", serial, "emu", "avd", "name"], { encoding: "utf8" });
  return (r.status === 0 && r.stdout.split("\n")[0].trim()) || serial;
}

// ---------------------------------------------------------------- Metro
/** Starts Metro for the development build with the run's values in EXPO_PUBLIC_* (the app reads them: src/dev/selftestEnv.ts). */
async function startMetro({ metroPort, reportPort, things }) {
  const env = { ...process.env, CI: "1", LANG: "en_US.UTF-8" };
  delete env.EXPO_PUBLIC_AIWB_SELFTEST;
  for (const k of ["PROBE", "PROBE_SECRET_SHA256", "FORCE_OUTCOME"]) delete env[`EXPO_PUBLIC_AIWB_${k}`];
  delete env.EXPO_PUBLIC_AIWB_GALLERY;
  delete env.EXPO_PUBLIC_AIWB_REPORT_URL;
  delete env.EXPO_PUBLIC_AIWB_VOICE_BASE;
  if (things.voice) env.EXPO_PUBLIC_AIWB_VOICE_BASE = things.voice.base; // (honoured by a development build, and only for a local host: app/src/voice/platform/origin.ts)
  if (reportBox) env.EXPO_PUBLIC_AIWB_REPORT_URL = `http://127.0.0.1:${reportPort}`;
  if (gallery) env.EXPO_PUBLIC_AIWB_GALLERY = gallery;
  if (!realApp) Object.assign(env, { EXPO_PUBLIC_AIWB_SELFTEST: "1", EXPO_PUBLIC_AIWB_SELFTEST_REPORT: `http://127.0.0.1:${reportPort}` });
  if (things.server && !realApp) Object.assign(env, {
    EXPO_PUBLIC_AIWB_SELFTEST_HOST: things.server.host, EXPO_PUBLIC_AIWB_SELFTEST_DOTTED: things.server.dotted,
    EXPO_PUBLIC_AIWB_SELFTEST_PORT: String(things.server.port), EXPO_PUBLIC_AIWB_SELFTEST_FINGERPRINT: things.server.fingerprint,
    EXPO_PUBLIC_AIWB_SELFTEST_SECRET: things.server.secret,
  });
  if (things.standins && !realApp) Object.assign(env, {
    EXPO_PUBLIC_AIWB_SELFTEST_CLOSED_PORT: String(things.standins.closedPort), EXPO_PUBLIC_AIWB_SELFTEST_PLAIN_PORT: String(things.standins.plainPort),
    EXPO_PUBLIC_AIWB_SELFTEST_H1_PORT: String(things.standins.h1Port), EXPO_PUBLIC_AIWB_SELFTEST_H1_FINGERPRINT: things.standins.h1Fingerprint,
    EXPO_PUBLIC_AIWB_SELFTEST_BLACKHOLE_PORT: String(things.standins.blackholePort), EXPO_PUBLIC_AIWB_SELFTEST_CONTROL: things.standins.control,
  });
  if (devHooks) Object.assign(env, {
    EXPO_PUBLIC_AIWB_PROBE: "1", EXPO_PUBLIC_AIWB_PROBE_SECRET_SHA256: crypto.createHash("sha256").update(things.server.secret).digest("hex"),
    EXPO_PUBLIC_AIWB_FORCE_OUTCOME: `local_network_denied:${things.server.dotted}`,
  });
  // --clear: Metro's cache does not know that the values inlined from the environment changed.
  const p = spawn("npx", ["expo", "start", "--dev-client", "--port", String(metroPort), "--clear"], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  let partial = "";
  p.stdout.on("data", (d) => {
    log += d;
    const lines = (partial + d).split("\n");
    partial = lines.pop();
    for (const l of lines) { const i = l.indexOf("AIWB_REPORT "); if (i >= 0) { try { takePost(JSON.parse(l.slice(i + 12))); } catch { /* cut */ } } }
  });
  p.stderr.on("data", (d) => (log += d));
  cleanups.push(() => { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } fs.writeFileSync(path.join(out, "metro.log"), log); });
  const end = Date.now() + 180000;
  while (!/Waiting on|Logs for your project/.test(log)) {
    if (p.exitCode !== null) throw new Error(`Metro exited early:\n${log.slice(-1500)}`);
    if (Date.now() > end) throw new Error(`Metro did not start in 3 minutes:\n${log.slice(-1500)}`);
    await sleep(300);
  }
  say(`Metro on port ${metroPort}`);
  return { log: () => log };
}
