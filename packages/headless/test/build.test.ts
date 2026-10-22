// The build's own checks of its arguments: a target it does not build is refused with a message, before anything is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build.mjs");

function run(...args: string[]) {
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aiwb-headless-args-"));
  try {
    const r = spawnSync(process.execPath, [build, "--out", path.join(out, "dist"), ...args], { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stderr: r.stderr, wrote: fs.existsSync(path.join(out, "dist")) };
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

test("build.mjs refuses an os that is not darwin, linux or win32, and an architecture that is not arm64 or x64", () => {
  for (const [o, a] of [["freebsd", "x64"], ["windows", "x64"], ["darwin", "amd64"], ["win32", "ia32"]]) {
    const r = run("--os", o, "--arch", a);
    assert.notEqual(r.status, 0, `${o}/${a}`);
    assert.match(r.stderr, new RegExp(`not a target: ${o}/${a}`));
    assert.equal(r.wrote, false);
  }
});
