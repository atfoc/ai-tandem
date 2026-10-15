// The code of a server, made by the script a person runs (scripts/server-code.sh) and read back from its picture (package V4). The script draws with
// `qrencode`, which a stand-in in front of it wraps: the stand-in keeps the text the script feeds it, lets the real `qrencode` draw what the script asked
// for (the script's own output is the drawing) and writes the same text as a PNG as well, which is what a phone's camera would be shown. The PNG is
// read with lib/qrdecode.swift (CoreImage): what comes out is what the app's scanner hands to the flow that fills the form. Needs `qrencode`
// (`brew install qrencode`) and `swift`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

/** setup: what setup-remote.sh would have printed (addresses one to a line, "Fingerprint:", "Secret:"). Writes qr.png, qr-text.txt and qr-drawing.txt into `dir`.
 *  Answers { text (read from the picture), recorded (what the script fed qrencode), drawing (the script's own output), png }. */
export function makeServerCode({ dir, setup }) {
  fs.mkdirSync(dir, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v qrencode"], { encoding: "utf8" }).stdout.trim();
  if (!real) throw new Error("qrencode is not installed: brew install qrencode");
  const stub = path.join(dir, "bin");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "qrencode"), `#!/bin/sh
cat > "${dir}/qr-text.txt"
"${real}" "$@" < "${dir}/qr-text.txt"
"${real}" -t PNG -l L -m 4 -s 10 -o "${dir}/qr.png" < "${dir}/qr-text.txt"
`, { mode: 0o755 });
  const r = spawnSync("sh", [path.join(repo, "scripts/server-code.sh"), "-"], { input: setup, encoding: "utf8", env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
  if (r.status !== 0) throw new Error(`server-code.sh failed (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  fs.writeFileSync(path.join(dir, "qr-drawing.txt"), r.stdout);
  const text = execFileSync("swift", [path.join(here, "qrdecode.swift"), path.join(dir, "qr.png")], { encoding: "utf8" });
  return { text, recorded: fs.readFileSync(path.join(dir, "qr-text.txt"), "utf8"), drawing: r.stdout, png: path.join(dir, "qr.png") };
}
