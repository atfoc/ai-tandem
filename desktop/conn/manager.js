'use strict';

// The Manager holds the server list and one connection per entry, this computer's included (port
// of internal/servers/manager.go). It is what createClient wraps. Connections run only while a
// subscription exists.

const { List, ListError, ERR, clientId, ensureStateDir, normalFingerprint } = require('./list');
const { Conn } = require('./conn');
const { Starter, LocalConn, ownerOp } = require('./local');
const { testConnection } = require('./test');
const { call } = require('./calls');
const { picture } = require('./picture');
const { withDefaults } = require('./timing');
const { LOCAL_ID } = require('./outcomes');

// Mutex runs functions one at a time, in order.
class Mutex {
  constructor() { this.tail = Promise.resolve(); }

  run(fn) {
    const result = this.tail.then(fn);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

// serverFail is an error of the server list as the answer of an operation (today's /api/servers).
function serverFail(err, verb) {
  if (!(err instanceof ListError)) return { status: 500, body: { error: String(err && err.message) } };
  switch (err.code) {
    case 'local_entry': return { status: 409, body: { error: `this computer cannot be ${verb}`, code: 'local_entry' } };
    case 'not_found': return { status: 404, body: { error: err.message } };
    case 'duplicate': return { status: 409, body: { error: err.message, code: 'duplicate' } };
    default: return { status: 400, body: { error: err.message, code: err.code } };
  }
}

const str = (v) => (typeof v === 'string' ? v : '');
const badRequest = () => ({ status: 400, body: { error: 'the request cannot be read', code: 'bad_request' } });

// A form field of the wrong kind is a request that cannot be read.
function formOk(f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return false;
  for (const k of ['name', 'address', 'secret', 'pin']) if (f[k] !== undefined && f[k] !== null && typeof f[k] !== 'string') return false;
  return f.selfSigned === undefined || f.selfSigned === null || typeof f.selfSigned === 'boolean';
}

const sameLink = (a, b) => a.address === b.address && a.secret === b.secret && a.selfSigned === b.selfSigned && a.pin === b.pin;
const targetOf = (e) => ({ address: e.address, secret: e.secret, selfSigned: e.selfSigned, pin: e.pin });

// applyPatch writes the given fields into e; a nil field keeps the stored value, and so does an empty secret.
function applyPatch(e, p) {
  if (p.name != null) e.name = p.name;
  if (p.address != null) e.address = p.address;
  if (p.secret != null && p.secret.trim() !== '') e.secret = p.secret;
  if (p.selfSigned != null) e.selfSigned = p.selfSigned;
  if (p.pin != null) e.pin = p.pin;
}
const linkGiven = (p) => p.address != null || p.secret != null || p.selfSigned != null || p.pin != null;

class Manager {
  constructor({ stateDir, local, timing, log, dial, roots }) {
    ensureStateDir(stateDir);
    this.stateDir = stateDir;
    this.timing = withDefaults(timing);
    this.log = log || (() => {});
    this.dial = dial;
    this.roots = roots;
    this.clientId = clientId(stateDir);
    this.list = List.open(stateDir);
    this.conns = new Map();
    this.localConn = null;
    this.localInstanceId = '';
    this.sub = null;
    this.closed = false;
    this.save = new Mutex();
    if (local) this.localConn = new LocalConn(this, new Starter(this, local));
    for (const e of this.list.all()) this.conns.set(e.id, new Conn(this, e, null));
  }

  isCurrent(conn) {
    return !this.closed && (conn === this.localConn || this.conns.get(conn.id) === conn);
  }

  connFor(id) {
    if (id === LOCAL_ID) return this.localConn;
    return this.conns.get(id) || null;
  }

  emit(env) {
    const sub = this.sub;
    if (!sub || sub.closed) return;
    try { sub.cb(env); } catch (err) { this.log(`subscriber: ${err && err.message}`); }
  }

  views() {
    const out = [];
    if (this.localConn) out.push(this.localConn.view());
    for (const e of this.list.all()) {
      const c = this.conns.get(e.id);
      if (c) out.push(c.view());
    }
    return out;
  }

  listChanged() {
    this.emit({ app: { type: 'servers', servers: this.views(), notice: this.list.notice } });
  }

  // setLocalInstance records the instance id of this computer's server. A remote entry that turned
  // out to be the same server is made to connect again, which then finds it is local.
  setLocalInstance(id) {
    if (!id || this.localInstanceId === id) return;
    this.localInstanceId = id;
    for (const c of this.conns.values()) {
      const e = this.list.get(c.id);
      if (e && e.instanceId === id && c.link) c.link.stop();
    }
  }

  // claim is the identity check of a connect, with the id a valid hello of the entry's server gave:
  // the refusal is is_local, duplicate (with the other entry's name), another_server or ''. The
  // first id an entry's server gives is stored in the list, in the same step, so that of two
  // entries with one server the second is refused. current is false for a connection that was
  // replaced or removed.
  claim(c, instanceId) {
    const e = this.list.get(c.id);
    if (!e || !this.isCurrent(c)) return { refusal: '', name: '', current: false };
    if (this.localInstanceId && instanceId === this.localInstanceId) return { refusal: 'is_local', name: '', current: true };
    const name = this.holder(instanceId, c.id);
    if (name !== null) return { refusal: 'duplicate', name, current: true };
    if (!e.instanceId) {
      // A write that fails leaves the entry without its id: the next connect stores it.
      try { this.list.update(c.id, (x) => { x.instanceId = instanceId; }); } catch { /* stored at the next connect */ }
    } else if (e.instanceId !== instanceId) {
      return { refusal: 'another_server', name: '', current: true };
    }
    return { refusal: '', name: '', current: true };
  }

  // subscribe opens the streams: first the list and the state of every entry, then, for each
  // entry on its own, its events as they come (plan C3.4). A new subscription ends the old one.
  subscribe(cb) {
    if (this.closed) throw new Error('the client is closed');
    if (this.sub) this.endSub(this.sub);
    const sub = { cb, closed: false };
    this.sub = sub;
    queueMicrotask(() => {
      if (sub.closed) return;
      this.emit({ app: { type: 'servers', servers: this.views(), notice: this.list.notice } });
      for (const v of this.views()) this.emit({ app: { type: 'server_state', server: v } });
      for (const c of this.allConns()) c.start();
    });
    return { close: () => this.endSub(sub) };
  }

  allConns() {
    return [...(this.localConn ? [this.localConn] : []), ...this.conns.values()];
  }

  endSub(sub) {
    if (sub.closed) return;
    sub.closed = true;
    if (this.sub === sub) {
      this.sub = null;
      for (const c of this.allConns()) c.stop();
    }
  }

  // connect makes the connection of e, in the state connecting, in place of the entry's so far.
  connect(e) {
    const old = this.conns.get(e.id);
    const c = new Conn(this, e, old);
    if (old) old.stop();
    this.conns.set(e.id, c);
    if (this.sub) c.start();
    return c;
  }

  async close() {
    if (this.closed) return;
    const sub = this.sub;
    if (sub) this.endSub(sub);
    this.closed = true;
    await Promise.all(this.allConns().map((c) => c.stop()));
  }

  // ---- the operations ----

  // identity is what a test of the entry except, or of an unsaved form when except is "", compares
  // the answering server's id with.
  identity(except) {
    const id = { localId: this.localInstanceId, others: {}, expect: '' };
    for (const e of this.list.all()) {
      if (e.id === except) id.expect = e.instanceId;
      else if (e.instanceId) id.others[e.instanceId] = e.name;
    }
    return id;
  }

  holder(instanceId, except) {
    const e = this.list.all().find((x) => x.id !== except && x.instanceId === instanceId);
    return e ? e.name : null;
  }

  test(target, ident) {
    return testConnection(this, target, ident);
  }

  // duplicateResult is the test result that refuses a save for an id another entry got meanwhile.
  static duplicateResult(r, name) {
    return { ...r, ok: false, step: 4, outcome: 'duplicate', message: `Already added as ${name}` };
  }

  async add({ form, force } = {}) {
    if (!formOk(form)) return badRequest();
    return this.save.run(async () => {
      let e;
      try {
        e = this.list.vet({ name: str(form.name), address: str(form.address), secret: str(form.secret), selfSigned: form.selfSigned === true, pin: str(form.pin), instanceId: '' });
      } catch (err) {
        return serverFail(err, 'added');
      }
      let r = null;
      if (!force) {
        r = await this.test(targetOf(e), this.identity(''));
        if (!r.ok) return { status: 200, body: { saved: false, result: r } };
        e.instanceId = r.instanceId;
      }
      if (e.instanceId) {
        const name = this.holder(e.instanceId, ''); // a connect stored it during the test
        if (name !== null) return { status: 200, body: { saved: false, result: Manager.duplicateResult(r, name) } };
      }
      let saved;
      try {
        saved = this.list.add(e);
      } catch (err) {
        return serverFail(err, 'added');
      }
      const c = this.connect(saved);
      this.listChanged();
      const body = { saved: true, server: c.view() };
      if (r) body.result = r;
      return { status: 200, body };
    });
  }

  async edit({ id, patch, force } = {}) {
    if (id === LOCAL_ID) return serverFail(ERR.local(), 'edited');
    const p = patch === undefined || patch === null ? {} : patch;
    if (!formOk(p)) return badRequest();
    return this.save.run(async () => {
      const old = this.list.get(id);
      if (!old) return serverFail(ERR.notFound(), 'edited');
      let next = { ...old };
      applyPatch(next, p);
      try {
        next = this.list.vet(next);
      } catch (err) {
        return serverFail(err, 'edited');
      }
      let r = null;
      let instanceId = '';
      if (!sameLink(old, next) && !force) {
        r = await this.test(targetOf(next), this.identity(id));
        if (!r.ok) return { status: 200, body: { saved: false, result: r } };
        instanceId = r.instanceId;
      }
      if (instanceId) {
        const name = this.holder(instanceId, id);
        if (name !== null) return { status: 200, body: { saved: false, result: Manager.duplicateResult(r, name) } };
      }
      let e;
      try {
        e = this.list.update(id, (x) => {
          applyPatch(x, p);
          if (!x.instanceId) x.instanceId = instanceId;
        });
      } catch (err) {
        return serverFail(err, 'edited');
      }
      // The connection is replaced when it is made from other values now. With the same values it
      // stays, but for one that is not up when the form gave them again: an edit leaves a stopped state.
      const c = this.conns.get(id);
      let view;
      if (!c || !sameLink(Manager.entryLink(c), e) ||
        (linkGiven(p) && c.shown.state !== 'connected' && c.shown.state !== 'connecting')) view = this.connect(e).view();
      else view = c.view();
      this.listChanged();
      const body = { saved: true, server: view };
      if (r) body.result = r;
      return { status: 200, body };
    });
  }

  // entryLink is the link a connection was made from.
  static entryLink(c) {
    const t = c.target;
    return { address: t.address, secret: t.secret, selfSigned: t.selfSigned, pin: t.pin };
  }

  async remove({ id } = {}) {
    if (id === LOCAL_ID) return serverFail(ERR.local(), 'removed');
    return this.save.run(async () => {
      try {
        this.list.remove(id);
      } catch (err) {
        return serverFail(err, 'removed');
      }
      const c = this.conns.get(id);
      this.conns.delete(id);
      if (c) { c.removed = true; c.stop(); }
      this.listChanged();
      return { status: 200, body: { ok: true } };
    });
  }

  async accept({ id, fingerprint } = {}) {
    if (id === LOCAL_ID) return serverFail(ERR.local(), 'accepted');
    if (normalFingerprint(fingerprint) === null) return serverFail(ERR.badPin(), 'accepted');
    return this.save.run(async () => {
      let e;
      try {
        e = this.list.update(id, (x) => { x.selfSigned = true; x.pin = fingerprint; });
      } catch (err) {
        return serverFail(err, 'accepted');
      }
      const c = this.connect(e);
      this.listChanged();
      return { status: 200, body: { server: c.view() } };
    });
  }

  testForm({ form } = {}) {
    if (!formOk(form)) return badRequest();
    return this.test({ address: str(form.address), secret: str(form.secret), selfSigned: form.selfSigned === true, pin: str(form.pin) }, this.identity(''))
      .then((body) => ({ status: 200, body }));
  }

  // testSaved tests the saved entry with the fields of over in place of the stored ones: a nil
  // field, and an empty address or secret, takes the stored value. When what was tested is what is
  // stored, the entry's connection then tries again, which leaves a stopped state.
  async testSaved({ id, over } = {}) {
    if (id === LOCAL_ID) return serverFail(ERR.local(), 'tested');
    const o = over === undefined || over === null ? {} : over;
    if (!formOk(o)) return badRequest();
    const e = this.list.get(id);
    if (!e) return serverFail(ERR.notFound(), 'tested');
    const t = targetOf(e);
    if (o.address != null && o.address.trim() !== '') t.address = o.address;
    if (o.secret != null && o.secret.trim() !== '') t.secret = o.secret.trim();
    if (o.selfSigned != null) t.selfSigned = o.selfSigned;
    if (o.pin != null) t.pin = o.pin;
    const r = await this.test(t, this.identity(id));
    let same = false;
    try {
      same = sameLink(this.list.vet({ ...e, ...t, id: e.id }), e);
    } catch { /* what was tested is not storable, so it is not what is stored */ }
    if (same) {
      const c = this.conns.get(id);
      if (c) c.retry();
    }
    return { status: 200, body: r };
  }

  // app answers an operation of the app: {status, body}. Never rejects.
  async app(op, args) {
    try {
      switch (op) {
        case 'servers.list': return { status: 200, body: { servers: this.views(), notice: this.list.notice } };
        case 'servers.add': return await this.add(args);
        case 'servers.edit': return await this.edit(args);
        case 'servers.remove': return await this.remove(args);
        case 'servers.test': return await this.testForm(args);
        case 'servers.testSaved': return await this.testSaved(args);
        case 'servers.accept': return await this.accept(args);
        default: {
          if (typeof op === 'string' && op.startsWith('owner.')) {
            const a = await ownerOp(this, op, args);
            if (a) return a;
          }
          return { status: 404, body: { error: 'this app does not know that operation', code: 'no_op' } };
        }
      }
    } catch (err) {
      return { status: 500, body: { error: String(err && err.message) } };
    }
  }

  // call and picture reject only with an AbortError; a failure of the module itself is a 500.
  async call(req) {
    try {
      return await call(this, req);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      this.log(`call: ${err && err.message}`);
      return { status: 500, text: JSON.stringify({ error: 'the app could not make the call', code: 'internal_error' }), sceneRev: null };
    }
  }

  async picture(req) {
    try {
      return await picture(this, req);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      this.log(`picture: ${err && err.message}`);
      return { ok: false, status: 500, text: JSON.stringify({ error: 'the app could not fetch the picture', code: 'internal_error' }) };
    }
  }
}

module.exports = { Manager };
