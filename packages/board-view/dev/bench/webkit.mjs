// The bench on a desktop browser: an INDICATOR ONLY. WebKit on a Mac is not WebKit on a phone (no thermal limit, a fast GPU, not the
// phone's renderer), so what this prints says that the bench runs and whether the modes differ at all, never what the phone does.
// Builds the bench page into a temp folder, opens it from file:// as a web view would, calls `window.aiwbBench.run(opts)`, writes the
// result JSON (--out) and prints its summary. Needs Playwright (as dev/harness.mjs: `cd web && npm install --no-save playwright@1.64.1
// && npx playwright install webkit chromium`).
//   node dev/bench/webkit.mjs [--browser webkit|chromium] [--viewport 393x852] [--dpr 3] [--headed] [--reps 3] [--gesture-ms 4000]
//                             [--boards large,images] [--modes experiment|replacement|all|<list>] [--gestures pan,pinch] [--out <file.json>]
// --modes takes a SET (experiment: light, dark-today, dark-css, dark-none, dark-matrix; replacement: light, the five <theme> and the five
// <theme>-today; all: both), a list of modes, or both mixed ("replacement,dark-css"). Default: experiment. modeset.mjs says which is which.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatSummary } from "./stats.mjs";
import { estimateMs, formatDuration, LOAD_MS, parseModes } from "./modeset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "../..");

function findPlaywright() {
  const require = createRequire(import.meta.url);
  const dirs = [process.env.PLAYWRIGHT, path.join(pkg, "../../web/node_modules/playwright")].filter(Boolean);
  try { dirs.push(path.join(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: pkg, encoding: "utf8" }).trim(), "../web/node_modules/playwright")); } catch { /* not a checkout */ }
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npx)) dirs.push(...fs.readdirSync(npx).map((d) => path.join(npx, d, "node_modules/playwright")));
  try { return require("playwright"); } catch { /* try the folders */ }
  for (const d of dirs) if (fs.existsSync(path.join(d, "package.json"))) return require(d);
  throw new Error("playwright not found in:\n  " + dirs.join("\n  ") + "\nrun once: cd web && npm install --no-save playwright@1.64.1 && npx playwright install webkit chromium");
}

// ---- arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const list = (name) => value(name, undefined)?.split(",").filter(Boolean);
const known = new Set(["browser", "viewport", "dpr", "headed", "reps", "gesture-ms", "boards", "modes", "gestures", "out"]);
for (const a of args.filter((x) => x.startsWith("--"))) if (!known.has(a.slice(2))) { console.error(`unknown option ${a}`); process.exit(2); }

const browserName = value("browser", "webkit");
if (browserName !== "webkit" && browserName !== "chromium") { console.error("--browser is webkit or chromium"); process.exit(2); }
const [width, height] = value("viewport", "393x852").split("x").map(Number);
const dpr = Number(value("dpr", "3"));
const opts = {};
if (value("reps")) opts.reps = Number(value("reps"));
if (value("gesture-ms")) opts.gestureMs = Number(value("gesture-ms"));
if (list("boards")) opts.boards = list("boards");
opts.modes = parseModes(value("modes", "experiment"));
if (list("gestures")) opts.gestures = list("gestures");
const out = value("out");

// ---- the bench page

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-bench-"));
const dist = path.join(tmp, "page");
console.log(`building the bench page into ${dist} ...`);
execFileSync("node", ["build.mjs", "webview", "--out", dist], { cwd: pkg, env: { ...process.env, AIWB_BOARD_BENCH: "1" }, stdio: "inherit" });

const { chromium, webkit } = findPlaywright();
const browser = await (browserName === "webkit" ? webkit : chromium).launch({ headless: !flag("headed") });
let result;
try {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error(`page ${m.type()}:`, m.text()); });
  await page.goto(pathToFileURL(path.join(dist, "board.html")).href);
  await page.waitForFunction(() => !!window.aiwbBench, null, { timeout: 60_000 });
  const reps = opts.reps ?? 3, gestureMs = opts.gestureMs ?? 4000;
  const runs = reps * (opts.boards ?? ["large", "images"]).length * opts.modes.length * (opts.gestures ?? ["pan", "pinch"]).length;
  const expected = estimateMs({ ...opts, reps, gestureMs, loadMs: LOAD_MS.desktop });
  console.log(`${browserName} ${width}×${height} at ${dpr}x, ${headless() ? "headless" : "headed"}: ${opts.modes.length} modes (${opts.modes.join(", ")}), ${runs} runs of ${gestureMs} ms, expected about ${formatDuration(expected)} ...`);
  result = await page.evaluate((o) => window.aiwbBench.run(o), opts);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

function headless() { return !flag("headed"); }

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result) + "\n");
  console.log(`result written to ${out}`);
}
const failed = result.runs.filter((r) => r.failed);
console.log("\n" + formatSummary(result, `desktop ${browserName}: indicator, NOT a result`));
const filters = [...new Set(result.runs.map((r) => `${r.mode}: ${r.filter || "(none recorded)"}; blend layers in the page ${r.blendLayers?.present ?? "?"}, drawn ${r.blendLayers?.visible ?? "?"}`))];
console.log("\ncomputed filter of the static canvas and the blend layers per mode:\n  " + filters.join("\n  "));
if (failed.length) { console.log(`\n${failed.length} run(s) failed:\n  ` + failed.map((r) => `${r.board}/${r.mode}/${r.gesture}#${r.rep}: ${r.failed}`).join("\n  ")); process.exitCode = 1; }
