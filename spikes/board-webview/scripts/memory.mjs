// Memory of the processes the simulated device runs for the app: its own process and WebKit's WebContent (the page),
// GPU (where the canvas pictures live) and Networking processes. The simulator's processes are processes of the Mac:
// they are the children of the device's launchd_sim, which is found by the device's UDID. `ps -o rss=` (resident, KB) as
// asked, and `footprint` (the physical footprint iOS counts a process by, MB) beside it.
// Usage: node scripts/memory.mjs <udid>   -> JSON on stdout
import { execFileSync } from "node:child_process";

const udid = process.argv[2];
if (!udid) { console.error("usage: node memory.mjs <udid>"); process.exit(2); }
const ps = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean).map((l) => {
  const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  return m && { pid: +m[1], ppid: +m[2], rssKB: +m[3], cmd: m[4] };
}).filter(Boolean);
const launchd = ps.filter((p) => p.cmd.includes("launchd_sim") && p.cmd.includes(udid)).map((p) => p.pid);
const mine = ps.filter((p) => launchd.includes(p.ppid));
const kinds = [["WebContent", /com\.apple\.WebKit\.WebContent/], ["GPU", /com\.apple\.WebKit\.GPU/], ["Networking", /com\.apple\.WebKit\.Networking/], ["app", /\/BoardSpike\.app\/BoardSpike/]];
const footprint = (pid) => {
  try {
    const out = execFileSync("footprint", ["-p", String(pid), "--noCategories"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i) ?? out.match(/phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/i);
    if (!m) return null;
    return +m[1] * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()]);
  } catch { return null; }
};
const rows = [];
for (const p of mine) {
  const k = kinds.find(([, re]) => re.test(p.cmd));
  if (k) rows.push({ kind: k[0], pid: p.pid, rssMB: +(p.rssKB / 1024).toFixed(1), footprintMB: (() => { const f = footprint(p.pid); return f == null ? null : +f.toFixed(1); })() });
}
console.log(JSON.stringify({ at: Date.now(), launchd, rows }));
