// Prints the steps of a results.json (written by the app's driver). Usage: node scripts/show-results.mjs <results.json>
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(`scenario ${r.scenario}, phase ${r.phase}, done ${r.done}${r.extra.fatal ? `, FATAL ${r.extra.fatal}` : ""}`);
for (const s of r.steps) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name.padEnd(62)} ${String(s.ms).padStart(6)} ms  ${JSON.stringify(s.info ?? s.error ?? "").slice(0, 300)}`);
const { bridgeStats, page, ...rest } = r.extra;
console.log("bridge:", JSON.stringify(bridgeStats));
console.log("page:", JSON.stringify(page));
console.log("extra:", JSON.stringify(rest).slice(0, 2000));
console.log("at:", JSON.stringify(r.at));
