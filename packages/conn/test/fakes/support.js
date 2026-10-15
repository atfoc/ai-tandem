'use strict';

// What the tests on fake ports share, with nothing of Node in it (the fakes run wherever the core
// does): the waits the tests lower, polling waits with generous bounds, a seeded source of random
// bytes, and the recorder of everything a client said.

// The waits the tests lower. Nothing here is a bound on how long something may take.
const FAST = {
  dial: 2000, handshake: 2000, headers: 2000, hello: 3000, firstEvent: 3000, testStep: 2000,
  silence: 8000, backoff: [20, 40, 80], jitter: 0, stable: 150, tooOld: 150,
  call: 3000, start: 3000, scene: 3000, imageCall: 3000, delete: 3000, dirs: 3000, usage: 3000, unfollow: 3000,
  launch: 3000, relaunch: 3000, secret: 3000, status: 3000,
};

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

// seededRandom is a `random` of createClient that gives the same bytes in the same order, so that
// the ids of the entries are the same in every run.
function seededRandom(seed = 1) {
  let x = seed >>> 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      bytes[i] = x >>> 24;
    }
    return bytes;
  };
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

  // keep keeps everything the client said besides the envelopes, for the scan.
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
    for (const s of this.secrets) if (all.includes(s)) throw new Error('a secret appeared in what the client said');
  }
}

module.exports = { FAST, sleep, until, seededRandom, Recorder };
