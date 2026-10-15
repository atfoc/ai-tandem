#!/usr/bin/env node
// Installs AI Whiteboard on a phone or tablet (goal 4.9, architecture §10): a Release build of the current code, put on the device
// you name or on the only one connected, and opened. No store, no TestFlight, no credential in the repository. Run again, it builds
// and installs the current state of the code.
//
//   node app/scripts/install.mjs --platform android|ios [--device <id|serial|name>] [--check] [--no-open] [--list]
//   scripts/install-app-device.sh --platform android|ios ...        the same, from anywhere
//
//   --platform   android: any Android phone or tablet with USB debugging on, over adb; no account.
//                ios: an iPhone or iPad, signed with your own Apple developer team (the free personal team is enough), installed with
//                xcodebuild and devicectl. An iOS simulator, named with --device, is built without signing (to try the build part).
//   --device     the adb serial / the device's UDID or CoreDevice id / its name. Without it, exactly one device must be connected
//                (iOS simulators are only used when named).
//   --check      checks the tools, the signing and the device, says what it would do, builds nothing.
//   --no-open    installs without opening the app.
//   --list       lists the devices of the platform and stops.
//   --ipa        ios only: builds a signed .ipa file instead of installing, for a device you do not have connected: put the file anywhere
//                and install it later (Finder / Apple Configurator, or a download page). No device is needed, but the device's UDID must
//                be registered with the team. The file is written to bin/ios/ (or --out <folder>).
//   --serve      with --ipa implied: after the build, serves the .ipa over https on the local network (or VPN) so that the device installs
//                it by opening a link in Safari; the device trusts this computer's certificate once (scripts/serve-ipa.mjs). Runs until Ctrl-C.
//   --method     with --ipa: development (default; any team, free included; devices of the team's development profile) or ad-hoc (paid
//                Apple Developer Program: an Apple Distribution certificate; devices of the team's ad hoc profile).
//
// Environment (never a file of the repository, goal 4.9):
//   AIWB_IOS_TEAM_ID     the Apple developer team's 10-character id; iOS on a real device needs it. Without it the script stops at the
//                        signing step and says what the install needs from your Apple account.
//   AIWB_IOS_BUNDLE_ID   the iOS bundle id (default local.aiwhiteboard.app); a free team needs one that no other team has taken.
//   AIWB_ANDROID_PACKAGE the Android package (default local.aiwhiteboard.app).
//   ANDROID_HOME         the Android SDK (default ~/Library/Android/sdk); JAVA_HOME a JDK 17 (Homebrew's openjdk@17 is found).
//
// Steps: 1 tools · 2 signing · 3 device · 4 dependencies (`npm ci` when node_modules is older than the lock file) · 5 the board's page
// (`npm run prebuild:board`) and the app's config · 6 the native project (`expo prebuild --clean`; nothing native is committed, AD-5) ·
// 7 the Release build · 8 install and open. The logs of every step are in a folder under the system's temporary folder, printed first.
// On a failure it says the step, the reason, what to do when the failure is a known one, and the last lines of the tool's log.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adbPath, androidHome, jdk17 } from "./lib/devtools.mjs";
import { describeDevice, explainFailure, parseAdbDevices, parseArgs, parseDevicectl, parseSimctl, pickDevice, signingNeeds, tail, validTeamId } from "./lib/install-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoDir = path.resolve(appDir, "..");
const DEFAULT_ID = "local.aiwhiteboard.app";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (args.errors.length) { console.error(`${args.errors.join("\n")}\nusage: node app/scripts/install.mjs --platform android|ios [--device <id|name>] [--check] [--no-open] [--list]   (--help says more)`); process.exit(2); }

const TOTAL = args.serve ? 7 : args.ipa ? 6 : 8;
const platform = args.platform;
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-install-"));
const teamId = process.env.AIWB_IOS_TEAM_ID ?? "";
const bundleId = process.env.AIWB_IOS_BUNDLE_ID || DEFAULT_ID;
const androidPackage = process.env.AIWB_ANDROID_PACKAGE || DEFAULT_ID;

/** A step that cannot go on: the script prints it and stops with status 1. */
class Stop extends Error {
  constructor(message, { hint = "", log = "", output = "" } = {}) { super(message); this.hint = hint; this.log = log; this.output = output; }
}
let current = { n: 0, name: "" };
async function step(name, fn) {
  current = { n: current.n + 1, name };
  say(`step ${current.n}/${TOTAL}: ${name}`);
  return fn();
}

// ---------------------------------------------------------------- running tools
const capture = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 1 << 26, ...o });

/** Runs a tool with its output in the step's log file; throws a Stop with the log's end and a hint when it fails. */
async function run(what, cmd, a, { cwd = appDir, env = process.env, fallbackHint = "", timeoutMs = 0 } = {}) {
  const log = path.join(logDir, `${current.n}-${current.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`);
  fs.appendFileSync(log, `$ ${cmd} ${a.join(" ")}\n(in ${cwd})\n`);
  say(`  ${what} (log: ${log})`);
  const fd = fs.openSync(log, "a");
  const started = Date.now();
  const status = await new Promise((resolve) => {
    const p = spawn(cmd, a, { cwd, env, stdio: ["ignore", fd, fd] });
    const limit = timeoutMs ? setTimeout(() => { fs.appendFileSync(log, `\n(stopped by the script after ${timeoutMs / 1000} s)\n`); p.kill("SIGKILL"); }, timeoutMs) : null;
    const beat = setInterval(() => say(`  ... ${what}: still running (${Math.round((Date.now() - started) / 1000)} s)`), 60000);
    p.on("error", (e) => { fs.appendFileSync(log, `${e.message}\n`); clearInterval(beat); clearTimeout(limit); resolve(127); });
    p.on("close", (code) => { clearInterval(beat); clearTimeout(limit); resolve(code ?? 1); });
  });
  fs.closeSync(fd);
  if (status !== 0) {
    const text = fs.readFileSync(log, "utf8");
    throw new Stop(`${what} failed (exit ${status})`, { hint: explainFailure(text.slice(-20000)) || fallbackHint, log, output: tail(text) });
  }
  return log;
}

// ---------------------------------------------------------------- the devices
function listAndroid() {
  const r = capture(adbPath(), ["devices", "-l"]);
  return r.status === 0 ? parseAdbDevices(r.stdout) : [];
}

function listIos() {
  const f = path.join(logDir, "devicectl-list.json");
  const r = capture("xcrun", ["devicectl", "list", "devices", "--json-output", f]);
  const real = r.status === 0 && fs.existsSync(f) ? parseDevicectl(JSON.parse(fs.readFileSync(f, "utf8"))) : [];
  const s = capture("xcrun", ["simctl", "list", "devices", "--json"]);
  const sims = s.status === 0 ? parseSimctl(JSON.parse(s.stdout)) : [];
  return { real, sims };
}

// ---------------------------------------------------------------- the steps
function checkTools() {
  const problems = [];
  const need = (ok, what, how) => { if (!ok) problems.push(`${what}: ${how}`); };
  const major = Number(process.versions.node.split(".")[0]);
  need(major >= 22, `Node ${process.versions.node} is too old`, "install Node 22.19 or newer (https://nodejs.org)");
  need(capture("npm", ["--version"]).status === 0, "npm is missing", "it comes with Node");
  if (platform === "ios") {
    need(process.platform === "darwin", "iOS needs a Mac", "run this on macOS");
    need(capture("xcrun", ["--find", "xcodebuild"]).status === 0, "Xcode is missing", "install Xcode from the Mac App Store, open it once, and run: sudo xcode-select -s /Applications/Xcode.app");
    need(capture("xcrun", ["devicectl", "--version"]).status === 0, "xcrun devicectl is missing", "it comes with Xcode 15 or newer; update Xcode");
    need(capture("pod", ["--version"]).status === 0, "CocoaPods is missing", "brew install cocoapods");
  } else {
    need(fs.existsSync(adbPath()), `no adb at ${adbPath()}`, "install the Android SDK (Android Studio, or command-line tools with platform-tools) and set ANDROID_HOME to it");
    need(fs.existsSync(path.join(androidHome(), "platforms")), `no Android SDK platforms in ${androidHome()}`, "install them with Android Studio's SDK Manager (platform 36, build-tools 36.0.0), or set ANDROID_HOME");
    try { jdk17(); } catch (e) { need(false, "no JDK 17 for Gradle", "brew install openjdk@17, or set JAVA_HOME to a JDK 17"); }
  }
  if (problems.length) throw new Stop(`${problems.length} tool(s) missing`, { hint: problems.map((p) => `  - ${p}`).join("\n") });
  say(`  tools: ok (node ${process.versions.node}${platform === "ios" ? ", Xcode, devicectl, CocoaPods" : `, adb, JDK ${process.env.JAVA_HOME || jdk17()}`})`);
}

/** The device list is read before the signing step, because a simulator needs no signing. */
let target = null;
function chooseSigning() {
  if (platform === "android") {
    say("  Android: no account of yours is needed; the Release build is signed with the debug key of the generated project (a public key, not a credential)");
    return;
  }
  const { real, sims } = listIos();
  const named = !args.ipa && args.device && pickDevice([], args.device, sims);
  if (named?.device?.kind === "simulator") { say("  a simulator: no signing"); return; }
  if (!teamId) throw new Stop("AIWB_IOS_TEAM_ID is not set, and a real iPhone or iPad cannot be installed to without a team to sign with", { hint: signingNeeds });
  if (!validTeamId(teamId)) throw new Stop("AIWB_IOS_TEAM_ID is not a team id (ten capital letters and digits, like ABCDE12345)", { hint: signingNeeds });
  say(`  signing: Apple developer team from AIWB_IOS_TEAM_ID (${teamId.slice(0, 2)}********), automatic signing, Xcode's signed-in account${bundleId === DEFAULT_ID ? `; bundle id ${DEFAULT_ID} (set AIWB_IOS_BUNDLE_ID if Apple says it is taken)` : `; bundle id ${bundleId}`}`);
  void real;
}

function chooseDevice() {
  const pool = platform === "android" ? { real: listAndroid(), sims: [] } : listIos();
  const r = pickDevice(pool.real, args.device, pool.sims);
  if (!r.device) {
    const lines = (r.candidates ?? []).map((d) => `    ${describeDevice(d)}`);
    const how = platform === "android"
      ? "Connect the phone by USB, turn on Developer options > USB debugging, accept \"Allow USB debugging\" on it, and check `adb devices`; or name one: --device <serial>."
      : "Connect the iPhone or iPad by cable, unlock it, answer \"Trust This Computer\", and check `xcrun devicectl list devices`; or name one: --device <udid|name>.";
    throw new Stop(r.problem, { hint: `${lines.length ? `Devices:\n${lines.join("\n")}\n` : ""}${how}` });
  }
  const d = r.device;
  if (platform === "android" && d.state !== "device") {
    throw new Stop(`${d.id} is ${d.state}`, { hint: d.state === "unauthorized" ? "Unlock the phone and accept \"Allow USB debugging\" (tick \"Always allow\"); then run again." : "Unplug and replug the cable, or run `adb kill-server`; then run again." });
  }
  if (d.kind === "ios" && !d.usable) throw new Stop(`${d.name} is known to Xcode but not reachable now`, { hint: "Connect it by cable, unlock it, answer \"Trust This Computer\" if asked; then run again." });
  if (d.developerModeOff) throw new Stop(`${d.name} has Developer Mode off`, { hint: explainFailure("Developer Mode is disabled") });
  target = d;
  say(`  device: ${describeDevice(d)}`);
  if (d.note) say(`  note: ${d.note}`);
}

async function installDependencies() {
  const lock = path.join(repoDir, "package-lock.json");
  const marker = path.join(repoDir, "node_modules/.package-lock.json");
  const stale = !fs.existsSync(marker) || fs.statSync(marker).mtimeMs < fs.statSync(lock).mtimeMs;
  if (!stale) { say("  node_modules is newer than package-lock.json: not installing"); return; }
  await run("npm ci", "npm", ["ci"], { cwd: repoDir });
}

let appConfig = null;
async function boardPageAndConfig() {
  await run("npm run prebuild:board (the board's page)", "npm", ["run", "prebuild:board"]);
  const html = path.join(repoDir, "packages/board-view/dist-webview/board.html");
  if (!fs.existsSync(html)) throw new Stop(`prebuild:board left no ${html}`);
  const r = capture("npx", ["expo", "config", "--type", "public", "--json"], { cwd: appDir, env: { ...process.env, CI: "1" } });
  const text = r.stdout ?? "";
  try { appConfig = JSON.parse(text.slice(text.indexOf("{"))); } catch { throw new Stop("the app's config (npx expo config) could not be read", { output: tail(`${r.stdout}\n${r.stderr}`) }); }
  const id = platform === "ios" ? appConfig.ios?.bundleIdentifier : appConfig.android?.package;
  say(`  ${appConfig.name} ${appConfig.version}, ${platform === "ios" ? "bundle id" : "package"} ${id}`);
}

const buildEnv = () => {
  const env = { ...process.env, CI: "1", LANG: "en_US.UTF-8" };
  if (platform === "android") {
    env.ANDROID_HOME = androidHome();
    env.PATH = `${path.join(androidHome(), "platform-tools")}:${env.PATH}`;
    env.JAVA_HOME = process.env.JAVA_HOME || jdk17();
  }
  return env;
};

async function nativeProject() {
  // (`expo prebuild` also rewrites app/package.json and app/tsconfig.json; a run leaves them as they were)
  await run(`npx expo prebuild --platform ${platform} --clean`, "npx", ["expo", "prebuild", "--platform", platform, "--clean", ...(platform === "android" ? ["--no-install"] : [])], { env: buildEnv() });
}

let artifact = "";
async function build() {
  const env = buildEnv();
  if (platform === "android") {
    const abi = capture(adbPath(), ["-s", target.id, "shell", "getprop", "ro.product.cpu.abilist"]).stdout.trim().split(",")[0];
    const abiArgs = abi ? [`-PreactNativeArchitectures=${abi}`] : [];
    await run(`gradle assembleRelease${abi ? ` for ${abi}` : ""}`, "./gradlew", ["assembleRelease", "--console=plain", ...abiArgs], { cwd: path.join(appDir, "android"), env });
    artifact = path.join(appDir, "android/app/build/outputs/apk/release/app-release.apk");
    if (!fs.existsSync(artifact)) throw new Stop(`the build left no ${artifact}`);
    say(`  built ${artifact} (${(fs.statSync(artifact).size / 1e6).toFixed(1)} MB)`);
    return;
  }
  const ios = path.join(appDir, "ios");
  const workspace = fs.readdirSync(ios).find((f) => f.endsWith(".xcworkspace"));
  if (!workspace) throw new Stop(`prebuild left no .xcworkspace in ${ios}`);
  const scheme = workspace.replace(/\.xcworkspace$/, "");
  const sim = target.kind === "simulator";
  const xc = ["-workspace", path.join(ios, workspace), "-scheme", scheme, "-configuration", "Release", "-destination", `id=${target.udid}`, "-derivedDataPath", path.join(ios, "build")];
  // (the device's own architecture only, as `expo run:ios` builds; a Release build is otherwise universal, and slower to build and to install)
  xc.push("ONLY_ACTIVE_ARCH=YES");
  if (!sim) xc.push("-allowProvisioningUpdates", `DEVELOPMENT_TEAM=${teamId}`, "CODE_SIGN_STYLE=Automatic");
  xc.push("build");
  await run(`xcodebuild ${scheme} Release for ${sim ? "the simulator" : target.name}${sim ? "" : " (signing automatically; the first build of a device may register it with Apple)"}`, "xcodebuild", xc, { cwd: ios, env });
  const products = path.join(ios, "build/Build/Products", sim ? "Release-iphonesimulator" : "Release-iphoneos");
  const app = fs.existsSync(products) && fs.readdirSync(products).find((f) => f.endsWith(".app"));
  if (!app) throw new Stop(`the build left no .app in ${products}`);
  artifact = path.join(products, app);
  say(`  built ${artifact}`);
}

/** --ipa: archives the app for any iPhone or iPad and exports a signed .ipa, which is not installed anywhere. */
async function buildIpa() {
  const ios = path.join(appDir, "ios");
  const workspace = fs.readdirSync(ios).find((f) => f.endsWith(".xcworkspace"));
  if (!workspace) throw new Stop(`prebuild left no .xcworkspace in ${ios}`);
  const scheme = workspace.replace(/\.xcworkspace$/, "");
  const archive = path.join(ios, "build", `${scheme}.xcarchive`);
  const out = path.resolve(args.out || path.join(repoDir, "bin/ios"));
  const exportDir = path.join(ios, "build", "export");
  fs.rmSync(archive, { recursive: true, force: true });
  fs.rmSync(exportDir, { recursive: true, force: true });
  const env = buildEnv();
  await run(`xcodebuild archive ${scheme} Release (signing automatically)`, "xcodebuild", [
    "-workspace", path.join(ios, workspace), "-scheme", scheme, "-configuration", "Release", "-destination", "generic/platform=iOS",
    "-archivePath", archive, "-allowProvisioningUpdates", `DEVELOPMENT_TEAM=${teamId}`, "CODE_SIGN_STYLE=Automatic", "archive",
  ], { cwd: ios, env });
  const options = path.join(logDir, "ExportOptions.plist");
  fs.writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${args.method}</string>
  <key>teamID</key><string>${teamId}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>stripSwiftSymbols</key><true/>
  <key>compileBitcode</key><false/>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict></plist>
`);
  await run(`xcodebuild -exportArchive (${args.method})`, "xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exportDir, "-exportOptionsPlist", options, "-allowProvisioningUpdates"], { cwd: ios, env });
  const ipa = fs.readdirSync(exportDir).find((f) => f.endsWith(".ipa"));
  if (!ipa) throw new Stop(`the export left no .ipa in ${exportDir}`);
  fs.mkdirSync(out, { recursive: true });
  const name = `${appConfig?.name ?? scheme}-${appConfig?.version ?? "0"}-${args.method}.ipa`.replace(/\s+/g, "");
  artifact = path.join(out, name);
  fs.copyFileSync(path.join(exportDir, ipa), artifact);
  say(`  built ${artifact} (${(fs.statSync(artifact).size / 1e6).toFixed(1)} MB)`);
}

async function installAndOpen() {
  const id = platform === "android" ? androidPackage : bundleId;
  if (platform === "android") {
    await run(`adb install -r on ${target.id}`, adbPath(), ["-s", target.id, "install", "-r", artifact]);
    if (args.noOpen) return say("  installed; not opened (--no-open)");
    capture(adbPath(), ["-s", target.id, "shell", "monkey", "-p", id, "-c", "android.intent.category.LAUNCHER", "1"]);
    for (let i = 0; i < 10; i++) {
      if (capture(adbPath(), ["-s", target.id, "shell", "pidof", id]).stdout.trim()) return say(`  the app is running on ${target.name}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    say("  WARNING: installed, but the app is not running yet: unlock the phone and open AI Whiteboard from its icon");
    return;
  }
  const builtId = capture("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(artifact, "Info.plist")]).stdout.trim() || id;
  if (target.kind === "simulator") {
    // (`bootstatus -b` boots it if it is not, and waits until it is ready; a simulator listed as Booted may still be starting. The install
    // goes through CoreSimulator's service for the whole machine: when that does not answer, the install is asked again once, then it stops)
    await run(`boot the simulator ${target.name} and wait until it is ready`, "xcrun", ["simctl", "bootstatus", target.udid, "-b"]);
    for (let attempt = 1; ; attempt++) {
      try {
        await run(`simctl install on ${target.name}`, "xcrun", ["simctl", "install", target.udid, artifact], { timeoutMs: 120000, fallbackHint: "CoreSimulator does not answer the install (it serves every simulator of the machine, so another tool's stuck install can block it): shut the simulator down (xcrun simctl shutdown <udid>), or restart the service (killall -9 com.apple.CoreSimulator.CoreSimulatorService, which ends every running simulator), then run again." });
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        say("  the install did not answer; asking again");
      }
    }
    if (args.noOpen) return say("  installed; not opened (--no-open)");
    await run(`simctl launch ${builtId}`, "xcrun", ["simctl", "launch", target.udid, builtId]);
    return;
  }
  await run(`devicectl install on ${target.name}`, "xcrun", ["devicectl", "device", "install", "app", "--device", target.id, artifact]);
  if (args.noOpen) return say("  installed; not opened (--no-open)");
  try {
    await run(`devicectl launch ${builtId}`, "xcrun", ["devicectl", "device", "process", "launch", "--device", target.id, "--terminate-existing", builtId]);
  } catch (e) {
    // The app is on the device; opening it failed (locked screen, a developer not yet trusted): that is a hint, not a failed install.
    say(`  WARNING: installed, but the app could not be opened: ${e.hint || e.message}`);
  }
}

// ---------------------------------------------------------------- main
const kept = ["package.json", "tsconfig.json"].map((f) => [path.join(appDir, f), fs.readFileSync(path.join(appDir, f))]);
const restoreTracked = () => { for (const [f, b] of kept) if (!fs.readFileSync(f).equals(b)) fs.writeFileSync(f, b); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restoreTracked(); console.error(`\nInterrupted at step ${current.n}/${TOTAL} (${current.name}). Logs: ${logDir}`); process.exit(130); });

if (args.list) {
  const devices = platform === "android" ? listAndroid() : (() => { const { real, sims } = listIos(); return [...real, ...sims]; })();
  console.log(devices.length ? devices.map(describeDevice).join("\n") : `no ${platform} device is connected`);
  process.exit(0);
}

say(`install AI Whiteboard on ${platform}${args.device ? ` (${args.device})` : ""}; logs in ${logDir}`);
let status = 0;
try {
  await step("tools", checkTools);
  await step("signing", chooseSigning);
  if (!args.ipa) await step("device", chooseDevice);
  if (args.check && args.ipa) {
    say(`CHECK OK: it would build a signed ${args.method} .ipa for team ${teamId} into ${path.resolve(args.out || path.join(repoDir, "bin/ios"))}. Nothing was built.`);
  } else if (args.check) {
    say(`CHECK OK: it would build a Release build for ${target.name} (${platform}) and install${args.noOpen ? "" : " and open"} it. Nothing was built.`);
  } else if (args.ipa) {
    await step("dependencies", installDependencies);
    await step("the board's page and the config", boardPageAndConfig);
    await step("native project", nativeProject);
    await step("archive and export the .ipa", buildIpa);
    say(`DONE: ${path.basename(artifact)} (${bundleId}, ${args.method}) is in ${path.dirname(artifact)}, in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
    say("  Install it on a device whose UDID is registered with the team: drag it onto the device in Finder (or Apple Configurator), or serve it from an https page with an itms-services manifest.plist.");
    say(`  Logs: ${logDir}`);
    if (args.serve) {
      await step("serve the .ipa", async () => {
        restoreTracked();
        const { serveIpa } = await import("./serve-ipa.mjs");
        try { await serveIpa({ ipa: artifact, say }); } catch (e) { throw new Stop(e.message, { hint: `The .ipa is built (${artifact}); serve it later with: node app/scripts/serve-ipa.mjs` }); }
      });
    }
  } else {
    await step("dependencies", installDependencies);
    await step("the board's page and the config", boardPageAndConfig);
    await step("native project", nativeProject);
    await step("build", build);
    await step("install and open", installAndOpen);
    const id = platform === "android" ? androidPackage : bundleId;
    say(`DONE: ${appConfig?.name ?? "AI Whiteboard"} ${appConfig?.version ?? ""} (${id}) is on ${target.name} (${target.id}), ${platform} Release build of ${path.basename(artifact)}, in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
    if (platform === "ios" && target.kind === "ios") say("  If iOS says \"Untrusted Developer\": Settings > General > VPN & Device Management > your Apple Development entry > Trust. A free team's install lasts 7 days: run this again after that.");
    say(`  Run it again any time to build and install the current code. Logs: ${logDir}`);
  }
} catch (e) {
  status = 1;
  if (!(e instanceof Stop)) { console.error(e.stack || e); }
  console.error(`\nSTOPPED at step ${current.n}/${TOTAL} (${current.name}): ${e.message}`);
  if (e.hint) console.error(`\n${e.hint}`);
  if (e.output) console.error(`\nThe end of the log${e.log ? ` (${e.log})` : ""}:\n${e.output}`);
  console.error(`\nNothing was installed unless a step above says so. Logs: ${logDir}`);
} finally {
  restoreTracked();
}
process.exit(status);
