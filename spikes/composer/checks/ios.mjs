// The composer on the iOS simulator. It starts Metro for the development build that is installed there, opens the
// app, then runs two things against it:
//   1. the Maestro flow (checks/ios/composer.yaml): taps, typing, the edit menu. Each `mark` in it makes the app post
//      what the screen holds to the collector started here, and the assertions below are on those posts;
//   2. the XCUITest bundle of checks/ios-keys: the hardware keyboard's keys (arrows, shift + arrows, ⌘A/C/V/X, the delete
//      key), which Maestro cannot send. It is built here with the xcodeproj gem of CocoaPods and reads the screen's own
//      "shown" line.
// Needs: the development build installed (run.sh does `expo run:ios` if not), Maestro and a JRE (checks/get-maestro.sh),
// Xcode. Env: SIM (the simulator's udid), METRO_PORT (a free one by default), SKIP_KEYS=1 (no XCUITest), KEYS_ONLY=1 (only
// XCUITest), FLOW=<file> (run another Maestro flow and only write what the app posts to checks/out/posts.json).
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { message, sel, pt, tally } from "./lib.mjs";
import { chipText } from "../src/logic/chipdoc.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIM = process.env.SIM ?? "568782F7-8947-4040-A2B4-9375249806FB";
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const METRO = Number(process.env.METRO_PORT ?? (await freePort()));
const BUNDLE = "dev.aiwhiteboard.spike.composer";
const out = path.join(root, "checks", "out");
fs.mkdirSync(out, { recursive: true });
const tools = path.join(root, ".tools");
const env = { ...process.env, LANG: "en_US.UTF-8" };
if (fs.existsSync(path.join(tools, "maestro"))) {
  const jre = fs.readdirSync(path.join(tools, "jdk")).find((d) => d.startsWith("jdk"));
  env.JAVA_HOME = env.JAVA_HOME ?? path.join(tools, "jdk", jre, "Contents", "Home");
  env.PATH = `${path.join(tools, "maestro", "maestro", "bin")}:${env.PATH}`;
}

// ---- the collector: what the app posts
const posts = [];
const collector = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { posts.push(JSON.parse(b)); } catch {} res.end("ok"); });
});
await new Promise((r) => collector.listen(0, "127.0.0.1", r));
const REPORT = collector.address().port;

// ---- Metro, with the collector's address baked into the bundle
const metro = spawn("npx", ["expo", "start", "--dev-client", "--port", String(METRO), "--clear"], { cwd: root, env: { ...env, CI: "1", EXPO_PUBLIC_REPORT_URL: `http://127.0.0.1:${REPORT}` }, stdio: ["ignore", "pipe", "pipe"] });
let metroLog = "";
metro.stdout.on("data", (d) => (metroLog += d));
metro.stderr.on("data", (d) => (metroLog += d));
const cleanup = () => { metro.kill(); collector.close(); };
process.on("exit", cleanup);

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { env, encoding: "utf8", ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return; await sleep(300); } throw new Error(`timeout: ${what}\n${metroLog.slice(-800)}`); };

const T = tally("ios");

/** Builds the XCUITest bundle of checks/ios-keys (its project is made by the xcodeproj gem of CocoaPods) and runs it against the app that is open. */
function keys() {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aiwb-keys-"));
  fs.copyFileSync(path.join(root, "checks/ios-keys/KeysTests.swift"), path.join(work, "KeysTests.swift"));
  const libexec = sh("sh", ["-c", "ls -d $(brew --prefix cocoapods)/libexec"]).stdout.trim();
  const mk = sh("ruby", [path.join(root, "checks/ios-keys/make-project.rb"), work], { env: { ...env, GEM_PATH: libexec } });
  if (mk.status !== 0) return T.ok(false, "the XCUITest project could not be made", mk.stderr);
  const r = sh("xcodebuild", ["test", "-project", path.join(work, "KeysUITests.xcodeproj"), "-scheme", "KeysUITests", "-destination", `platform=iOS Simulator,id=${SIM}`, "-derivedDataPath", path.join(work, "dd")], { maxBuffer: 1 << 28 });
  fs.writeFileSync(path.join(out, "keys.log"), r.stdout + r.stderr);
  const lines = (r.stdout + r.stderr).split("\n");
  for (const l of lines) {
    const m = l.match(/Test Case '-\[KeysUITests\.KeysUITests (\w+)\]' (passed|failed)/);
    if (m) T.ok(m[2] === "passed", `hardware keyboard, XCUITest ${m[1]}`, lines.filter((x) => x.includes("error:")).join("\n     "));
  }
  if (!lines.some((l) => /Test Case .* (passed|failed)/.test(l))) T.ok(false, "XCUITest ran no test (see checks/out/keys.log)", lines.slice(-15).join("\n"));
}
try {
  await until(() => /Waiting on|Logs for your project/.test(metroLog), 120000, "metro");
  sh("xcrun", ["simctl", "boot", SIM]);
  sh("xcrun", ["simctl", "bootstatus", SIM, "-b"]);
  sh("xcrun", ["simctl", "terminate", SIM, BUNDLE]);
  sh("xcrun", ["simctl", "openurl", SIM, `${BUNDLE}://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${METRO}`)}`]);
  // the system asks "Open in …?": Maestro taps it; the first state the app posts shows it has loaded
  const open = spawn("maestro", ["--device", SIM, "test", path.join(root, "checks/ios/open.yaml")], { env, stdio: "inherit" });
  await until(() => posts.length > 0, 240000, "the app's first report (bundle loaded)");
  await new Promise((r) => open.on("exit", r));
  posts.length = 0;

  const flowEnv = ["CHIP_LEFT", "CHIP_RIGHT", "CHIP_MID"].flatMap((k) => ["-e", `${k}=${process.env[k] ?? { CHIP_LEFT: "21%,14%", CHIP_RIGHT: "44%,14%", CHIP_MID: "28%,14%" }[k]}`]);
  const flow = process.env.FLOW ?? path.join(root, "checks/ios/composer.yaml"); // FLOW=<file>: another flow, to look at (every post is written to checks/out/posts.json)
  // A UI driver on a busy machine drops a tap now and then: the flow starts with a reset, so one more attempt is allowed.
  let r = { status: 0 };
  for (let attempt = 1; !process.env.KEYS_ONLY && attempt <= 2; attempt++) {
    posts.length = 0;
    r = sh("maestro", ["--device", SIM, "test", ...flowEnv, "--test-output-dir", out, flow], { stdio: "inherit" });
    if (r.status === 0) break;
    console.log(`the Maestro flow failed (attempt ${attempt})`);
  }
  if (!process.env.KEYS_ONLY) T.eq(r.status, 0, "the Maestro flow ran to its end");
  await sleep(1500);

  // ---- assertions on the marks
  if (!process.env.KEYS_ONLY) {
  const ordered = [...posts].sort((a, b) => a.seq - b.seq);
  const marks = ordered.filter((p) => p.mark !== undefined).map((p) => p.state);
  const sent = ordered.find((p) => p.sent !== undefined);
  fs.writeFileSync(path.join(out, "posts.json"), JSON.stringify(ordered.map((p) => ({ seq: p.seq, mark: p.mark, raw: p.raw && `${p.raw.start}-${p.raw.end}`, sent: p.sent, height: p.height, sel: p.selection && `${p.selection.start}-${p.selection.end}`, text: p.text, value: p.value && p.value.slice(0, 30) })), null, 0).replace(/},/g, "},\n"));
  fs.writeFileSync(path.join(out, "marks.json"), JSON.stringify({ marks, sent }, null, 1));
  const A = sel(0), B = sel(1), P = pt();
  const c = chipText(A);
  const inside = (m) => m.chips.some(([s, e]) => [m.selection.start, m.selection.end].some((p) => p > s && p < e));
  if (process.env.FLOW) { console.log("posts in checks/out/posts.json"); cleanup(); process.exit(r.status ?? 1); }
  T.eq(marks.length, 18, "all 18 marks were posted");
  const m = (i) => marks[i] ?? { value: "(no mark)", chips: [], selection: { start: -1, end: -1 }, text: "" };

  T.eq(m(0).value, message("move ", A, " to"), "insert at the caret, type after it: message is refs.ts' serialize");
  T.ok(m(0).text === `move ${c} to`, "the field shows the chip as its label between no-break spaces", JSON.stringify(m(0).text));
  T.ok(!inside(m(1)), "a tap in the left half of the chip: the caret is not inside it", JSON.stringify(m(1).selection));
  T.eq(m(1).selection.start, m(1).chips[0]?.[0], "…it is at the chip's start");
  T.eq(m(2).value, message("move X", A, " to"), "typing there goes before the chip");
  T.eq(m(3).value, message("move ", A, " to"), "backspace removes the typed X, not the chip");
  T.ok(!inside(m(4)), "a tap in the right half of the chip: the caret is not inside it", JSON.stringify(m(4).selection));
  T.eq(m(4).selection.start, m(4).chips[0]?.[1], "…it is at the chip's end");
  T.eq(m(5).value, message("move ", A, "Y to"), "typing there goes after the chip");
  T.eq(m(6).value, message("a ", A, " "), "chip inserted after 'a': spaces around it");
  T.eq(m(7).value, message("a ", A), "backspace removes the space after the chip");
  T.eq(m(8).value, "a ", "one backspace removes the whole chip");
  T.ok(m(8).chips.length === 0, "the field holds no chip any more");
  T.ok(m(9).selection.start === m(9).chips[0]?.[0] && m(9).selection.end === m(9).chips[0]?.[1], "a double tap in a chip selects the chip whole", JSON.stringify([m(9).selection, m(9).chips]));
  T.eq(m(10).value, "ab Z cd", "typing over the selected chip replaces it");
  T.ok(m(12).height > m(11).height + 15, "the box grows with its lines", `${m(11).height} -> ${m(12).height}`);
  T.ok(m(13).height > m(12).height && m(13).height < 260, "…and stops growing at its maximum height", `${m(12).height} -> ${m(13).height}`);
  T.ok(m(13).value.startsWith("one\ntwo\nthree\n"), "line breaks are in the message");
  T.eq(m(14).value, message("move ", sel(0), " to ", sel(1), " and keep ", P, " \nthanks"), "the message of 2 selections, a point and a line break equals refs.ts'");
  T.eq(sent?.sent, message("move ", sel(0), " to ", sel(1), " and keep ", P, " \nthanks").trim(), "what is sent is the trimmed message");
  T.eq(m(15).value, "", "the box is empty after the send");
  T.eq(m(16).value, message("ab ", A, " cd"), "a chip selected and copied: the field is as it was");
  T.eq(m(17).value, message("ab ", A, " cd", A), "pasted into the field it comes back as a chip (the platform's clipboard holds the label, the input knows it)");
  T.ok(m(17).chips.length === 2, "…and the field holds two chips");
  }
  // ---- the hardware keyboard: XCUITest (checks/ios-keys) sends the keys Maestro cannot
  if (!process.env.SKIP_KEYS) keys();
} catch (e) {
  T.ok(false, String(e.message ?? e));
}
const ok = T.done();
cleanup();
process.exit(ok ? 0 : 1);
