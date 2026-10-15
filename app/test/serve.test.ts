import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as core from "../scripts/lib/serve-core.mjs";
import * as lan from "../scripts/lib/lan-cert.mjs";
import * as serve from "../scripts/serve-ipa.mjs";

const { installLink, manifestPlist, parseServeArgs, routes } = core;
const { createServer, ipaInfo } = serve as any;
const { lanAddresses, lanCertificate, serverExtensions } = lan as any;

// The .ipa server (--serve): the manifest and the page iOS needs, and a real server over a small .ipa made here.

test("the manifest names the https address of the .ipa, the bundle id and the version, and escapes what it is given", () => {
  const m = manifestPlist({ ipaUrl: "https://x.example/t/app.ipa?a=1&b=2", bundleId: "local.aiwhiteboard.app", version: "1.0.0", title: "A <B>" });
  assert.match(m, /<key>url<\/key><string>https:\/\/x\.example\/t\/app\.ipa\?a=1&amp;b=2<\/string>/);
  assert.match(m, /<key>bundle-identifier<\/key><string>local\.aiwhiteboard\.app<\/string>/);
  assert.match(m, /<string>A &lt;B&gt;<\/string>/);
  assert.equal(installLink("https://x.example/t/manifest.plist"), "itms-services://?action=download-manifest&url=https%3A%2F%2Fx.example%2Ft%2Fmanifest.plist");
});

test("the arguments of the server are checked", () => {
  assert.deepEqual(parseServeArgs(["--ipa", "a.ipa", "--port", "8080"]).errors, []);
  assert.match(parseServeArgs(["--url", "https://a.example"]).errors.join(), /unknown argument --url/);
  assert.match(parseServeArgs(["--port"]).errors.join(), /--port needs a value/);
  assert.match(parseServeArgs(["--port", "x"]).errors.join(), /port number/);
  assert.match(parseServeArgs(["--what"]).errors.join(), /unknown argument --what/);
});

test("the server serves the page, the manifest and the .ipa under the token, and nothing else", { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-serve-"));
  const app = path.join(dir, "Payload/Demo.app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Demo</string><key>CFBundleIdentifier</key><string>com.example.demo</string><key>CFBundleShortVersionString</key><string>2.3.4</string></dict></plist>`);
  const ipa = path.join(dir, "demo.ipa");
  assert.equal(spawnSync("zip", ["-qr", ipa, "Payload"], { cwd: dir }).status, 0);
  const info = ipaInfo(ipa);
  assert.deepEqual(info, { title: "Demo", bundleId: "com.example.demo", version: "2.3.4" });
  assert.throws(() => ipaInfo(path.join(dir, "missing.ipa")), /not an \.ipa/);

  const token = "tok123";
  const server = createServer({ ipa, info, token, base: () => "https://pub.example" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const r = routes(token);
  try {
    const page = await fetch(root + r.page);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /itms-services:\/\/\?action=download-manifest&amp;url=https%3A%2F%2Fpub\.example%2Ftok123%2Fmanifest\.plist/);
    const manifest = await fetch(root + r.manifest);
    assert.match(manifest.headers.get("content-type") ?? "", /xml/);
    assert.match(await manifest.text(), /https:\/\/pub\.example\/tok123\/app\.ipa/);
    const file = await fetch(root + r.ipa);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), fs.readFileSync(ipa));
    for (const bad of ["/", "/other/", `/${token}/../etc/passwd`, `/${token}/x`]) assert.equal((await fetch(root + bad)).status, 404, bad);
    assert.equal((await fetch(root + r.ipa, { method: "POST" })).status, 405);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--serve implies --ipa", async () => {
  const { parseArgs } = await import("../scripts/lib/install-core.mjs");
  const a = parseArgs(["--platform", "ios", "--serve"]);
  assert.deepEqual([a.errors, a.ipa, a.serve], [[], true, true]);
});

test("the addresses other computers reach are taken from the interfaces", () => {
  assert.deepEqual(lanAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "10.0.0.5", family: "IPv4", internal: false }],
    utun4: [{ address: "10.9.9.9", family: 4, internal: false }],
  }), [{ name: "en0", address: "10.0.0.5" }, { name: "utun4", address: "10.9.9.9" }]);
});

test("the certificate chains to the computer's authority, which can sign for private addresses only", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-ca-"));
  try {
    const first = lanCertificate({ addresses: ["10.1.2.3", "192.168.1.9"], dir });
    assert.equal(first.caCreated, true);
    assert.equal(lanCertificate({ addresses: ["10.1.2.3"], dir }).caCreated, false, "the authority is made once, so a device trusts it once");
    fs.writeFileSync(path.join(dir, "chain.pem"), first.cert);
    const verify = (f: string) => spawnSync("openssl", ["verify", "-CAfile", path.join(dir, "ca.pem"), f], { encoding: "utf8" });
    assert.equal(verify(path.join(dir, "chain.pem")).status, 0);
    assert.ok(first.caDer.length > 200);
    assert.match(spawnSync("openssl", ["x509", "-in", path.join(dir, "ca.pem"), "-noout", "-subject"], { encoding: "utf8" }).stdout, /AI Whiteboard local CA/, "the name the device shows");
    // a certificate for a public address, signed by the same authority, is refused by the name constraints
    fs.writeFileSync(path.join(dir, "bad.ext"), serverExtensions(["8.8.8.8"]));
    const sh = (a: string[]) => assert.equal(spawnSync("openssl", a, { cwd: dir, encoding: "utf8" }).status, 0, a.join(" "));
    sh(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "bad.key"]);
    sh(["req", "-new", "-key", "bad.key", "-subj", "/CN=bad", "-out", "bad.csr"]);
    sh(["x509", "-req", "-in", "bad.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAserial", "ca.srl", "-extfile", "bad.ext", "-out", "bad.pem"]);
    const bad = verify(path.join(dir, "bad.pem"));
    assert.notEqual(bad.status === 0 && !/error/.test(bad.stdout + bad.stderr), true, bad.stdout + bad.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
