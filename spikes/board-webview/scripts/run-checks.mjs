// Launches the installed app on the simulator with a scenario, watches its results file, takes the memory readings and
// the screenshots at the phases the app announces, runs Maestro for the touch check, and prints what it found.
// Called by run.sh. Usage: node scripts/run-checks.mjs <udid> <outdir> [--runs N] [--no-touch] [--no-auto]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const [udid, out] = process.argv.slice(2, 4);
const args = process.argv.slice(4);
const runs = Number(args[args.indexOf("--runs") + 1]) || Number(process.env.AIWB_RUNS) || 1;
const BUNDLE = "dev.aiwb.spike.boardwebview";
const PROBE_PORT = 47931;
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sim = (...a) => execFileSync("xcrun", ["simctl", ...a], { encoding: "utf8" }).trim();
const docs = () => path.join(sim("get_app_container", udid, BUNDLE, "data"), "Documents");
const readResults = () => { try { return JSON.parse(fs.readFileSync(path.join(docs(), "results.json"), "utf8")); } catch { return null; } };
const memory = () => JSON.parse(execFileSync("node", [path.join(here, "memory.mjs"), udid], { encoding: "utf8" }));
let failures = 0;
const fail = (what) => { failures++; console.log(`FAIL ${what}`); };

// ---- the listener the page must not reach
const hitsFile = path.join(out, "probe-hits.txt");
const probe = spawn("node", [path.join(here, "probe-server.mjs"), String(PROBE_PORT), hitsFile], { stdio: "ignore" });
process.on("exit", () => probe.kill());
await sleep(500);

function launch(scenario) {
  try { sim("terminate", udid, BUNDLE); } catch { /* not running */ }
  try { fs.rmSync(path.join(docs(), "results.json"), { force: true }); } catch { /* first run */ }
  const t = Date.now();
  sim("launch", udid, BUNDLE, "-AIWBScenario", scenario);
  return t;
}

/** Polls the results file; `onPhase(name, results)` is called once per phase as it appears. Resolves with the results when done. */
async function watch(onPhase, timeoutMs = 180000) {
  const t0 = Date.now(); let last = ""; let r = null;
  while (Date.now() - t0 < timeoutMs) {
    r = readResults();
    if (r && r.phase !== last) { last = r.phase; await onPhase(r.phase, r); }
    if (r?.done) return r;
    await sleep(120);
  }
  throw new Error(`timed out in phase ${last}`);
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ---- auto
const all = [];
if (!args.includes("--no-auto")) for (let run = 1; run <= runs; run++) {
  console.log(`\n=== auto run ${run}/${runs} ===`);
  const tLaunch = launch("auto");
  const mem = {};
  const r = await watch(async (phase) => {
    if (phase.startsWith("mem-")) { await sleep(2500); mem[phase] = memory(); }
    if (phase.startsWith("shot-")) { await sleep(1200); sim("io", udid, "screenshot", "--type=png", path.join(out, `${phase}.png`)); }
  });
  for (const f of ["export-small.png", "export-large.png"]) fs.copyFileSync(path.join(docs(), f), path.join(out, f));
  fs.writeFileSync(path.join(out, `results-auto-${run}.json`), JSON.stringify({ ...r, mem, tLaunch }, null, 1));
  all.push({ r, mem, tLaunch });
  execFileSync("node", [path.join(here, "show-results.mjs"), path.join(out, `results-auto-${run}.json`)], { stdio: "inherit" });
  for (const s of r.steps) if (!s.ok) fail(`${s.name}: ${s.error}`);
  if (r.extra.fatal) fail(`fatal: ${r.extra.fatal}`);
}

if (all.length) {
  const hits = fs.readFileSync(hitsFile, "utf8").trim();
  console.log(`\nprobe listener on 127.0.0.1:${PROBE_PORT}: ${hits ? "HIT\n" + hits : "0 requests (the page reached nothing)"}`);
  if (hits) fail("the page reached the probe listener");

  console.log("\n## Memory (MB; rss from `ps -o rss=`, footprint from `footprint`), per run median");
  console.log("| phase | WebContent rss | WebContent footprint | GPU rss | GPU footprint | Networking rss | app rss |");
  console.log("|---|---|---|---|---|---|---|");
  for (const phase of Object.keys(all[0].mem)) {
    const col = (kind, key) => median(all.map((a) => a.mem[phase]?.rows.filter((x) => x.kind === kind).reduce((s, x) => s + (x[key] ?? 0), 0)));
    console.log(`| ${phase} | ${col("WebContent", "rssMB")} | ${col("WebContent", "footprintMB")} | ${col("GPU", "rssMB")} | ${col("GPU", "footprintMB")} | ${col("Networking", "rssMB")} | ${col("app", "rssMB")} |`);
  }

  console.log("\n## Times (ms), per run");
  for (const [i, { r, tLaunch }] of all.entries()) {
    const at = r.at;
    console.log(`run ${i + 1}: launch -> app JS module ${at.appModule - tLaunch}; JS -> page ready ${at.pageReady - at.appModule} (page's own script ${r.extra.ready.loadMs}); `
      + `page load start -> end ${at.loadEnd - at.loadStart}; launch -> empty board loaded ${at["mem-empty"] - tLaunch}`);
    const step = (n) => r.steps.find((s) => s.name === n);
    console.log(`        loadScene empty ${step("loadScene empty").ms}, small ${step("loadScene small").ms}, 2000 elements ${r.extra.loadLarge.roundTripMs} (in the page ${r.extra.loadLarge.pageMs}); `
      + `scene of ${r.extra.largeSceneBytes} bytes sent; sceneChanged of the 2000 board came ${r.extra.sceneChangedLarge?.latencyMs} ms after the change, ${r.extra.sceneChangedLarge?.jsonChars} chars; `
      + `png of 2000: ${step("exportPng 2000 (scale 0.5)")?.ms}`);
  }
}

// ---- touch
if (!args.includes("--no-touch")) {
  console.log("\n=== touch ===");
  const tools = execFileSync(path.join(here, "get-maestro.sh"), { encoding: "utf8" }).trim().split("\n").pop();
  const [binDir, javaHome] = tools.split(":");
  const env = { ...process.env, PATH: `${binDir}:${javaHome ? javaHome + "/bin:" : ""}${process.env.PATH}`, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
  launch("touch");
  const done = watch(async (phase) => {
    if (phase !== "touch-ready") return;
    await sleep(1500);
    const m = spawnSync("maestro", ["--device", udid, "test", path.join(root, "flows/draw.yaml")], { env, encoding: "utf8", timeout: 240000 });
    fs.writeFileSync(path.join(out, "maestro.log"), `${m.stdout}\n${m.stderr}`);
    console.log(`maestro exit ${m.status}${m.status ? "\n" + (m.stdout + m.stderr).slice(-1500) : ""}`);
    if (m.status) fail("maestro flow failed");
    sim("io", udid, "screenshot", "--type=png", path.join(out, "touch-screen.png"));
  }, 400000);
  const r = await done;
  try { fs.copyFileSync(path.join(docs(), "touch.png"), path.join(out, "touch.png")); } catch { fail("no picture of the drawing"); }
  fs.writeFileSync(path.join(out, "results-touch.json"), JSON.stringify(r, null, 1));
  execFileSync("node", [path.join(here, "show-results.mjs"), path.join(out, "results-touch.json")], { stdio: "inherit" });
  for (const s of r.steps) if (!s.ok) fail(`${s.name}: ${s.error}`);
}

try { sim("terminate", udid, BUNDLE); } catch { /* done */ }
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
