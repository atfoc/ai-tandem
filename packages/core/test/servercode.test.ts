// The parser of what a phone is given to add a server (S12, goal 4.7): the real outputs of `setup-remote.sh` and `remote setup` of a scratch
// server home (fixtures/remote-setup: the machine's own names replaced by example ones), the line of `secret`, the text of a server code, and
// the texts it refuses, each with its reason in words that never repeat the secret.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { codeText, parseServerCode, samePrint, suggestName } from "../src/logic/servercode.ts";
import { formError } from "../src/logic/servers.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/remote-setup/${name}`, import.meta.url), "utf8");
const SECRET = fixture("secret-line.txt").trim();
const FP = "E6:45:B0:35:48:5E:F3:4B:96:8E:6E:F4:40:67:7F:5E:E4:E7:43:3E:71:0D:21:3E:4A:F8:04:DE:DD:3F:A2:E2";
const ok = (text: string) => { const r = parseServerCode(text); assert.ok(r.ok, r.ok ? "" : r.message); return r.code; };
const refused = (text: string) => { const r = parseServerCode(text); assert.ok(!r.ok, "was taken"); return r; };

test("the fixtures are what a server prints: a secret of 64 hex digits, and the output carries the same one", () => {
  assert.match(SECRET, /^[0-9a-f]{64}$/);
  assert.ok(fixture("setup-remote-default.txt").includes(`Secret: ${SECRET}`));
  assert.ok(!fixture("remote-setup-raw.txt").includes(SECRET), "`remote setup` prints no secret");
});

test("the whole output of setup-remote.sh: every address in its order, the fingerprint, the secret", () => {
  assert.deepEqual(ok(fixture("setup-remote-default.txt")), {
    addresses: ["https://mac.example.net:4790", "https://192.168.0.20:4790", "https://10.0.0.5:4790"], fingerprint: FP, secret: SECRET,
  });
  const names = ok(fixture("setup-remote-names.txt"));
  assert.equal(names.addresses.length, 5);
  assert.equal(names.addresses[3], "https://studio.example.net:4748");
  assert.equal(names.fingerprint, "5B:3E:0F:DD:9B:73:AB:96:8E:54:B0:CB:FB:AE:A7:05:5B:66:3C:20:32:12:53:D5:92:E9:DC:B6:BE:34:05:5C");
  assert.match(names.secret, /^[0-9a-f]{64}$/);
});

test("every address and the secret it takes are ones the form takes", () => {
  for (const f of ["setup-remote-default.txt", "setup-remote-names.txt"]) {
    const c = ok(fixture(f));
    for (const address of c.addresses) assert.equal(formError({ name: "x", address, secret: c.secret, selfSigned: true, pin: "" }), "", address);
  }
});

test("the output on a machine that is not a Mac (no firewall note), and with Windows line ends, reads the same", () => {
  const text = fixture("setup-remote-default.txt");
  const linux = text.split("macOS:")[0];
  assert.deepEqual(ok(linux), ok(text));
  assert.deepEqual(ok(text.replace(/\n/g, "\r\n")), ok(text));
});

test("the output of `remote setup` with the line of `secret`: the addresses are made of the names and the port", () => {
  const c = ok(`${fixture("remote-setup-raw.txt")}${SECRET}\n`);
  assert.deepEqual(c.addresses, ["https://mac.example.net:4790", "https://192.168.0.20:4790", "https://10.0.0.5:4790"]);
  assert.equal(c.secret, SECRET);
  assert.equal(c.fingerprint, FP);
  assert.equal(ok(`${fixture("remote-setup-raw.txt")}Secret: ${SECRET}`).secret, SECRET);
});

test("an address and a secret, typed or pasted, on one line or two", () => {
  assert.deepEqual(ok(`https://studio.example:4790 ${SECRET}`), { addresses: ["https://studio.example:4790"], secret: SECRET });
  assert.deepEqual(ok(`  https://studio.example:4790/\n${SECRET}\n`), { addresses: ["https://studio.example:4790"], secret: SECRET });
  assert.deepEqual(ok("https://10.0.0.5:4748\ns3cret-value"), { addresses: ["https://10.0.0.5:4748"], secret: "s3cret-value" });
  assert.deepEqual(ok(`Secret: ${SECRET}\nhttps://a.example:1`), { addresses: ["https://a.example:1"], secret: SECRET });
});

test("the text of a server code (what scripts/server-code.sh encodes) reads back as it was made", () => {
  const code = ok(fixture("setup-remote-names.txt"));
  const text = codeText(code);
  assert.ok(text.length < 600, `${text.length} characters: small enough for a code that is read from a screen`);
  assert.deepEqual(ok(text), code);
  assert.deepEqual(ok(codeText({ addresses: ["https://a.example:1"], secret: SECRET })), { addresses: ["https://a.example:1"], secret: SECRET });
});

test("the fingerprint is upper-cased, and compared without colons or case", () => {
  assert.equal(ok(`Fingerprint: ${FP.toLowerCase()}\nhttps://a.example:1\nSecret: ${SECRET}`).fingerprint, FP);
  assert.ok(samePrint(FP, FP.toLowerCase()));
  assert.ok(samePrint(FP, FP.replace(/:/g, "")));
  assert.ok(!samePrint(FP, FP.replace("E6", "E7")));
  assert.ok(!samePrint("", ""));
});

test("a name for the entry: the first label of a DNS name, an IPv4 address whole", () => {
  assert.equal(suggestName("https://studio.tailnet-1234.ts.net:4748"), "studio");
  assert.equal(suggestName("https://10.0.0.5:4748"), "10.0.0.5");
  assert.equal(suggestName("nope"), "");
});

test("refused: nothing, too much, and what is not a server's text", () => {
  assert.equal(refused("").reason, "empty");
  assert.equal(refused("  \n \t").reason, "empty");
  assert.equal(refused("x".repeat(9000)).reason, "too_long");
  assert.equal(refused("hello, this is my shopping list").reason, "not_a_code");
  assert.equal(refused("https://example.com/watch?v=1").reason, "bad_address");
});

test("refused: a partial paste says what is missing", () => {
  const raw = refused(fixture("remote-setup-raw.txt"));
  assert.equal(raw.reason, "no_secret");
  assert.match(raw.message, /secret is missing.*setup-remote\.sh/s);
  assert.equal(refused("https://studio.example:4790").reason, "no_secret");
  assert.equal(refused(`Fingerprint: ${FP}\nSecret: ${SECRET}`).reason, "no_address");
  assert.equal(refused(SECRET).reason, "no_address");
  assert.equal(refused("Names: a.example\nSecret: abc").reason, "no_address");
});

test("refused: plain http is never taken, in any position, even beside an https address", () => {
  assert.equal(refused(`http://studio.example:4790 ${SECRET}`).reason, "plain_http");
  assert.equal(refused(`https://a.example:1\nhttp://b.example:2\nSecret: ${SECRET}`).reason, "plain_http");
  assert.match(refused("HTTP://a.example:1 abc").message, /https only/);
});

test("refused: an address the form would refuse, a secret it would refuse, two servers' texts", () => {
  for (const bad of ["https://studio.example", "https://studio.example:0", "https://studio.example:70000", "https://[::1]:4748", "https://a.example:4748/api", "https://-a.example:4748"]) {
    assert.equal(refused(`${bad}\nSecret: ${SECRET}`).reason, "bad_address", bad);
  }
  assert.equal(refused(`https://a.example:1\nSecret: ${"a".repeat(257)}`).reason, "bad_secret");
  assert.equal(refused("https://a.example:1\nSecret: two words").reason, "bad_secret");
  assert.equal(refused(`https://a.example:1\nSecret: ${SECRET}\nSecret: ${SECRET.replace(/^./, "0")}`).reason, "two_secrets");
  assert.equal(refused(`${fixture("setup-remote-default.txt")}\n${fixture("setup-remote-names.txt")}`).reason, "two_secrets");
  assert.equal(refused(`https://a.example:1\nSecret: ${SECRET}\nFingerprint: ${FP}\nFingerprint: ${FP.replace("E6", "E7")}`).reason, "two_fingerprints");
  assert.equal(refused(`https://a.example:1\nSecret: ${SECRET}\nFingerprint: E6:45`).reason, "bad_fingerprint");
});

test("the words of a refusal never repeat the secret or the text", () => {
  const texts = [`http://a.example:1 ${SECRET}`, `https://a.example\nSecret: ${SECRET}`, `https://a.example:1\nSecret: ${SECRET}\nSecret: ${SECRET}x\n`, `https://a.example:1\nSecret: ${"z".repeat(300)}`,
    `Fingerprint: ${FP}\nSecret: ${SECRET}`, `https://a.example:1\nSecret: ${SECRET}\nFingerprint: nope`];
  for (const t of texts) {
    const r = refused(t);
    assert.ok(!r.message.includes(SECRET) && !r.message.includes("zzzz") && !r.message.includes("a.example"), r.message);
  }
});
