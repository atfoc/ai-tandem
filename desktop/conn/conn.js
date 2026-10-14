'use strict';

// The connection of one entry (port of internal/servers/conn.go): one loop that says hello, holds
// the event stream and opens it again. An edit of more than the name, and an accept, make a new
// Conn for the entry; the new one starts when the old one's loop has ended, so the events of one
// entry come in order. This computer's entry is a LocalConn (local.js), a Conn that starts its
// server first and whose target is set by the starter.

const { openSession, NetError } = require('./session');
const { EventReader, TooLong } = require('./sse');
const {
  MIN_FEATURE_LEVEL, CLIENT_LEVEL, HELLO_PATH, STREAM_PATH, LOCAL_ID,
  stateOf, retries, stops, message, Problem,
} = require('./outcomes');
const { cleanOf, cleanAgents, stateAgents, errorOf, MAX_HELLO } = require('./text');
const { backoffFor } = require('./timing');
const { parseAddress } = require('./address');

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BEFORE_SNAPSHOT = 64; // events held that came before the snapshot

// The details of an unreachable entry whose attempt got as far as the stream.
const DETAIL_NO_STREAM = "The server's event stream did not open";
const DETAIL_ENDED = 'The connection to the server ended';
const DETAIL_SILENCE = 'The server went silent';

const isAbort = (err) => err && err.name === 'AbortError';

// ended is the ending of an outcome of the test's table, with the outcome's message as detail for
// the states that have no text of their own.
function ended(outcome) {
  const e = { state: stateOf(outcome), cause: outcome, detail: '', fingerprint: '', version: '' };
  if (e.state === 'unreachable' || e.state === 'another_server') e.detail = message(outcome);
  return e;
}

// failed is the ending of a request that got no answer: the outcome of the connection that was not
// made, or no_answer. The text of the network may quote the certificate, so it is shown without
// the secret.
function failed(err, secret) {
  if (!(err instanceof Problem)) return ended('no_answer');
  const e = ended(err.outcome);
  if (e.state === 'certificate_not_accepted') e.detail = message(err.outcome);
  else if (e.state === 'certificate_changed') e.fingerprint = err.fingerprint;
  return e;
}

const ABORTED = Object.freeze({ aborted: true });

class Conn {
  // mgr is the Manager; entry is the saved entry {id, name, address, secret, selfSigned, pin, instanceId}.
  constructor(mgr, entry, prev) {
    this.mgr = mgr;
    this.id = entry.id;
    this.entry = entry;
    this.prev = prev || null;
    this.target = entry.address ? Conn.targetOf(entry) : null;
    this.shown = Conn.fresh();
    this.cause = '';
    this.link = null; // set while the stream is open and its snapshot was read
    this.waiting = false; // the loop waits for the back-off or for Retry
    this.removed = false;
    this.running = false;
    this.ctl = null; // the loop's abort controller while running
    this.actl = null; // the attempt's
    this.waker = null;
    this.epoch = 0;
    this.loopDone = prev ? prev.loopDone : Promise.resolve();
  }

  static fresh() {
    return { state: 'connecting', detail: '', fingerprint: '', version: '', agents: [] };
  }

  static targetOf(e) {
    const a = parseAddress(e.address);
    return { address: a.address, host: a.host, port: a.port, secret: e.secret, selfSigned: !!e.selfSigned, pin: e.pin || '' };
  }

  get name() {
    const e = this.mgr.list.get(this.id);
    return (e && e.name) || (this.entry && this.entry.name) || 'The server';
  }

  // view is the entry as the page gets it: never a secret.
  view() {
    const e = this.mgr.list.get(this.id) || this.entry;
    const s = this.shown;
    const v = { id: this.id, name: e.name };
    if (e.address) v.address = e.address;
    if (e.selfSigned) v.selfSigned = true;
    if (e.pin) v.pin = e.pin;
    if (e.instanceId) v.instanceId = e.instanceId;
    v.state = s.state;
    if (s.detail) v.detail = s.detail;
    if (s.fingerprint) v.fingerprint = s.fingerprint;
    if (s.version) v.version = s.version;
    if (s.agents.length) v.agents = [...s.agents];
    return v;
  }

  // identify is the headers every request to the server has: the secret, this app's id and its level.
  identify(extra) {
    return {
      'x-aiwb-secret': this.target.secret,
      'x-aiwb-client': this.mgr.clientId,
      'x-aiwb-level': String(CLIENT_LEVEL),
      ...extra,
    };
  }

  // change runs f, which changes the connection's fields. When the view is then another, a
  // server_state event is emitted. A connection that was replaced or removed changes nothing.
  change(f) {
    if (!this.mgr.isCurrent(this)) return;
    const was = JSON.stringify(this.view());
    f();
    if (was !== JSON.stringify(this.view())) this.mgr.emit({ app: { type: 'server_state', server: this.view() } });
  }

  // enter puts the connection in the state an attempt ended with. While a state that retries stays
  // for the same cause, its detail stays too: the network's text may differ at every attempt, and
  // no event is sent per attempt. A start that failed is not the network's text but the program's
  // reason, which is what the user reads: it is shown at every attempt, and the event is sent when
  // the view is another.
  enter(e) {
    this.change(() => {
      const s = this.shown;
      if (e.version) s.version = e.version;
      if (s.state === e.state && this.cause === e.cause && retries(e.state) && e.state !== 'not_started') return;
      s.state = e.state;
      s.detail = e.detail || '';
      s.fingerprint = e.fingerprint || '';
      this.cause = e.cause || '';
    });
  }

  // start lets the connection run, from its first attempt. The state is connecting again, silently:
  // the Manager tells the page the views itself.
  start() {
    if (this.running || this.removed) return;
    this.running = true;
    this.shown = Conn.fresh();
    this.cause = '';
    const ctl = new AbortController();
    this.ctl = ctl;
    const before = this.loopDone;
    this.loopDone = (async () => {
      await before;
      if (ctl.signal.aborted) return;
      await this.loop(ctl);
    })().catch((err) => this.mgr.log(`connection ${this.id}: ${err && err.message}`));
  }

  // stop ends the loop and what it holds; the returned promise settles when it has ended.
  stop() {
    this.running = false;
    if (this.ctl) this.ctl.abort();
    this.wake('aborted');
    return this.loopDone;
  }

  // wait blocks for ms, or without end when forever is set. Retry ends it early. The answer is
  // 'timeout', 'retry', 'interrupt' or 'aborted'.
  wait(ctl, ms, forever) {
    return new Promise((resolve) => {
      if (ctl.signal.aborted) return resolve('aborted');
      let timer = null;
      const done = (why) => {
        clearTimeout(timer);
        ctl.signal.removeEventListener('abort', onAbort);
        this.waiting = false;
        this.waker = null;
        resolve(why);
      };
      const onAbort = () => done('aborted');
      ctl.signal.addEventListener('abort', onAbort, { once: true });
      if (!forever) timer = setTimeout(() => done('timeout'), ms);
      this.waiting = true;
      this.waker = done;
    });
  }

  wake(why) {
    if (this.waker) this.waker(why);
  }

  // retry makes a connection that waits try now: one in a stopped state goes to connecting, one in
  // its back-off keeps its state. One that is connected or in an attempt is left alone, and so is
  // one that only an accept or an edit gets going again (unless force: this computer's own Retry).
  retry(force = false) {
    if (!this.waiting) return;
    const s = this.shown.state;
    if (!force && (s === 'fingerprint_not_accepted' || s === 'certificate_changed')) return;
    this.wake('retry');
  }

  // retryIfBackingOff is what a call to an entry that is not connected does: an entry in its
  // back-off tries now. Every other state waits for the user.
  retryIfBackingOff() {
    if (this.waiting && retries(this.shown.state)) this.wake('retry');
  }

  // interrupt ends the attempt or the wait the loop is in, and makes the loop begin again at once
  // with what it finds in needStart (this computer's loop only).
  interrupt() {
    this.epoch++;
    if (this.actl) this.actl.abort();
    this.wake('interrupt');
  }

  // loop makes attempts until the connection is stopped. After an attempt that ended in a state
  // that retries it waits for the back-off; in a state that stops it waits for Retry. The back-off
  // starts again after a stream that stayed open for `stable`: one that ended sooner counts as one
  // more failed attempt, so a server that drops every stream is asked ever less often. A too old
  // server is the one stopped state that also tries again by itself, every `tooOld`: it connects
  // once it was updated on its machine. That attempt is made in the state too_old, so that
  // nothing is put on the entry meanwhile.
  async loop(ctl) {
    const tm = this.mgr.timing;
    for (let n = 0; ;) {
      const e = await this.attempt(ctl);
      if (ctl.signal.aborted || e.aborted) return;
      if (e.up && e.open >= tm.stable) n = 0;
      this.enter(e);
      if (stops(e.state)) {
        const why = await this.wait(ctl, tm.tooOld, e.state !== 'too_old');
        if (why === 'aborted') return;
        if (why === 'retry') this.enter({ state: 'connecting', cause: '' });
        n = 0;
        continue;
      }
      if ((await this.wait(ctl, backoffFor(tm, n), false)) === 'aborted') return;
      n++;
    }
  }

  // attempt is one attempt: the connection, hello, the identity and level checks, then the stream
  // until it ends. Nothing is written to a certificate that was not accepted.
  async attempt(ctl) {
    const { mgr, target } = this;
    const actl = new AbortController();
    this.actl = actl;
    const onLoop = () => actl.abort();
    ctl.signal.addEventListener('abort', onLoop, { once: true });
    const signal = actl.signal;
    let session = null;
    try {
      if (target.selfSigned && !target.pin) return ended('fingerprint');
      try {
        session = await openSession({
          host: target.host, port: target.port, signal, dial: mgr.dial, timing: mgr.timing,
          trust: { selfSigned: target.selfSigned, pin: target.pin, roots: mgr.roots },
        });
      } catch (err) {
        if (isAbort(err) || signal.aborted) return ABORTED;
        return failed(err, target.secret);
      }
      return await this.attemptOn(session, signal);
    } finally {
      this.link = null;
      if (session) session.close();
      ctl.signal.removeEventListener('abort', onLoop);
      if (this.actl === actl) this.actl = null;
    }
  }

  // claim is the identity check of a connect, with the id a valid hello of the server gave: the
  // refusal is is_local, duplicate, another_server or ''. current is false for a connection that
  // was replaced.
  claim(instanceId) {
    return this.mgr.claim(this, instanceId);
  }

  async attemptOn(session, signal) {
    const { mgr, target } = this;
    const tm = mgr.timing;
    const aborted = () => signal.aborted;

    // Hello.
    let res;
    try {
      res = await session.fetch({
        method: 'GET', path: HELLO_PATH, headers: this.identify(), limitMs: tm.hello, headersMs: tm.headers,
        maxBytes: MAX_HELLO, signal,
      });
    } catch (err) {
      if (isAbort(err) || aborted()) return ABORTED;
      return err instanceof NetError && err.code === 'too_long' ? ended('not_aiwb') : ended('no_answer');
    }
    const text = res.body.toString('utf8');
    if (res.status === 401) return ended('secret_refused');
    if (res.status === 403 && errorOf(text) === 'bad host') return ended('bad_host');
    if (res.status !== 200) return ended('not_aiwb');
    let hello;
    try { hello = JSON.parse(text); } catch { return ended('not_aiwb'); }
    if (hello === null || typeof hello !== 'object' || Array.isArray(hello)) return ended('not_aiwb');
    const instance = typeof hello.instanceId === 'string' ? hello.instanceId : '';
    if (hello.app !== 'ai-whiteboard' || !INSTANCE_ID.test(instance)) return ended('not_aiwb');
    const version = cleanOf(typeof hello.version === 'string' ? hello.version : '', target.secret);
    const withVersion = (e) => ({ ...e, version });
    const level = Number.isInteger(hello.featureLevel) ? hello.featureLevel : 0; // a missing level counts as 0
    if (level < MIN_FEATURE_LEVEL) return withVersion(ended('too_old'));
    const claim = this.claim(instance);
    if (!claim.current) return ABORTED;
    if (claim.refusal) {
      const e = ended(claim.refusal);
      if (claim.refusal === 'duplicate') e.detail = `${e.detail} ${claim.name}`;
      return withVersion(e);
    }

    // The stream. It has no time limit but for its headers and its snapshot; the watchdog ends it
    // when no byte came for `silence`.
    const sctl = new AbortController();
    const onAbort = () => sctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let head;
      try {
        head = await session.send({
          method: 'GET', path: `${STREAM_PATH}?client=${encodeURIComponent(mgr.clientId)}`,
          headers: this.identify({ accept: 'text/event-stream' }), signal: sctl.signal, headersMs: tm.headers,
        });
      } catch (err) {
        if (isAbort(err) || aborted()) return ABORTED;
        return withVersion(failed(err, target.secret));
      }
      const notOpen = withVersion({ state: 'unreachable', cause: 'no_stream', detail: DETAIL_NO_STREAM, fingerprint: '' });
      const status = head.status;
      if (status === 401) return withVersion(ended('secret_refused'));
      if (status === 403) {
        const body = await readSmall(head.stream, tm.firstEvent, sctl.signal);
        if (aborted()) return ABORTED;
        return errorOf(body) === 'bad host' ? withVersion(ended('bad_host')) : notOpen;
      }
      if (status !== 200 || !String(head.headers['content-type'] || '').toLowerCase().startsWith('text/event-stream')) return notOpen;
      return await this.follow({ session, head, sctl, signal, version, level, notOpen, withVersion });
    } finally {
      signal.removeEventListener('abort', onAbort);
      sctl.abort();
    }
  }

  // follow reads the open stream: the events before the snapshot are held, then the snapshot makes
  // the entry connected, and every event after it is passed on in order.
  follow({ session, head, sctl, signal, version, notOpen, withVersion }) {
    const { mgr, target } = this;
    const tm = mgr.timing;
    const stream = head.stream;
    return new Promise((resolve) => {
      const reader = new EventReader();
      const before = [];
      let live = false;
      let silent = false;
      let since = 0;
      let done = false;
      const link = { session, refused: false, stop: () => sctl.abort() };
      const firstTimer = setTimeout(() => { sctl.abort(); finish(notOpen); }, tm.firstEvent);
      const silence = setTimeout(() => { silent = true; sctl.abort(); }, tm.silence);

      const finish = (ending) => {
        if (done) return;
        done = true;
        clearTimeout(firstTimer);
        clearTimeout(silence);
        if (this.link === link) this.link = null;
        stream.destroy();
        resolve(ending);
      };
      // ends is how the stream ended once it was live.
      const ends = () => {
        if (signal.aborted) return finish(ABORTED);
        let e = withVersion({ state: 'unreachable', cause: 'ended', detail: DETAIL_ENDED, fingerprint: '' });
        if (link.refused) e = withVersion(ended('secret_refused'));
        else if (silent) e = { ...e, cause: 'silence', detail: DETAIL_SILENCE };
        return finish({ ...e, up: true, open: Date.now() - since });
      };
      const over = () => {
        if (done) return;
        if (!live) return finish(signal.aborted ? ABORTED : notOpen);
        ends();
      };

      const onEvent = (raw) => {
        let ev;
        try { ev = JSON.parse(raw); } catch { ev = null; }
        if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return false; // not an event of ours
        const type = typeof ev.type === 'string' ? ev.type : '';
        if (!live) {
          if (type !== 'snapshot') {
            if (before.length < MAX_BEFORE_SNAPSHOT) before.push(ev);
            return true;
          }
          const agents = stateAgents(ev, target.secret);
          if (agents === null) { finish(withVersion(ended('no_state'))); return true; }
          clearTimeout(firstTimer);
          if (!mgr.isCurrent(this)) { finish(ABORTED); return true; }
          live = true;
          since = Date.now();
          this.link = link;
          for (const b of before) mgr.emit({ server: this.id, event: b });
          mgr.emit({ server: this.id, event: ev });
          this.change(() => {
            this.shown = { state: 'connected', detail: '', fingerprint: '', version, agents };
            this.cause = 'connected';
          });
          return true;
        }
        mgr.emit({ server: this.id, event: ev });
        if (type === 'agents') {
          const agents = cleanAgents(ev.agents, target.secret);
          this.change(() => { this.shown.agents = agents; });
        }
        return true;
      };

      stream.on('data', (chunk) => {
        if (done) return;
        silence.refresh();
        let events;
        try {
          events = reader.push(chunk);
        } catch (err) {
          if (err instanceof TooLong) return over();
          throw err;
        }
        for (const raw of events) {
          if (done) return;
          if (!onEvent(raw)) return over(); // the next stream starts from a snapshot again
        }
      });
      stream.on('end', over);
      stream.on('close', over);
      stream.on('error', over);
      session.onClose(over);
      sctl.signal.addEventListener('abort', over, { once: true });
    });
  }
}

// readSmall reads what is left of a short body, within ms, as text; '' when it fails.
function readSmall(stream, ms, signal) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(), ms);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    signal.addEventListener('abort', finish, { once: true });
    stream.on('data', (c) => { if (size < MAX_HELLO) { chunks.push(c); size += c.length; } });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

module.exports = { Conn, ended, failed, ABORTED, isAbort, LOCAL_ID, INSTANCE_ID };
