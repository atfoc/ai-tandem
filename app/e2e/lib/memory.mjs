// The memory of the processes a device runs for the app, read from outside (flow board-webview, package B5): the app's own process
// and the web view's. Usage: node memory.mjs --platform ios|android --device <udid|serial> --app <bundle id|package>   -> JSON on stdout
// (also `measure({platform, device, app})` for the runner).
//   ios      the simulator's processes are processes of the Mac, the children of the device's `launchd_sim` (found by the device's
//            UDID). rss is `ps -o rss=`; footprint is `footprint -p` (the physical footprint, what iOS counts a process by).
//            WebContent is WebKit's page process (the JavaScript and the DOM of the board), GPU the one where the canvas pictures
//            live, Networking the system's one for the app.
//   android  `dumpsys meminfo` (PSS per process) and `ps` (rss). The WebView's renderer is a process of its own
//            (`...sandboxed_process0...`), the GPU thread is in the app's process or a `privileged_process`.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mb = (kb) => +(kb / 1024).toFixed(1);

function iosRows(udid, app) {
  const ps = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], rssKB: +m[3], cmd: m[4] };
  }).filter(Boolean);
  const launchd = ps.filter((p) => p.cmd.includes("launchd_sim") && p.cmd.includes(udid)).map((p) => p.pid);
  const mine = ps.filter((p) => launchd.includes(p.ppid));
  let appDir = "";
  try { appDir = execFileSync("xcrun", ["simctl", "get_app_container", udid, app, "app"], { encoding: "utf8" }).trim(); } catch { /* not installed */ }
  const kinds = [["WebContent", /com\.apple\.WebKit\.WebContent/], ["GPU", /com\.apple\.WebKit\.GPU/], ["Networking", /com\.apple\.WebKit\.Networking/], ["app", appDir ? new RegExp(appDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/") : /^$/]];
  const footprint = (pid) => {
    try {
      const out = execFileSync("footprint", ["-p", String(pid), "--noCategories"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i) ?? out.match(/phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/i);
      return m ? +m[1] * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()]) : null;
    } catch { return null; }
  };
  const rows = [];
  for (const p of mine) {
    const k = kinds.find(([, re]) => re.test(p.cmd));
    if (k) { const f = footprint(p.pid); rows.push({ kind: k[0], pid: p.pid, rssMB: mb(p.rssKB), footprintMB: f == null ? null : +f.toFixed(1) }); }
  }
  return rows;
}

function androidRows(serial, pkg) {
  const home = process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk");
  const adb = (...a) => execFileSync(path.join(home, "platform-tools/adb"), ["-s", serial, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rss = new Map();
  for (const l of adb("shell", "ps", "-A", "-o", "PID,RSS,NAME").split("\n").slice(1)) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rss.set(+m[1], { rssKB: +m[2], name: m[3] });
  }
  const rows = [];
  // dumpsys meminfo lists every process in six sections ("Total RSS by process", "... by OOM adjustment", "... by category", then the same
  // three for PSS): only "Total PSS by process" is read, or the rss list would be taken for PSS.
  let inPss = false;
  for (const l of adb("shell", "dumpsys", "meminfo").split("\n")) {
    if (/^Total \w+ by /.test(l)) { inPss = /^Total PSS by process:/.test(l); continue; }
    if (!inPss) continue;
    const m = l.match(/^\s*([\d,]+)K:\s+(\S+)\s+\(pid (\d+)/);
    if (!m) continue;
    const name = m[2];
    if (!(name === pkg || name.startsWith(pkg + ":") || /sandboxed_process|privileged_process|webview|chromium/i.test(name))) continue;
    const pid = +m[3];
    const kind = name === pkg ? "app" : /sandboxed_process/i.test(name) ? "renderer" : /privileged_process/i.test(name) ? "gpu" : "webview";
    rows.push({ kind, pid, name, pssMB: mb(+m[1].replace(/,/g, "")), rssMB: rss.has(pid) ? mb(rss.get(pid).rssKB) : null });
  }
  return rows;
}

export function measure({ platform, device, app }) {
  const rows = platform === "ios" ? iosRows(device, app) : androidRows(device, app);
  return { at: Date.now(), platform, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : ""; };
  const platform = opt("--platform"), device = opt("--device"), app = opt("--app");
  if (!["ios", "android"].includes(platform) || !device || !app) { console.error("usage: node memory.mjs --platform ios|android --device <udid|serial> --app <bundle id|package>"); process.exit(2); }
  console.log(JSON.stringify(measure({ platform, device, app })));
}
