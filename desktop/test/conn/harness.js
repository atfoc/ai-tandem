'use strict';

// The harness of the connection tests: a temporary state folder, a client with lowered waits, a
// recorder of everything the client said, and polling waits with generous bounds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createClient } = require('../../conn');
const { pem } = require('./standin');

// The waits the tests lower. Nothing here is a bound on how long something may take.
const FAST = {
  dial: 2000, handshake: 2000, headers: 2000, hello: 3000, firstEvent: 3000, testStep: 2000,
  silence: 8000, backoff: [20, 40, 80], jitter: 0, stable: 150, tooOld: 150,
  call: 3000, start: 3000, scene: 3000, imageCall: 3000, delete: 3000, dirs: 3000, usage: 3000, unfollow: 3000,
  launch: 3000, relaunch: 3000, secret: 3000, status: 3000,
};

const CA = pem('ca', 'crt').toString();

// tmpDir makes a folder that goes when the test file's process ends, whether or not the test cleaned it.
const made = [];
function tmpDir(prefix = 'aiwb-conn-') {
  if (!made.length) process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  made.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// until polls pred until it is true; it fails after ms (generous: seconds, not milliseconds).
async function until(pred, what = 'the condition', ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

class Recorder {
  constructor() {
    this.envelopes = [];
    this.logs = [];
    this.answers = [];
    this.secrets = new Set();
  }

  onEnvelope = (env) => { this.envelopes.push(env); };
  onLog = (line) => { this.logs.push(line); };

  // answers keeps everything the client said besides the envelopes, for the scan.
  keep(v) { this.answers.push(JSON.stringify(v)); return v; }

  stateOf(id) {
    let s = null;
    for (const e of this.envelopes) if (e.app && e.app.type === 'server_state' && e.app.server.id === id) s = e.app.server.state;
    return s;
  }

  viewOf(id) {
    let v = null;
    for (const e of this.envelopes) if (e.app && e.app.type === 'server_state' && e.app.server.id === id) v = e.app.server;
    return v;
  }

  states(id) {
    return this.envelopes.filter((e) => e.app && e.app.type === 'server_state' && e.app.server.id === id).map((e) => e.app.server.state);
  }

  eventsOf(id) { return this.envelopes.filter((e) => e.server === id).map((e) => e.event); }

  // assertNoSecrets scans everything seen: envelopes, app answers, log lines.
  assertNoSecrets({ events = true } = {}) {
    const seen = events ? this.envelopes : this.envelopes.filter((e) => e.app);
    const all = JSON.stringify(seen) + this.answers.join('\n') + this.logs.join('\n');
    for (const s of this.secrets) assert.ok(!all.includes(s), `a secret appeared in what the client said`);
  }
}

// make builds a client in a fresh state folder.
function make({ local = null, timing = {}, stateDir, dial, roots = CA } = {}) {
  const dir = stateDir || tmpDir();
  const rec = new Recorder();
  const client = createClient({ stateDir: dir, local, timing: { ...FAST, ...timing }, log: rec.onLog, roots: roots === null ? undefined : roots, dial });
  const sub = { current: null };
  return {
    dir, client, rec,
    subscribe() { sub.current = client.subscribe(rec.onEnvelope); return sub.current; },
    async app(op, args) { const a = await client.app(op, args); rec.keep(a); return a; },
    async close() { if (sub.current) sub.current.close(); await client.close(); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// addServer adds a stand-in as an entry of the list (pinned, self-signed box on) without a test.
async function addServer(h, s, name = 'Remote', extra = {}) {
  h.rec.secrets.add(s.secret);
  const a = await h.app('servers.add', {
    force: true,
    form: { name, address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint, ...extra },
  });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.saved, true);
  return a.body.server;
}

module.exports = { FAST, CA, tmpDir, sleep, until, Recorder, make, addServer };
