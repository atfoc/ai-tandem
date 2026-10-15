'use strict';

// The harness of the connection tests: a temporary state folder, a client with lowered waits, a
// recorder of everything the client said, and polling waits with generous bounds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createNodeClient: createClient } = require('../node');
const { pem } = require('./standin');

const { FAST, sleep, until, Recorder } = require('./fakes/support');

const CA = pem('ca', 'crt').toString();

// tmpDir makes a folder that goes when the test file's process ends, whether or not the test cleaned it.
const made = [];
function tmpDir(prefix = 'aiwb-conn-') {
  if (!made.length) process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  made.push(dir);
  return dir;
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
