// The keys Maestro cannot send (the hardware keyboard's ⌘ combinations on iOS, AD-83): an XCUITest bundle, generated and run against
// the development build that is open on the simulator. The runner calls this after the Maestro flow when the flow's header has
// `xcuitest=<name>`; the bundle is app/e2e/xcuitest/<name>/*.swift (the bundle id of the app stands for __APP_ID__ in it) and its
// project is made by xcuitest/make-project.rb with the xcodeproj gem of CocoaPods (as the composer spike did). The app is left as the
// test left it: the caller takes a screenshot and stops it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const xcuitestDir = path.resolve(here, "../xcuitest");

/** The folder of the xcodeproj gem: CocoaPods' (Homebrew's, or `gem env` where the gem is installed). */
function gemPath() {
  const brew = spawnSync("sh", ["-c", "ls -d $(brew --prefix cocoapods 2>/dev/null)/libexec 2>/dev/null"], { encoding: "utf8" }).stdout.trim();
  return brew || process.env.GEM_PATH || "";
}

/** Builds and runs the bundle (`vars`: other placeholders of its sources, e.g. `__CONTROL_URL__`, and what they stand for); { ok, cases: [{name, passed}], log } (the whole log is written to `<out>/xcuitest-<name>.log`). Asynchronous:
 *  the runner's collector of what the app posts runs in the same process and must keep answering while the bundle runs. */
export async function runXcuitest({ name, udid, appId, out, vars = {} }) {
  const src = path.join(xcuitestDir, name);
  if (!fs.existsSync(src)) throw new Error(`no XCUITest bundle app/e2e/xcuitest/${name}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `aiwb-xcuitest-${name}-`));
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".swift"))) {
    let text = fs.readFileSync(path.join(src, f), "utf8").replaceAll("__APP_ID__", appId);
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(k, v);
    fs.writeFileSync(path.join(work, f), text);
  }
  const env = { ...process.env, GEM_PATH: gemPath(), LANG: "en_US.UTF-8" };
  const mk = spawnSync("ruby", [path.join(xcuitestDir, "make-project.rb"), work], { env, encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`the XCUITest project could not be made (CocoaPods' xcodeproj gem; brew install cocoapods): ${mk.stderr || mk.stdout}`);
  const logFile = path.join(out, `xcuitest-${name}.log`);
  const r = await new Promise((resolve) => {
    const p = spawn("xcodebuild", ["test", "-project", path.join(work, "UITests.xcodeproj"), "-scheme", "UITests", "-destination", `platform=iOS Simulator,id=${udid}`, "-derivedDataPath", path.join(work, "dd")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    p.on("close", (status) => resolve({ status, text }));
  });
  const log = r.text;
  fs.writeFileSync(logFile, log);
  const cases = [...log.matchAll(/Test Case '-\[UITests\.(\w+) (\w+)\]' (passed|failed)/g)].map((m) => ({ name: `${m[1]}.${m[2]}`, passed: m[3] === "passed" }));
  fs.rmSync(work, { recursive: true, force: true });
  return { ok: r.status === 0 && cases.length > 0 && cases.every((c) => c.passed), cases, log, logFile };
}
