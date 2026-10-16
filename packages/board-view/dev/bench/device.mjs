#!/usr/bin/env node
// The board bench on an iPhone or iPad, on a Release build (goal 4.6; DEVICE.md here). One command: it takes the device lock, checks
// the device, starts the collector on this Mac, installs the app with the bench page inside, tells you which buttons to press on the
// device, waits for the result the page posts to the collector, and writes it as .json and .md. A dev tool: never in a shipped build.
//
//   node packages/board-view/dev/bench/device.mjs --device <name|udid> [--simulator] [--auto] [--no-install] [--no-boot]
//        [--modes all|experiment|replacement|<list>] [--port N] [--out <dir>] [--timeout-min 30] [--label <text>]
//
//   --device       the device's name, UDID or CoreDevice id (xcrun devicectl list devices); with --simulator the simulator's name or UDID.
//   --simulator    the device is an iOS simulator: no lock, the phone reaches this Mac as 127.0.0.1, booted if shut down (unless
//                  --no-boot or --no-install).
//   --auto         the bench starts by itself 10 s after the self-test's boards stop arriving (AIWB_BOARD_BENCH_AUTO=1); otherwise
//                  you tap "Run bench" at the top of the board.
//   --modes        what the run measures: a SET (experiment: light, dark-today, dark-css, dark-none, dark-matrix; replacement: light, the
//                  five <theme> and the five <theme>-today; all: both, 14 modes), a list, or both mixed. Default: all (about 19 min on a
//                  phone by the estimate printed at the start; `experiment` is 6 modes shorter). Built into the page (AIWB_BOARD_BENCH_MODES).
//   --no-install   build and install nothing: the app on the device must already be a bench build; wait for its result.
//   --port N       the collector's port (default: a free one; never 4748 or 6006, the user's server).
//   --out <dir>    where bench-<label or device>-<YYYYMMDD-HHMM>.json and .md go (default plans/excalidraw-optimization/runs/).
//   --timeout-min  minutes to wait for the result after the install (default 30).
//   --label        text for the file name and the title of the summary (a build, a flavour: "filter-v2").
//
// What it does, in order: (1) the lock `mkdir /tmp/aiwb-ios-device.lock` (physical devices only; released on every exit); (2) the
// device is found and reachable; (3) this Mac's LAN address (the interface of the default route); (4) the collector; (5) unless
// --no-install: `zsh -ic 'node app/scripts/install.mjs --platform ios --device "<device>"'` from the repository root, with
//   EXPO_PUBLIC_AIWB_SELFTEST=1  AIWB_BOARD_BENCH=1  AIWB_BOARD_BENCH_REPORT=http://<ip>:<port>/report  AIWB_BOARD_BENCH_MODES=<modes>  [AIWB_BOARD_BENCH_AUTO=1]
// (the signing team comes from ~/.zshrc and is never printed), with a fresh empty TMPDIR (removed afterwards; the install's own logs
// are moved out of it first), because Metro's transform cache lives in $TMPDIR/metro-cache, is shared by every worktree and is keyed
// without EXPO_PUBLIC_*: a cached App.tsx made without the self-test flag would give a normal app; afterwards the built main.jsbundle
// is searched for "SelfTestRoot" and a bundle without it stops the run (exit 5); (6) what to tap; (7) progress lines, then the result;
// (8) the files, and how to put the normal app back (it does not run that).
//
// Exit codes: 0 the result is written · 1 something else went wrong · 2 usage · 3 the device is not reachable · 4 the lock is held ·
// 5 the install failed · 6 the timeout passed without a result.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseDevicectl, parseSimctl, pickDevice, describeDevice } from "../../../../app/scripts/lib/install-core.mjs";
import { startCollector } from "./collect.mjs";
import { formatSummary } from "./stats.mjs";
import { DEFAULT_MODES, estimateMs, formatDuration, LOAD_MS, MODE_NAMES, parseModes } from "./modeset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
export const LOCK_DIR = "/tmp/aiwb-ios-device.lock";
export const EXIT = { ok: 0, other: 1, usage: 2, device: 3, lock: 4, install: 5, timeout: 6 };
const FORBIDDEN_PORTS = [4748, 6006];

// ------------------------------------------------------------------------------------------------ pure helpers (tested)

/** The arguments. `errors` lists what was wrong (the script prints it and stops with status 2). */
export function parseArgs(argv) {
  const r = { help: false, device: "", simulator: false, auto: false, noInstall: false, noBoot: false, port: 0, out: "", timeoutMin: 30, label: "", modes: DEFAULT_MODES, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") r.help = true;
    else if (a === "--simulator") r.simulator = true;
    else if (a === "--auto") r.auto = true;
    else if (a === "--no-install") r.noInstall = true;
    else if (a === "--no-boot") r.noBoot = true;
    else if (["--device", "--port", "--out", "--timeout-min", "--label", "--modes"].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { r.errors.push(`${a} needs a value`); continue; }
      i++;
      if (a === "--device") r.device = v;
      else if (a === "--out") r.out = v;
      else if (a === "--label") r.label = v;
      else if (a === "--modes") {
        const unknown = parseModes(v).filter((m) => !MODE_NAMES.includes(m));
        if (unknown.length || !parseModes(v).length) r.errors.push(`--modes is a set (experiment, replacement, all) or a list of modes (${MODE_NAMES.join(", ")}), not ${v}`);
        else r.modes = v;
      }
      else if (a === "--port") {
        const n = Number(v);
        if (!/^\d+$/.test(v) || n > 65535) r.errors.push(`--port is a number from 0 to 65535, not ${v}`);
        else if (FORBIDDEN_PORTS.includes(n)) r.errors.push(`--port ${n} is the port of the user's server: choose another`);
        else r.port = n;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) r.errors.push(`--timeout-min is a number of minutes above 0, not ${v}`);
        else r.timeoutMin = n;
      }
    } else r.errors.push(`unknown argument ${a}`);
  }
  if (!r.help && !r.device) r.errors.push("--device <name|udid> is required");
  return r;
}

/** A name for a file: lower case, letters and digits, single dashes. */
export const slug = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "device";

/** `bench-<label or device name>-<YYYYMMDD-HHMM>` (local time), without an extension. */
export function outputBase({ label, deviceName }, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `bench-${slug(label || deviceName)}-${stamp}`;
}

/** `devicectl list devices --json-output` (parsed) → { device } | { problem, candidates }; the device has `usable` (reachable now). */
export function findDevice(json, named) {
  return pickDevice(parseDevicectl(json), named);
}

/** `simctl list devices --json` (parsed) → { device } | { problem, candidates } over the iOS simulators; `state` is Booted / Shutdown. */
export function findSimulator(json, named) {
  return pickDevice([], named, parseSimctl(json));
}

/** `route -n get default` → the interface of the default route ("en0"), or "". */
export function parseDefaultRoute(text) {
  return /^\s*interface:\s*(\S+)\s*$/m.exec(text)?.[1] ?? "";
}

/** `ipconfig getifaddr <if>` → the IPv4 address, or "". */
export function parseIPv4(text) {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/m.exec(text);
  return m && [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255) ? m.slice(1).join(".") : "";
}

/** A word for a POSIX shell: single quotes, a quote inside is closed, escaped and reopened. */
export const shQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A value inside double quotes for a shell: `\`, `"`, `$` and a backtick are escaped. */
const dq = (s) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;

/** The command line that installs the app on the device (no environment: the normal app). It runs under `zsh -ic <this>`. */
export const installCommandLine = (device) => `node app/scripts/install.mjs --platform ios --device ${dq(device)}`;

/** The same, as one line to paste in a terminal. */
export const installCommandShown = (device) => `zsh -ic ${shQuote(installCommandLine(device))}`;

/** The environment that makes the install a bench build that reports to the collector. `tmpdir`, when given, becomes TMPDIR: an
 *  empty one gives Metro an empty transform cache, so that it inlines the EXPO_PUBLIC_* values of this build. */
export function benchEnv({ ip, port, auto, tmpdir, modes = DEFAULT_MODES }) {
  const env = { EXPO_PUBLIC_AIWB_SELFTEST: "1", AIWB_BOARD_BENCH: "1", AIWB_BOARD_BENCH_REPORT: `http://${ip}:${port}/report`, AIWB_BOARD_BENCH_MODES: modes };
  if (auto) env.AIWB_BOARD_BENCH_AUTO = "1";
  if (tmpdir) env.TMPDIR = tmpdir;
  return env;
}

/** The expected duration of a run on a phone (the page's default boards, 3 repetitions, gestures of 4 s), from the page's timings. */
export const estimateRunMs = ({ modes, simulator }) => estimateMs({ modes, loadMs: simulator ? LOAD_MS.simulator : LOAD_MS.device });

/** A string that is in the app's bundle only when the self-test root was compiled in (EXPO_PUBLIC_AIWB_SELFTEST=1 at bundling). */
export const SELFTEST_MARK = "SelfTestRoot";

/** Whether a main.jsbundle (Hermes bytecode: its strings are stored as plain ASCII) holds the self-test root. */
export const bundleHasSelfTest = (bundle) => Buffer.isBuffer(bundle) && bundle.includes(SELFTEST_MARK);

/** The built app's bundle from install.mjs's derived data folder, or "" (the newest .app of the configuration's products folder). */
export function findBundle({ simulator, root = repoRoot }) {
  const products = path.join(root, "app/ios/build/Build/Products", simulator ? "Release-iphonesimulator" : "Release-iphoneos");
  let apps;
  try { apps = fs.readdirSync(products).filter((f) => f.endsWith(".app")); } catch { return ""; }
  const bundles = apps.map((f) => path.join(products, f, "main.jsbundle")).filter((f) => fs.existsSync(f));
  bundles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return bundles[0] ?? "";
}

/** The message when the bench build has no self-test root. */
export const staleBundleMessage = (file) => `${file} was built without EXPO_PUBLIC_AIWB_SELFTEST (Metro reused a transform cached by an earlier build): the app on the device opens its normal home screen and the bench would never start.\nRemove Metro's cache ($TMPDIR/metro-cache, see \`node -p 'require("os").tmpdir()'\`) and run again.`;

/** What the person does on the device (printed after the install, or at once with --no-install). */
export function phoneInstructions({ auto, minutes }) {
  return [
    "On the device:",
    "  1. Open AI Whiteboard (it shows the self-test screen).",
    "  2. Tap 'Open board self-test'. The board opens and its self-test boards load.",
    auto
      ? "  3. The bench starts by itself 10 s after the boards stop arriving."
      : "  3. Tap 'Run bench' at the top of the board.",
    `Keep the device still, on power if possible, with the screen on and unlocked, for about ${minutes} minutes. Do not touch it while it runs.`,
  ].join("\n");
}

/** The exact words for a device that cannot be reached. */
export function unreachableMessage({ name, command }) {
  return [
    `${name} is not reachable.`,
    `Connect ${name} to this Mac by cable (or the same Wi-Fi with 'Connect via network' paired), unlock it, keep the screen on, answer Trust This Computer;`,
    "check with `xcrun devicectl list devices` that it shows `available`;",
    `then run again: ${command}`,
  ].join("\n");
}

/** The summary file: the markdown of formatSummary and the command that made it. */
export function markdownReport({ result, device, os: osVersion, label, command }) {
  const where = `${device.name}${device.model ? ` (${device.model})` : ""}${osVersion ? `, iOS ${osVersion}` : ""}, ${device.kind === "simulator" ? "simulator, " : ""}Release build${label ? `: ${label}` : ""}`;
  return `${formatSummary(result, where)}\n\nCommand:\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
}

/** Hides what looks like a signing team in a line of the install's output (the install masks it itself; this is a second net). */
export const redact = (line) => line.replace(/(DEVELOPMENT_TEAM=|team\s+)[A-Z0-9]{10}\b/g, "$1**********");

/** The folder of the install's logs, from a line it printed (it prints `logs in <dir>`), or "". */
export const installLogDir = (line) => /(\/\S*aiwb-install-\w+)/.exec(line)?.[1] ?? "";

// ------------------------------------------------------------------------------------------------ the run

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...o });

function takeLock() {
  try { fs.mkdirSync(LOCK_DIR); return; } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let age = "";
  try { age = ` (taken ${Math.round((Date.now() - fs.statSync(LOCK_DIR).mtimeMs) / 60000)} min ago)`; } catch { /* gone meanwhile */ }
  throw new Fail(EXIT.lock, `${LOCK_DIR} exists${age}: another agent or person is using the physical devices.\nWait for it to finish (it removes the folder with rmdir), then run again. If you know nobody uses it, remove it yourself: rmdir ${LOCK_DIR}`);
}

function listJson(cmd, args, file) {
  const r = sh(cmd, args);
  if (r.status !== 0) throw new Fail(EXIT.other, `${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return JSON.parse(file ? fs.readFileSync(file, "utf8") : r.stdout);
}

/** Checks the device; boots a shut-down simulator unless told not to. → { device, os } */
function checkDevice(args, command) {
  if (args.simulator) {
    const found = findSimulator(listJson("xcrun", ["simctl", "list", "devices", "--json"]), args.device);
    if (!found.device) throw new Fail(EXIT.device, `${found.problem}. Simulators:\n${(found.candidates ?? []).map((d) => `  ${describeDevice(d)}`).join("\n")}`);
    const device = found.device;
    if (device.state !== "Booted" && !args.noBoot && !args.noInstall) {
      console.log(`booting the simulator ${device.name} ...`);
      const b = sh("xcrun", ["simctl", "boot", device.udid]);
      if (b.status !== 0 && !/current state: Booted/i.test(b.stderr)) throw new Fail(EXIT.device, `could not boot ${device.name}: ${b.stderr.trim()}`);
    }
    return { device, os: device.os };
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-bench-")), "devices.json");
  const found = findDevice(listJson("xcrun", ["devicectl", "list", "devices", "--json-output", tmp], tmp), args.device);
  if (!found.device) {
    throw new Fail(EXIT.device, `${found.problem}. Devices that Xcode knows:\n${(found.candidates ?? []).map((d) => `  ${describeDevice(d)}`).join("\n") || "  none"}\nIf the device is yours: ${unreachableMessage({ name: args.device, command })}`);
  }
  if (!found.device.usable) throw new Fail(EXIT.device, unreachableMessage({ name: found.device.name, command }));
  if (found.device.developerModeOff) console.log(`warning: Developer Mode is off on ${found.device.name}; the install will say so (Settings > Privacy & Security > Developer Mode).`);
  return { device: found.device, os: found.device.os };
}

function lanAddress(simulator) {
  if (simulator) return "127.0.0.1";
  const iface = parseDefaultRoute(sh("route", ["-n", "get", "default"]).stdout ?? "");
  const ip = iface && parseIPv4(sh("ipconfig", ["getifaddr", iface]).stdout ?? "");
  if (!ip) throw new Fail(EXIT.other, "could not find this Mac's address on the local network (route -n get default, then ipconfig getifaddr <interface>). Is the Mac on Wi-Fi or Ethernet?");
  return ip;
}

/** Runs the install under the user's shell and streams its output with a prefix. → Promise of { code, logDir, tail } */
function runInstall({ device, env, child }) {
  return new Promise((resolve, reject) => {
    const proc = spawn("zsh", ["-ic", installCommandLine(device)], { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.proc = proc;
    let logDir = "";
    const tail = [];
    for (const stream of [proc.stdout, proc.stderr]) {
      readline.createInterface({ input: stream }).on("line", (raw) => {
        const line = redact(raw);
        logDir = installLogDir(line) || logDir;
        tail.push(line); if (tail.length > 30) tail.shift();
        console.log(`[install] ${line}`);
      });
    }
    proc.on("error", reject);
    proc.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), logDir, tail }));
  });
}

/** The install left the bench's board.html in dist-webview/, where a later build of the app could take it: the shipped page is
 *  built again (a few seconds), with no variable of the bench. */
function rebuildShippedPage() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AIWB_BOARD_BENCH")));
  const r = spawnSync("npm", ["run", "build:webview", "-w", "@aiwb/board-view"], { cwd: repoRoot, env, encoding: "utf8" });
  console.log(r.status === 0 ? "dist-webview/board.html is the shipped page again" : `warning: rebuilding the shipped board.html failed: run \`npm run build:webview -w @aiwb/board-view\` before any other build of the app\n${r.stderr ?? ""}`);
}

/** The header comment of this file, which is the help. */
const helpText = () => {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  return lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n");
};

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(helpText()); return EXIT.ok; }
  if (args.errors.length) {
    console.error(`${args.errors.join("\n")}\nusage: node packages/board-view/dev/bench/device.mjs --device <name|udid> [--simulator] [--auto] [--no-install] [--modes all|experiment|replacement|<list>] [--port N] [--out <dir>] [--timeout-min 30] [--label <text>]   (--help says more)`);
    return EXIT.usage;
  }
  const command = `node packages/board-view/dev/bench/device.mjs ${argv.map(shQuote).join(" ")}`.trim();
  const state = { locked: false, collector: null, child: {} };
  const release = () => {
    if (state.child.proc && state.child.proc.exitCode === null) state.child.proc.kill("SIGTERM");
    if (state.locked) { try { fs.rmdirSync(LOCK_DIR); } catch { /* already gone */ } state.locked = false; }
    state.collector?.close();
  };
  const onSignal = (sig) => () => { console.error(`\n${sig}: stopping.`); release(); process.exit(128 + (sig === "SIGINT" ? 2 : 15)); };
  const sigint = onSignal("SIGINT"), sigterm = onSignal("SIGTERM");
  process.on("SIGINT", sigint); process.on("SIGTERM", sigterm); process.on("exit", release);
  try {
    if (!args.simulator) { takeLock(); state.locked = true; }
    const { device, os: osVersion } = checkDevice(args, command);
    console.log(`device: ${describeDevice(device)}`);
    const modes = parseModes(args.modes);
    const expectedMs = estimateRunMs({ modes, simulator: args.simulator });
    console.log(`modes: ${modes.length} (${modes.join(", ")}); expected duration of the run: about ${formatDuration(expectedMs)}, besides the build`);
    const ip = lanAddress(args.simulator);
    const collector = state.collector = await startCollector({ port: args.port });
    const report = collector.url(ip);
    console.log(`collector: ${report} (listening on all interfaces)`);
    collector.progress.on("line", (text) => console.log(`[bench] ${text}`));

    if (!args.noInstall) {
      console.log(`installing a bench build (Release) on ${device.name}; this builds the app and takes several minutes ...`);
      const metroTmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-bench-metro-"));
      let code, logDir, tail;
      try {
        ({ code, logDir, tail } = await runInstall({ device: args.device, env: benchEnv({ ip, port: collector.port, auto: args.auto, tmpdir: metroTmp, modes: args.modes }), child: state.child }));
        if (logDir.startsWith(`${metroTmp}${path.sep}`)) { // the install made its logs in its TMPDIR: keep them, they are small
          const kept = path.join(os.tmpdir(), path.basename(logDir));
          try { fs.renameSync(logDir, kept); logDir = kept; } catch { /* they go with the folder */ }
        }
      } finally {
        fs.rmSync(metroTmp, { recursive: true, force: true });
      }
      rebuildShippedPage();
      if (code !== 0) {
        throw new Fail(EXIT.install, `the install stopped with status ${code}.${logDir ? ` Its logs: ${logDir}` : ""}\nThe end of its output:\n${tail.slice(-12).map((l) => `  ${l}`).join("\n")}\nThe app on the device is unchanged unless the output above says it was installed.`);
      }
      const bundle = findBundle({ simulator: args.simulator });
      if (!bundle) console.log("warning: the built main.jsbundle was not found under app/ios/build/Build/Products, so it was not checked for the self-test root.");
      else if (!bundleHasSelfTest(fs.readFileSync(bundle))) throw new Fail(EXIT.install, staleBundleMessage(bundle));
      else console.log(`the bundle has the self-test root (${SELFTEST_MARK}): ${path.relative(repoRoot, bundle)}`);
    } else console.log("--no-install: the app on the device must already be a bench build whose report address is the one above.");
    console.log(`\n${phoneInstructions({ auto: args.auto, minutes: Math.round(expectedMs / 60_000) })}\n`);
    console.log(`waiting for the result (up to ${args.timeoutMin} min) ...`);

    let timer;
    const timedOut = new Promise((r) => { timer = setTimeout(() => r("timeout"), args.timeoutMin * 60_000); });
    const got = await Promise.race([collector.result, timedOut]);
    clearTimeout(timer);
    if (got === "timeout") {
      throw new Fail(EXIT.timeout, `no result within ${args.timeoutMin} min.${collector.lines.length ? ` The last progress was: ${collector.lines.at(-1)}` : " Not one progress line arrived: the page does not reach this Mac (see DEVICE.md: same Wi-Fi, Local Network permission for the app)."}\nThe summary is also on the device's screen once the bench ends.`);
    }
    await new Promise((r) => setTimeout(r, 500)); // a page that posts the result twice: keep the last
    const result = collector.latest() ?? got;

    const outDir = path.resolve(repoRoot, args.out || "plans/excalidraw-optimization/runs");
    fs.mkdirSync(outDir, { recursive: true });
    let base = path.join(outDir, outputBase({ label: args.label, deviceName: device.name }));
    for (let n = 2; fs.existsSync(`${base}.json`); n++) base = path.join(outDir, `${outputBase({ label: args.label, deviceName: device.name })}-${n}`);
    const md = markdownReport({ result, device, os: osVersion, label: args.label, command });
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 1)}\n`);
    fs.writeFileSync(`${base}.md`, md);
    console.log(`\n${md}`);
    console.log(`written: ${base}.json\n         ${base}.md`);
    console.log(`\nThe device now has the bench build. To put the normal app back (it is not run for you):\n  ${installCommandShown(args.device)}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof Fail) { console.error(e.message); return e.code; }
    console.error(e.stack || e);
    return EXIT.other;
  } finally {
    release();
    process.off("SIGINT", sigint); process.off("SIGTERM", sigterm); process.off("exit", release);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
  process.exit(process.exitCode);
}
