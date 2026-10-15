// What a flow does to the device itself, through the control API of the runner (lib/serverctl.mjs `add`; a Maestro script calls it with
// `_ctl.js`, as it calls the server's routes). Package V4. The routes, all answering JSON:
//
//   POST /device/library?names=a.png,b.jpg   puts the fixtures (lib/fixtures.mjs) into the device's photo library, one after the other
//                                            (iOS: `simctl addmedia`; Android: `adb push` and a media scan), the first one the oldest
//   POST /device/privacy?service=photos&action=grant|revoke|reset      the answer to a permission prompt (iOS: `simctl privacy`; Android: `pm grant|revoke`
//                                            of READ_MEDIA_IMAGES / CAMERA for `service=camera`)
//   POST /device/relaunch                    the app is stopped and opened again as the runner opens it (the development client's link)
//   GET  /device/storage                     what the app keeps on this device and whether the run's secret is in any of it: the files of the app's data
//                                            folder (iOS: the app's data container; Android: `run-as`), the MMKV ones named, `hits` the files that hold the secret
//   POST /device/qr                          the code of the scratch server, made by scripts/server-code.sh and read back from its picture (lib/servercode.mjs):
//                                            { text, lines: [the text's lines], same: the picture holds what the script drew, drawn: lines of the script's drawing }
//   POST /device/sleep?ms=N                  waits (a flow needs a pause now and then that Maestro has no word for)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { adbPath } from "../../scripts/lib/devtools.mjs";
import { makeServerCode } from "./servercode.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The routes for `device`. fixtures: what lib/fixtures.mjs made; open(): opens the development build again (the runner's own way). */
export function deviceRoutes({ platform, device, appId, server, out, fixtures, terminate, open, say = () => {} }) {
  const secret = server.secret;
  const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
    if (r.status !== 0 && !opts.soft) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r;
  };
  const adb = (args, opts) => run(adbPath(), ["-s", device, ...args], opts);
  const need = (q, name) => { const v = q.get(name); if (!v) throw new Error(`?${name}= is needed`); return v; };

  const library = async (q) => {
    const names = need(q, "names").split(",");
    for (const name of names) {
      const f = fixtures[name];
      if (!f) throw new Error(`no fixture ${name}`);
      if (platform === "ios") run("xcrun", ["simctl", "addmedia", device, f.path]);
      else {
        const dest = `/sdcard/Pictures/${name}`;
        const now = new Date();
        fs.utimesSync(f.path, now, now); // (the picker sorts by the file's date, and `adb push` keeps it: each picture is made as new as it is put there)
        adb(["push", f.path, dest]);
        adb(["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${dest}`], { soft: true });
      }
      say(`library: added ${name}`);
      await sleep(1100); // (the library sorts by date: one second apart keeps the order the flow expects)
    }
    return { added: names };
  };

  const privacy = async (q) => {
    const service = need(q, "service");
    const action = need(q, "action");
    if (platform === "ios") {
      run("xcrun", ["simctl", "privacy", device, action, service, appId]);
    } else {
      const permission = { photos: "android.permission.READ_MEDIA_IMAGES", camera: "android.permission.CAMERA" }[service];
      if (!permission) throw new Error(`no service ${service} on Android`);
      // (soft: an app that does not ask for the permission, as this one does not ask for the photos', has nothing to grant or revoke: the answer says so)
      // (a permission refused twice is refused for good, "user-fixed", and revoking it does not make it askable again: the flags are cleared first)
      if (action !== "grant") {
        adb(["shell", "pm", "clear-permission-flags", appId, permission, "user-set", "user-fixed"], { soft: true });
        // (the app's own permissions module also remembers that a permission was asked, and with no rationale to show it then says the question cannot be asked again:
        //  that note is deleted, with the app stopped, so that the state is the one of an app that never asked)
        adb(["shell", "am", "force-stop", appId], { soft: true });
        adb(["shell", "run-as", appId, "rm", "-f", "shared_prefs/expo.modules.permissions.asked.xml"], { soft: true });
      }
      const r = adb(["shell", "pm", action === "grant" ? "grant" : "revoke", appId, permission], { soft: true }); // (reset: the same as revoke, once the flags are cleared)
      return { asked: r.status === 0, note: (r.stderr || r.stdout).trim().split("\n")[0] };
    }
    return {};
  };

  const relaunch = async () => {
    terminate();
    await sleep(800);
    open();
    return {};
  };

  // ---- the app's own files
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p);
    }
    return out;
  };
  let storageCalls = 0;
  const storage = async (q) => {
    let files; // [{ path, size, hit, found }]
    const needle = Buffer.from(secret, "utf8");
    const find = q.get("find") || ""; // a text that must be found, to show that the search reads what the app wrote (MMKV holds the server's address)
    if (platform === "ios") {
      const root = run("xcrun", ["simctl", "get_app_container", device, appId, "data"]).stdout.trim();
      files = walk(root).map((p) => { const b = fs.readFileSync(p); return { path: path.relative(root, p), size: b.length, hit: b.includes(needle), found: !!find && b.includes(Buffer.from(find, "utf8")) }; });
    } else {
      const sh = (script) => adb(["shell", "run-as", appId, "sh", "-c", `'${script}'`], { soft: true });
      const listed = sh("cd /data/data/" + appId + " && find . -type f").stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!listed.length) throw new Error(`run-as ${appId} lists nothing: is this a debuggable build?`);
      const hits = new Set(sh(`cd /data/data/${appId} && grep -rlF '${secret}' . 2>/dev/null`).stdout.split("\n").map((l) => l.trim()).filter(Boolean));
      const foundIn = new Set(find ? sh(`cd /data/data/${appId} && grep -rlF '${find}' . 2>/dev/null`).stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
      files = listed.map((p) => ({ path: p.replace(/^\.\//, ""), size: Number(sh(`wc -c < /data/data/${appId}/${p}`).stdout.trim() || 0), hit: hits.has(p), found: foundIn.has(p) }));
    }
    const mmkv = files.filter((f) => /mmkv/i.test(f.path) && !/\.crc$/.test(f.path));
    const answer = { files: files.length, mmkv: mmkv.map((f) => ({ path: f.path, size: f.size, hasSecret: f.hit })), hits: files.filter((f) => f.hit).map((f) => f.path), found: files.filter((f) => f.found).map((f) => f.path), listing: files.map((f) => `${f.size}\t${f.path}`) };
    fs.writeFileSync(path.join(out, `storage-${++storageCalls}.json`), JSON.stringify({ ...answer, find }, null, 1) + "\n");
    return answer;
  };

  const qr = async () => {
    const setup = `Remote access is set up.\n\nAddresses:\n  https://${server.host}:${server.port}\n\nFingerprint: ${server.fingerprint}\nSecret: ${server.secret}\n`;
    const made = makeServerCode({ dir: path.join(out, "qr"), setup });
    return { text: made.text, lines: made.text.split("\n").filter(Boolean), same: made.text === made.recorded, drawn: made.drawing.split("\n").length, png: made.png };
  };

  return {
    "POST /device/qr": qr,
    "POST /device/library": library,
    "POST /device/privacy": privacy,
    "POST /device/relaunch": relaunch,
    "GET /device/storage": storage,
    "POST /device/sleep": async (q) => { await sleep(Number(q.get("ms") || 1000)); return {}; },
  };
}
