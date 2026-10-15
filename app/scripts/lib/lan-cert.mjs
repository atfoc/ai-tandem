// The https that an over-the-air install needs on a local network (scripts/serve-ipa.mjs): a certificate authority of this
// computer that the device is asked to trust once, and a server certificate for this computer's addresses, made again each run.
//
// The authority's key stays on this computer (~/.aiwb-install/ca, mode 700) and the device is asked to trust it, so the authority is
// limited by name constraints: it can sign for private network addresses (10/8, 172.16/12, 192.168/16, 100.64/10) and for names
// under "localhost", and for nothing else. A leaked key could not impersonate a public site.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRIVATE_RANGES = ["10.0.0.0/255.0.0.0", "172.16.0.0/255.240.0.0", "192.168.0.0/255.255.0.0", "100.64.0.0/255.192.0.0"];

/** `os.networkInterfaces()` → the IPv4 addresses other computers can reach: [{ name, address }]. */
export function lanAddresses(interfaces) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const a of list ?? []) if ((a.family === "IPv4" || a.family === 4) && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

export const caExtensions = () => `basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,${[...PRIVATE_RANGES.map((r) => `permitted;IP:${r}`), "permitted;DNS:localhost"].join(",")}
`;

export const serverExtensions = (addresses) => `basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${[...addresses.map((a) => `IP:${a}`), "DNS:localhost"].join(",")}
`;

function openssl(args, cwd) {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.error?.code === "ENOENT") throw new Error("openssl is not installed (it comes with macOS)");
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/**
 * The authority (made once, in `dir`) and a fresh server certificate for `addresses`.
 * → { caDer: Buffer, caCreated: boolean, key: string, cert: string } (PEM; the cert is followed by the authority's).
 */
export function lanCertificate({ addresses, dir = path.join(os.homedir(), ".aiwb-install/ca"), days = 365 }) {
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (f) => path.join(dir, f);
  let caCreated = false;
  if (!fs.existsSync(p("ca.key")) || !fs.existsSync(p("ca.pem"))) {
    caCreated = true;
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p("ca.key")], dir);
    fs.chmodSync(p("ca.key"), 0o600);
    fs.writeFileSync(p("ca.ext"), caExtensions());
    openssl(["req", "-new", "-x509", "-key", p("ca.key"), "-sha256", "-days", "3650", "-extensions", "ext", "-config", writeConfig(p("ca.cnf"), "ca.ext", `AI Whiteboard local CA (${os.hostname()})`), "-out", p("ca.pem")], dir);
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = (f) => p(`${stamp}-${f}`);
  try {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", tmp("srv.key")], dir);
    openssl(["req", "-new", "-key", tmp("srv.key"), "-subj", "/CN=AI Whiteboard install server", "-out", tmp("srv.csr")], dir);
    fs.writeFileSync(tmp("srv.ext"), serverExtensions(addresses));
    openssl(["x509", "-req", "-in", tmp("srv.csr"), "-CA", p("ca.pem"), "-CAkey", p("ca.key"), "-CAcreateserial", "-CAserial", p("ca.srl"), "-sha256", "-days", String(days), "-extfile", tmp("srv.ext"), "-out", tmp("srv.pem")], dir);
    const caPem = fs.readFileSync(p("ca.pem"), "utf8");
    return {
      caCreated,
      caDer: Buffer.from(openssl(["x509", "-in", p("ca.pem"), "-outform", "pem"], dir).replace(/-----[^-]+-----|\s/g, ""), "base64"),
      key: fs.readFileSync(tmp("srv.key"), "utf8"),
      cert: fs.readFileSync(tmp("srv.pem"), "utf8") + caPem,
    };
  } finally {
    for (const f of ["srv.key", "srv.csr", "srv.ext", "srv.pem"]) fs.rmSync(tmp(f), { force: true });
  }
}

/** A minimal openssl config with the authority's name and the extensions of `extFile` (the macOS openssl takes the name of `req -x509` from the config, not from -subj). */
function writeConfig(file, extFile, commonName) {
  fs.writeFileSync(file, `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${commonName}\n[ext]\n${fs.readFileSync(path.join(path.dirname(file), extFile), "utf8")}`);
  return file;
}
