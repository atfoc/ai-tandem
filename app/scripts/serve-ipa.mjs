#!/usr/bin/env node
// Serves a signed .ipa over https on the local network, so that an iPhone or iPad installs it by opening a link in Safari
// (over the air, no cable, no store).
//
//   node app/scripts/serve-ipa.mjs [--ipa <file.ipa>] [--port <n>]
//   scripts/install-app-device.sh --platform ios --serve        builds the .ipa first, then does this
//
//   --ipa    the file (default: the newest .ipa in bin/ios, made by `install.mjs --platform ios --ipa`).
//   --port   the https port (default 8443); a plain-http page with the certificate to trust is on port+1.
//
// iOS installs over the air only from https with a certificate the device trusts. The device trusts a certificate authority of this
// computer once (the plain-http page walks through it); see lib/lan-cert.mjs. openssl comes with macOS.
// Every path carries a random token, and only this .ipa, its manifest and the page are served. The .ipa installs only on devices
// registered with its provisioning profile. Stop with Ctrl-C: the link stops working.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lanAddresses, lanCertificate } from "./lib/lan-cert.mjs";
import { installPage, manifestPlist, parseServeArgs, routes, trustPage } from "./lib/serve-core.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Name, bundle id and version, read from the Info.plist inside the .ipa. */
export function ipaInfo(ipa) {
  const list = spawnSync("unzip", ["-Z1", ipa], { encoding: "utf8" });
  const entry = list.stdout?.split("\n").find((f) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(f));
  if (list.status !== 0 || !entry) throw new Error(`${ipa} is not an .ipa (no Payload/*.app/Info.plist)`);
  const raw = spawnSync("unzip", ["-p", ipa, entry], { maxBuffer: 1 << 24 });
  const json = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: raw.stdout, encoding: "utf8" });
  const p = JSON.parse(json.stdout);
  return { title: p.CFBundleDisplayName || p.CFBundleName || "App", bundleId: p.CFBundleIdentifier, version: p.CFBundleShortVersionString || p.CFBundleVersion || "0" };
}

function newestIpa() {
  const dir = path.join(repoDir, "bin/ios");
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".ipa")).map((f) => path.join(dir, f)) : [];
  all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!all[0]) throw new Error(`no .ipa in ${dir}: build one with  node app/scripts/install.mjs --platform ios --ipa`);
  return all[0];
}

/** The handler: the page, the manifest and the .ipa under /<token>/. `base(req)` is the public address. `tls` makes it https (the tests use http). */
export function createServer({ ipa, info, token, base, tls = null, log = () => {} }) {
  const r = routes(token);
  const make = tls ? (h) => https.createServer(tls, h) : http.createServer;
  return make((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    res.on("finish", () => log(`${req.socket.remoteAddress} ${req.method} ${url.replace(token, "<token>")} -> ${res.statusCode}`));
    res.on("close", () => { if (!res.writableFinished) log(`${req.socket.remoteAddress} ${req.method} ${url.replace(token, "<token>")} -> cut off after ${req.socket.bytesWritten} bytes`); });
    const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed");
    if (url === r.page) return send(200, "text/html; charset=utf-8", installPage({ manifestUrl: base(req) + r.manifest, ...info }));
    if (url === r.manifest) return send(200, "text/xml", manifestPlist({ ipaUrl: base(req) + r.ipa, ...info }));
    if (url === r.ipa) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(ipa).size, "cache-control": "no-store" });
      return req.method === "HEAD" ? res.end() : fs.createReadStream(ipa).pipe(res);
    }
    send(404, "text/plain", "not found");
  });
}

/** Serves `ipa` until the process is stopped: https on every address of this computer, and on port+1 a plain-http page with the certificate to trust. Rejects when it cannot start. */
export async function serveIpa({ ipa, port = 0, say = console.log }) {
  ipa = path.resolve(ipa || newestIpa());
  const info = ipaInfo(ipa);
  const token = crypto.randomBytes(16).toString("hex");
  say(`serving ${path.basename(ipa)} (${info.title} ${info.version}, ${info.bundleId}, ${(fs.statSync(ipa).size / 1e6).toFixed(1)} MB)`);
  const addresses = lanAddresses(os.networkInterfaces());
  if (!addresses.length) throw new Error("this computer has no network address other computers can reach (no Wi-Fi, cable or VPN)");
  const cert = lanCertificate({ addresses: addresses.map((a) => a.address) });
  const httpsPort = port || 8443;
  const server = createServer({ ipa, info, token, base: (req) => `https://${req.headers.host}`, tls: { key: cert.key, cert: cert.cert }, log: say });
  server.on("tlsClientError", (e, socket) => say(`${socket.remoteAddress} TLS: ${e.message} (the device does not trust the certificate yet?)`));
  const trust = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    say(`${req.socket.remoteAddress} ${req.method} ${url} (trust page)`);
    if (url === "/ca.cer") { res.writeHead(200, { "content-type": "application/x-x509-ca-cert", "content-disposition": 'attachment; filename="aiwb-local-ca.cer"' }); return res.end(cert.caDer); }
    if (url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(trustPage(info)); }
    res.writeHead(404); res.end();
  });
  for (const [s, p] of [[server, httpsPort], [trust, httpsPort + 1]]) {
    await new Promise((resolve, reject) => { s.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${p} is in use: choose another with --port`) : e)); s.listen(p, "0.0.0.0", resolve); });
  }
  const stop = () => { server.close(); trust.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  say(`${cert.caCreated ? "Made this computer's certificate authority (~/.aiwb-install/ca; limited to private network addresses). " : ""}Addresses of this computer:`);
  for (const a of addresses) say(`  ${a.address}  (${a.name})`);
  say("");
  say("1. Once per device, if it does not trust this computer yet: open in Safari on the device, and follow the steps:");
  for (const a of addresses) say(`     http://${a.address}:${httpsPort + 1}/`);
  say("2. Then open, in Safari on the device, and tap Install:");
  for (const a of addresses) say(`     https://${a.address}:${httpsPort}${routes(token).page}`);
  say("   (use the address your device can reach: the one on the network or VPN you share with it)");
  say("");
  say("The first time iOS may say \"Untrusted Developer\": Settings > General > VPN & Device Management > your Apple Development entry > Trust.");
  say("Ctrl-C stops the server and the link. The certificate covers the addresses above; if the address changes, run again.");
  await new Promise(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseServeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
  }
  if (args.errors.length) { console.error(`${args.errors.join("\n")}\nusage: node app/scripts/serve-ipa.mjs [--ipa <file>] [--port <n>]`); process.exit(2); }
  try { await serveIpa(args); } catch (e) { console.error(`STOPPED: ${e.message}`); process.exit(1); }
}
