import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// app/e2e/get-maestro.sh against a local server that serves a fake Maestro and a fake JRE: it fetches once, a second run
// fetches nothing, and a download whose sha256 is not the pinned one is refused and leaves nothing behind. (The real pins
// are checked by running the script for real; app/e2e/README.md says how.)

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../e2e/get-maestro.sh");
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A maestro.zip and a JRE archive, the latter under every file name the script asks for (one per platform). */
function fixtures(dir: string) {
  const m = path.join(dir, "m/maestro/bin");
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(path.join(m, "maestro"), "#!/bin/sh\necho fake maestro\n", { mode: 0o755 });
  execFileSync("zip", ["-qr", path.join(dir, "maestro.zip"), "maestro"], { cwd: path.join(dir, "m") });
  const j = path.join(dir, "j/jdk-fake/bin");
  fs.mkdirSync(j, { recursive: true });
  fs.writeFileSync(path.join(j, "java"), "#!/bin/sh\necho 'fake java 17' >&2\n", { mode: 0o755 });
  const jre = path.join(dir, "jre.tar.gz");
  execFileSync("tar", ["-czf", jre, "-C", path.join(dir, "j"), "jdk-fake"]);
  for (const p of ["aarch64_mac", "x64_mac", "aarch64_linux", "x64_linux"]) fs.copyFileSync(jre, path.join(dir, `OpenJDK17U-jre_${p}_hotspot_17.0.20.1_1.tar.gz`));
  return { maestro: sha(path.join(dir, "maestro.zip")), jre: sha(jre) };
}

async function serve(dir: string) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const file = path.join(dir, path.basename(req.url ?? ""));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { hits, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

// Asynchronous: the server that answers the script's downloads runs in this process.
function run(tools: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn("sh", [script], { env: { ...process.env, AIWB_E2E_TOOLS: tools, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("get-maestro.sh: fetches once, a second run fetches nothing, a changed checksum is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-getmaestro-"));
  const server = await serve(dir);
  try {
    const sums = fixtures(dir);
    const env = { MAESTRO_BASE_URL: server.base, JRE_BASE_URL: server.base, MAESTRO_SHA256: sums.maestro, JRE_SHA256: sums.jre };

    const tools = path.join(dir, "tools");
    const first = await run(tools, env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(server.hits.length, 2, "the first run fetches Maestro and the JRE");
    assert.ok(fs.existsSync(path.join(tools, "maestro/maestro/bin/maestro")));
    assert.ok(fs.existsSync(path.join(tools, "java-home/bin/java")));

    const second = await run(tools, env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(server.hits.length, 2, "the second run fetches nothing");
    assert.match(second.stdout, /nothing to fetch/);

    // A download that is not what the script pins is refused, and a folder that was empty stays empty.
    const bad = path.join(dir, "bad-tools");
    const wrong = await run(bad, { ...env, MAESTRO_SHA256: "0".repeat(64) });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /not used/);
    const wrongJre = await run(bad, { ...env, JRE_SHA256: "f".repeat(64) });
    assert.equal(wrongJre.status, 1);
    assert.match(wrongJre.stderr, /not used/);
    assert.ok(!fs.existsSync(bad), "nothing was put in the tools folder");

    // A pin that differs from the one the tools were fetched with fetches again and compares; it does not trust what is there.
    const before = server.hits.length;
    const changed = await run(tools, { ...env, MAESTRO_SHA256: "1".repeat(64) });
    assert.equal(changed.status, 1);
    assert.ok(server.hits.length > before);
    assert.ok(fs.existsSync(path.join(tools, "maestro/maestro/bin/maestro")), "the tools that were there are kept when the new download is refused");
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
