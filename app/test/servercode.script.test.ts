// scripts/server-code.sh (S12, goal 4.7): draws the code a phone scans, with `qrencode`, from the output of setup-remote.sh (piped, or run by the
// script with a stand-in server program that prints the fixtures); says how to get `qrencode` when it is missing; refuses an output without
// the secret; keeps the secret out of every file and every argument. `qrencode` is a stand-in that keeps what it is handed on its standard
// input in a file of the test's own, so that the text of the code can be read back by the app's parser (packages/core/src/logic/servercode.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseServerCode, codeText } from "@aiwb/core/logic/servercode.ts";

const FIX = new URL("../../packages/core/test/fixtures/remote-setup/", import.meta.url).pathname;
const SCRIPT = new URL("../../scripts/server-code.sh", import.meta.url).pathname;
const SETUP = new URL("../../scripts/remote/setup-remote.sh", import.meta.url).pathname;
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const SECRET = fixture("secret-line.txt").trim();

/** A folder of the commands the script uses (sed, head, grep, cat, dirname, sh) and nothing else: `qrencode` is there only when asked. */
function rig(qrencode: boolean) {
  const root = mkdtempSync(join(tmpdir(), "aiwb-servercode-"));
  const bin = join(root, "bin"), work = join(root, "work"), out = join(root, "stub-out.txt");
  for (const d of [bin, work]) spawnSync("mkdir", ["-p", d]);
  for (const cmd of ["sed", "head", "grep", "cat", "dirname", "sh", "uname", "tr"]) {
    const p = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
    if (p) symlinkSync(p, join(bin, cmd));
  }
  if (qrencode) {
    writeFileSync(join(bin, "qrencode"), `#!/bin/sh\necho "$@" > "${out}.args"\ncat > "${out}"\necho "[a QR code]"\n`);
    chmodSync(join(bin, "qrencode"), 0o755);
  }
  // A server program that prints what the real one printed (fixtures), for the script that runs setup-remote.sh.
  const server = join(root, "ai-whiteboard");
  writeFileSync(server, `#!/bin/sh\ncase "$1" in\n  remote) cat "${FIX}remote-setup-raw.txt" ;;\n  secret) cat "${FIX}secret-line.txt" ;;\nesac\n`);
  chmodSync(server, 0o755);
  const run = (args: string[], input?: string) => spawnSync(join(bin, "sh"), [SCRIPT, ...args], {
    cwd: work, input, encoding: "utf8", env: Object.assign(Object.create(null), { PATH: bin, HOME: root, TMPDIR: root, AIWB_SERVER_BIN: server }),
  });
  return { root, work, out, run, files: () => readdirSync(root).sort() };
}

test("piped: the code is the text the app reads, qrencode is handed it on its standard input and not in an argument", () => {
  const r = rig(true);
  const done = r.run(["-"], fixture("setup-remote-default.txt"));
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /\[a QR code\]/);
  const text = readFileSync(r.out, "utf8");
  const read = parseServerCode(text);
  assert.ok(read.ok && read.code.secret === SECRET);
  assert.deepEqual(read, parseServerCode(fixture("setup-remote-default.txt")), "the code says what the whole output says");
  assert.equal(text, codeText(read.code));
  assert.ok(text.length < 600, `${text.length} characters`);
  assert.ok(!readFileSync(`${r.out}.args`, "utf8").includes(SECRET), "the secret is in qrencode's arguments");
  assert.ok(!done.stdout.includes(SECRET) && !done.stderr.includes(SECRET), "the secret is printed in words");
  assert.match(done.stderr, /Scan code/);
  assert.ok(done.stderr.includes("E6:45:B0:35:48:5E"), "the fingerprint is told to compare");
});

test("run without a pipe: it runs setup-remote.sh itself, from beside the script (the scripts/remote folder)", () => {
  assert.ok(existsSync(SETUP));
  const r = rig(true);
  const done = r.run([]);
  assert.equal(done.status, 0, done.stderr);
  const read = parseServerCode(readFileSync(r.out, "utf8"));
  assert.ok(read.ok);
  assert.equal(read.code.secret, SECRET);
  assert.deepEqual(read.code.addresses, ["https://mac.example.net:4790", "https://192.168.0.20:4790", "https://10.0.0.5:4790"]);
});

test("--address puts the chosen addresses in the code; one that is none of the server's is refused, and no code is drawn", () => {
  const r = rig(true);
  const done = r.run(["--address", "https://192.168.0.20:4790/", "-"], fixture("setup-remote-default.txt"));
  assert.equal(done.status, 0, done.stderr);
  const read = parseServerCode(readFileSync(r.out, "utf8"));
  assert.ok(read.ok);
  assert.deepEqual(read.code.addresses, ["https://192.168.0.20:4790"]);
  const bad = rig(true).run(["--address=https://evil.example:1", "-"], fixture("setup-remote-default.txt"));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not one of this server's addresses/);
  assert.ok(!bad.stdout.includes("[a QR code]"));
});

test("without qrencode it says how to get it, draws nothing and prints nothing of the secret", () => {
  const r = rig(false);
  const done = r.run(["-"], fixture("setup-remote-default.txt"));
  assert.equal(done.status, 1);
  assert.match(done.stderr, /qrencode is not installed/);
  assert.match(done.stderr, /brew install qrencode/);
  assert.match(done.stderr, /apt install qrencode/);
  assert.match(done.stderr, /paste the output of setup-remote\.sh/);
  assert.equal(done.stdout, "");
  assert.ok(!done.stderr.includes(SECRET) && !done.stdout.includes(SECRET));
});

test("an output without the secret, or with no address, is refused", () => {
  const r = rig(true);
  const raw = r.run(["-"], fixture("remote-setup-raw.txt"));
  assert.equal(raw.status, 1);
  assert.match(raw.stderr, /no address or no secret/);
  assert.equal(r.run(["-"], "hello").status, 1);
  assert.ok(!existsSync(r.out), "a code was drawn for nothing");
  assert.equal(r.run(["--bogus"]).status, 2);
  assert.equal(r.run(["--home"]).status, 2);
});

test("the secret is written to no file: the rig's folder and the working folder hold what they held", () => {
  const r = rig(true);
  const before = r.files();
  const done = r.run(["-"], fixture("setup-remote-names.txt"));
  assert.equal(done.status, 0, done.stderr);
  // Only the stand-in's own record of what it was handed (and of its arguments) is new, and the working folder is empty.
  assert.deepEqual(r.files().filter((f) => !before.includes(f)), ["stub-out.txt", "stub-out.txt.args"]);
  assert.deepEqual(readdirSync(r.work), []);
  const script = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(script, /mktemp|tee |> *[^&\s/]|>> *[^&\s]/, "the script writes to a file or a temporary file");
});
