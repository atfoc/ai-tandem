// The things a device flow talks to, started on this computer and stopped at the end (architecture AD-83): a scratch Go server (a
// real process with its own home and a free port, never the user's on 4748/6006; web/e2e/lib/rig.mjs `Scratch` starts it) whose
// certificate lists 127.0.0.1 and a dotted name that resolves to 127.0.0.1, and the stand-ins the connector contract needs beside
// it: a port nothing listens on, a listener that does not speak TLS, a TLS server without h2, and a listener that takes a
// connection and never answers.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../../..");
const { Scratch, freePort, standInAgent } = await import(path.join(repo, "web/e2e/lib/rig.mjs"));
export { freePort };

/** The name that resolves to 127.0.0.1 in public DNS; the server's certificate lists it as a user's set-up lists the names clients reach it by (AD-36). */
export const DOTTED = "localtest.me";

/** The server program: AIWB_E2E_BIN, else built into `out`. */
export function serverBinary(out) {
  if (process.env.AIWB_E2E_BIN) return path.resolve(process.env.AIWB_E2E_BIN);
  const bin = path.join(out, "ai-whiteboard");
  execFileSync("go", ["build", "-o", bin, "./cmd/ai-whiteboard"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  return bin;
}

/** A running scratch server: { host: "127.0.0.1", dotted, port, fingerprint, secret, home, bin, scratch, stop() }. With `agent` the server
 *  runs the stand-in agent of the tests (internal/agenttest/fake-claude: it answers "FAKE(<model>): <the message>", no paid model). */
export async function startServer({ out, tag = "server", agent = false }) {
  const bin = serverBinary(out);
  const s = new Scratch({ out, bin, agent: agent ? standInAgent(out) : null, tag, name: "device-test" });
  s.port = await freePort();
  const printed = execFileSync(bin, ["remote", "setup", "-home", s.home, "-port", String(s.port), "-name", "127.0.0.1", "-name", DOTTED], {
    env: s.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  s.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(printed)?.[1] ?? "";
  s.secret = fs.readFileSync(path.join(s.home, "remote-secret"), "utf8").trim();
  if (!s.fingerprint || !s.secret) throw new Error(`remote setup gave no fingerprint or no secret: ${printed}`);
  await s.launch();
  return { host: "127.0.0.1", dotted: DOTTED, port: s.port, fingerprint: s.fingerprint, secret: s.secret, home: s.home, bin, stop: () => s.stop(), scratch: s };
}

/** The SHA-256 of a PEM certificate's DER, as the server prints it: upper-case pairs joined by ':'. */
export function fingerprintOfPem(pem) {
  return crypto.createHash("sha256").update(new crypto.X509Certificate(pem).raw).digest("hex").toUpperCase().match(/../g).join(":");
}

/** The stand-ins of the connector contract, on 127.0.0.1 and free ports:
 *    closedPort      nothing listens (the port was free a moment ago)
 *    plainPort       accepts and answers plain text: not TLS
 *    h1Port          TLS with the fixture certificate `a` that negotiates HTTP/1.1 only (h1Fingerprint is its fingerprint)
 *    blackholePort   accepts the connection and never answers it
 *  and, for the contract's cases that script the server (cut it, hang a path, list its requests, write on a stream), the control
 *  server of the stand-in of @aiwb/conn's tests (app/modules/aiwb-net/dev/control.mjs; the app drives it, src/dev/standinControl.ts):
 *    control         its URL
 *  `expose(port)`/`unexpose(port)` are told of every server the control server starts (Android: adb reverse).
 *  Answers { closedPort, plainPort, h1Port, h1Fingerprint, blackholePort, control, close() }. */
export async function startStandIns({ expose, unexpose } = {}) {
  const tlsDir = path.join(repo, "packages/conn/test/fixtures/tls");
  const key = fs.readFileSync(path.join(tlsDir, "a.key"));
  const cert = fs.readFileSync(path.join(tlsDir, "a.crt"));
  const servers = [];
  const sockets = new Set();
  const listen = (server) => new Promise((resolve) => {
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); });
    server.on("secureConnection", (s) => s.on("error", () => {}));
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1", () => { servers.push(server); resolve(server.address().port); });
  });
  const h1 = tls.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (s) => { s.on("error", () => {}); s.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"); });
  const plain = net.createServer((s) => { s.on("error", () => {}); s.end("HTTP/1.1 200 OK\r\ncontent-length: 14\r\n\r\nplain, not tls"); });
  const blackhole = net.createServer(() => {});
  const [h1Port, plainPort, blackholePort] = [await listen(h1), await listen(plain), await listen(blackhole)];
  const closedPort = await freePort();
  const { startControl } = await import(path.join(repo, "app/modules/aiwb-net/dev/control.mjs"));
  const control = await startControl({ expose, unexpose });
  return {
    closedPort, plainPort, h1Port, h1Fingerprint: fingerprintOfPem(cert), blackholePort, control: control.control,
    close: async () => {
      await control.close();
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}
