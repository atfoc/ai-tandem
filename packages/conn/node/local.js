'use strict';

// This computer's starter and its connection (plan C3.9, C3.10). The app finds this computer's
// server or starts it by running the server program (`launch -json`), takes its secret from
// `secret`, and connects as to any other server, pinned by the fingerprint the launch printed. The
// user types and accepts nothing for this entry. The server is not a child of the app and outlives
// it. It is the LocalPort of the Node client (nodeLocal), and only Node has it: a phone has no
// server of its own.

const { execFile } = require('node:child_process');
const { Conn, ended } = require('../core/conn');
const { parseAddress } = require('../core/address');
const { normalFingerprint } = require('../core/list');
const { LOCAL_ID, LOCAL_NAME, retries } = require('../core/outcomes');
const { backoffFor } = require('../core/timing');

const MAX_DETAIL = 2000; // characters of a failed start's reason

// defaultRun runs the server program and always answers: code -1 when it could not run.
function defaultRun(bin, env) {
  return (args, timeoutMs) => new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      if (typeof err.code === 'number') return resolve({ code: err.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      const why = err.killed ? `the server program did not finish within ${Math.round(timeoutMs / 1000)} seconds` : err.message;
      resolve({ code: -1, stdout: String(stdout || ''), stderr: String(stderr || '') || why });
    });
  });
}

// detailOf makes a program's text fit to show: no control characters but line ends, no secret.
function detailOf(text, secret) {
  let s = String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
  if (secret) s = s.split(secret).join('…');
  const chars = [...s];
  return chars.length > MAX_DETAIL ? chars.slice(0, MAX_DETAIL).join('') : s;
}

// abortable settles with the promise, or with ABORTED when the signal aborts first: a program that
// hangs never holds the connection up when the app closes.
const ABORTED = Symbol('aborted');
function abortable(promise, signal) {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// Starter runs the server program for this computer's entry. Its commands run one at a time.
class Starter {
  constructor(mgr, { bin, home, env, run }) {
    this.mgr = mgr;
    this.home = home || null;
    this.runner = run || defaultRun(bin, env || process.env);
    this.info = null; // what the last launch printed: {home, address, version, pid, instanceId}
    this.chain = Promise.resolve();
    this.secret = ''; // the last secret read: only to keep it out of texts
  }

  args(cmd) {
    return this.home ? [...cmd, '-home', this.home] : cmd;
  }

  // exclusive runs fn after the commands before it.
  exclusive(fn) {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  // reason is why a command failed, from its answer.
  reason(r, what) {
    const text = detailOf(r.stderr, this.secret);
    if (text) return text;
    return r.code === -1 ? 'the server program could not be run' : `${what} exited with code ${r.code}`;
  }

  // readSecret runs `secret` and takes its first line.
  async readSecret() {
    const r = await this.runner(this.args(['secret']), this.mgr.timing.secret);
    if (r.code !== 0) return { ok: false, detail: this.reason(r, 'secret') };
    const line = String(r.stdout).split('\n')[0].trim();
    if (!/^[\x21-\x7e]{1,256}$/.test(line)) return { ok: false, detail: 'the server program printed no secret' };
    this.secret = line;
    return { ok: true, secret: line };
  }

  // afterLaunch reads the answer of `launch -json` or `relaunch -json` and, for a running server,
  // its secret. The answer is {kind: 'running', target, info}, {kind: 'old_build', ...} or
  // {kind: 'failed', detail}.
  async afterLaunch(r, what) {
    const failed = (detail) => ({ kind: 'failed', detail });
    if (r.code !== 0) return failed(this.reason(r, what));
    const lines = String(r.stdout).split('\n').filter((l) => l.trim() !== '');
    let out;
    try {
      if (lines.length !== 1) throw new Error('not one line');
      out = JSON.parse(lines[0]);
      if (out === null || typeof out !== 'object' || Array.isArray(out)) throw new Error('not an object');
    } catch {
      return failed(`${what} printed something that is not one JSON line`);
    }
    const home = typeof out.home === 'string' ? out.home : '';
    if (out.state === 'old_build') {
      const version = typeof out.version === 'string' ? detailOf(out.version, '') : '';
      this.info = { home, address: '', version, pid: Number.isInteger(out.pid) ? out.pid : 0, instanceId: '' };
      return { kind: 'old_build', version, detail: 'A server of an older build is running: restart it.' };
    }
    if (out.state !== 'running') return failed(`${what} printed a state that is not known`);
    const a = parseAddress(out.address);
    const fingerprint = normalFingerprint(out.fingerprint);
    if (!a || !fingerprint) return failed(`${what} printed no usable address and fingerprint`);
    const s = await this.readSecret();
    if (!s.ok) return failed(s.detail);
    const info = {
      home, address: a.address, version: typeof out.version === 'string' ? out.version : '',
      pid: Number.isInteger(out.pid) ? out.pid : 0, instanceId: typeof out.instanceId === 'string' ? out.instanceId : '',
    };
    this.info = info;
    return {
      kind: 'running', info,
      target: { address: a.address, host: a.host, port: a.port, secret: s.secret, selfSigned: true, pin: fingerprint },
    };
  }

  // start finds this computer's server or starts it.
  start() {
    return this.exclusive(async () => this.afterLaunch(await this.runner(this.args(['launch', '-json']), this.mgr.timing.launch), 'launch'));
  }

  rereadSecret() {
    return this.exclusive(() => this.readSecret());
  }

  // restart brings the server to the build of the program: `relaunch -json`, then `secret`.
  restart() {
    return this.exclusive(async () => this.afterLaunch(await this.runner(this.args(['relaunch', '-json']), this.mgr.timing.relaunch), 'relaunch'));
  }

  async status() {
    const r = await this.runner(this.args(['status', '-json']), this.mgr.timing.status);
    try {
      const v = JSON.parse(String(r.stdout));
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { status: 200, body: v };
    } catch { /* below */ }
    return { status: 500, body: { error: this.reason(r, 'status'), code: 'status_failed' } };
  }
}

// LocalConn is the connection of this computer's entry.
class LocalConn extends Conn {
  constructor(mgr, starter) {
    super(mgr, { id: LOCAL_ID, name: LOCAL_NAME }, null);
    this.starter = starter;
    this.target = null;
    this.isLocal = true;
    this.needStart = true;
    this.gate = null; // set while the server is restarted by the app
    this.gates = 0;
  }

  get name() { return LOCAL_NAME; }

  view() {
    const s = this.shown;
    const info = this.starter.info;
    const v = { id: LOCAL_ID, local: true, name: LOCAL_NAME };
    if (info && info.address) v.address = info.address;
    if (info && info.instanceId) v.instanceId = info.instanceId;
    v.state = s.state;
    if (s.detail) v.detail = s.detail;
    if (s.version) v.version = s.version;
    if (s.agents.length) v.agents = [...s.agents];
    return v; // never a fingerprint or a pin
  }

  start() {
    this.needStart = true;
    super.start();
  }

  // claim: this computer's server is the one the starter found; its id is what a remote entry that
  // is the same server is told apart by.
  claim(instanceId) {
    this.mgr.setLocalInstance(instanceId);
    return { refusal: '', name: '', current: true };
  }

  // applyTarget sets what the connection dials; it answers whether that is another target.
  applyTarget(t, info) {
    const was = this.target;
    const changed = !was || was.address !== t.address || was.secret !== t.secret || was.pin !== t.pin;
    this.target = t;
    this.change(() => {});
    if (info && info.instanceId) this.mgr.setLocalInstance(info.instanceId);
    return changed;
  }

  // pause stops the loop from starting or connecting while the app restarts the server.
  pause() {
    if (!this.gate) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this.gate = { promise, resolve };
    }
    this.gates++;
    this.interrupt();
    this.change(() => { this.shown = { ...Conn.fresh(), detail: 'Restarting…' }; this.cause = 'restarting'; });
  }

  resume(needStart) {
    if (needStart) this.needStart = true;
    if (--this.gates <= 0) {
      this.gates = 0;
      const g = this.gate;
      this.gate = null;
      if (g) g.resolve();
    }
  }

  // gateOpen waits for the restart to end; false when the loop was stopped meanwhile.
  async gateOpen(ctl) {
    const g = this.gate;
    if (!g) return true;
    await new Promise((resolve) => {
      const onAbort = () => resolve();
      ctl.signal.addEventListener('abort', onAbort, { once: true });
      g.promise.then(() => { ctl.signal.removeEventListener('abort', onAbort); resolve(); });
    });
    return !ctl.signal.aborted;
  }

  async loop(ctl) {
    const tm = this.mgr.timing;
    const st = this.starter;
    for (let n = 0; ;) {
      if (ctl.signal.aborted) return;
      if (this.gate) { if (!(await this.gateOpen(ctl))) return; continue; }
      const epoch = this.epoch;
      const stale = () => ctl.signal.aborted || this.epoch !== epoch;
      // after waits for ms and notes what ended the wait: a Retry means start again.
      const after = async (ms, forever) => {
        const why = await this.wait(ctl, ms, forever);
        if (why === 'retry') this.needStart = true;
        return why;
      };

      if (this.needStart || !this.target) {
        const r = await abortable(st.start(), ctl.signal);
        if (ctl.signal.aborted) return;
        if (stale()) continue;
        if (r.kind === 'failed') {
          this.enter({ state: 'not_started', cause: 'not_started', detail: r.detail });
          if ((await after(backoffFor(tm, n), false)) === 'aborted') return;
          n++;
          continue;
        }
        if (r.kind === 'old_build') {
          this.enter({ state: 'too_old', cause: 'old_build', detail: r.detail, version: r.version });
          if ((await after(tm.tooOld, false)) === 'aborted') return;
          continue;
        }
        this.needStart = false;
        this.applyTarget(r.target, r.info);
      }

      const e = await this.attempt(ctl);
      if (ctl.signal.aborted) return;
      if (stale()) continue; // interrupted: begin again at once
      if (e.aborted) {
        if ((await after(backoffFor(tm, n++), false)) === 'aborted') return;
        continue;
      }
      if (e.up && e.open >= tm.stable) n = 0;

      if (e.cause === 'secret_refused') {
        this.enter({ state: 'connecting', cause: '' });
        const s = await abortable(st.rereadSecret(), ctl.signal);
        if (ctl.signal.aborted) return;
        if (stale()) continue;
        if (s.ok && s.secret !== this.target.secret) { this.target = { ...this.target, secret: s.secret }; continue; }
        this.enter(e);
        if ((await after(0, true)) === 'aborted') return;
        continue;
      }
      if (e.cause === 'cert_changed') {
        const r = await abortable(st.start(), ctl.signal);
        if (ctl.signal.aborted) return;
        if (stale()) continue;
        if (r.kind === 'running' && r.target.pin !== this.target.pin) { this.applyTarget(r.target, r.info); continue; }
        this.enter(e);
        if ((await after(0, true)) === 'aborted') return;
        continue;
      }
      this.enter(e);
      if (e.state === 'too_old') {
        if ((await after(tm.tooOld, false)) === 'aborted') return;
        continue; // asked again in the state too_old
      }
      this.needStart = true;
      if (retries(e.state)) {
        if ((await after(backoffFor(tm, n), false)) === 'aborted') return;
        n++;
      } else if ((await after(0, true)) === 'aborted') return;
    }
  }
}

// ownerOp answers the owner's things (C3.10): what the app does for this computer's entry with the
// server program it carries. owner.openLog and owner.reveal are the Electron face's own.
async function ownerOp(mgr, op, args) {
  const local = mgr.localConn;
  if (!local) return { status: 404, body: { error: 'this app has no server of its own', code: 'no_owner' } };
  switch (op) {
    case 'owner.restart': {
      local.pause();
      let r;
      try {
        r = await local.starter.restart();
      } catch (err) {
        r = { kind: 'failed', detail: String(err && err.message) };
      }
      if (r.kind === 'running') {
        local.applyTarget(r.target, r.info);
        local.resume(false);
        return { status: 200, body: { ok: true } };
      }
      local.resume(true);
      return { status: 500, body: { error: r.detail, code: 'restart_failed' } };
    }
    case 'owner.retry':
      local.retry(true);
      return { status: 200, body: { ok: true } };
    case 'owner.status':
      return local.starter.status();
    case 'owner.openLog':
    case 'owner.reveal':
      return { status: 501, body: { error: 'this is done by the app', code: 'not_here' } };
    default:
      return null;
  }
}

// nodeLocal is the LocalPort of this computer's server: options are { bin, home, env?, run? } (run
// is the test seam for running the server program).
function nodeLocal(options) {
  let conn = null;
  return {
    connect(mgr) {
      conn = new LocalConn(mgr, new Starter(mgr, options));
      return conn;
    },
    ownerOp: (mgr, op, args) => ownerOp(mgr, op, args),
    info() {
      const info = conn && conn.starter.info;
      return info ? { home: info.home, address: info.address, version: info.version, pid: info.pid } : null;
    },
  };
}

module.exports = { Starter, LocalConn, ownerOp, nodeLocal, defaultRun, detailOf, ended };
