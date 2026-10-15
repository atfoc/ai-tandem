'use strict';

// The server list (port of internal/servers/list.go): the entries with their secrets, checked as a
// new one is, kept by the Store port (servers.json on the desktop, the app's storage on a phone),
// which saves the whole list before it changes here. This computer's entry is never in it.

const { parseAddress } = require('./address');
const { LOCAL_ID } = require('./outcomes');

const FILE_VERSION = 1; // of the saved list; a list of a later one is not read
const MAX_NAME = 80; // characters
const MAX_SECRET = 256; // printable ASCII characters

// A refusal of the list: code is the one the answers carry, text the sentence.
class ListError extends Error {
  constructor(code, text, extra = {}) {
    super(text);
    this.name = 'ListError';
    this.code = code;
    Object.assign(this, extra);
  }
}
const ERR = {
  local: () => new ListError('local_entry', 'this computer is not an entry of the server list'),
  notFound: () => new ListError('not_found', 'no such server'),
  badName: () => new ListError('bad_name', 'the name must have 1 to 80 characters'),
  badAddress: () => new ListError('bad_address', 'not a valid https address: https://host:port'),
  badSecret: () => new ListError('bad_secret', 'the secret must have 1 to 256 characters and no spaces'),
  badPin: () => new ListError('bad_pin', 'not a SHA-256 fingerprint'),
  duplicate: (name) => new ListError('duplicate', `already added as ${name}`, { other: name }),
};

const ENTRY_ID = /^s_[0-9a-f]{12}$/;

// parseFingerprint reads a SHA-256 fingerprint, with or without ":", in any case. It returns the
// normalised form (uppercase pairs joined by ":") or null.
function normalFingerprint(s) {
  if (typeof s !== 'string') return null;
  const h = s.trim().replace(/:/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null;
  return h.toUpperCase().match(/../g).join(':');
}

// normalPin is "" without the box or without a pin, else the pin in the normal form.
function normalPin(selfSigned, pin) {
  if (!selfSigned || typeof pin !== 'string' || pin.trim() === '') return '';
  const n = normalFingerprint(pin);
  if (n === null) throw ERR.badPin();
  return n;
}

// checkFields normalizes e's name, address, secret and pin in place and refuses a bad one.
function checkFields(e) {
  e.name = typeof e.name === 'string' ? e.name.trim() : '';
  const n = [...e.name].length;
  if (n < 1 || n > MAX_NAME || (e.name.isWellFormed && !e.name.isWellFormed())) throw ERR.badName();
  const a = parseAddress(e.address);
  if (!a) throw ERR.badAddress();
  e.address = a.address;
  e.secret = typeof e.secret === 'string' ? e.secret.trim() : '';
  if (e.secret.length < 1 || e.secret.length > MAX_SECRET || !/^[\x21-\x7e]+$/.test(e.secret)) throw ERR.badSecret();
  e.selfSigned = e.selfSigned === true;
  e.pin = normalPin(e.selfSigned, e.pin);
  e.instanceId = typeof e.instanceId === 'string' ? e.instanceId : '';
}

// parseList reads a saved list. Unknown fields are ignored; a version after this build's and any
// invalid entry are errors: an entry has to pass the checks a new one passes.
function parseList(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const version = raw.version === undefined ? 0 : raw.version;
  if (typeof version !== 'number') throw new Error('bad version');
  if (version > FILE_VERSION) throw new Error(`version ${version} is after this build's ${FILE_VERSION}`);
  if (raw.servers === undefined || raw.servers === null) return [];
  if (!Array.isArray(raw.servers)) throw new Error('servers: not a list');
  const seen = new Set();
  return raw.servers.map((x, i) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error(`entry ${i + 1}: not an object`);
    const e = {
      id: x.id, name: x.name, address: x.address, secret: x.secret,
      selfSigned: x.selfSigned, pin: x.pin, instanceId: x.instanceId,
    };
    if (typeof e.id !== 'string' || !ENTRY_ID.test(e.id)) throw new Error(`entry ${i + 1}: bad id`);
    if (seen.has(e.id)) throw new Error(`entry ${i + 1}: duplicate id`);
    seen.add(e.id);
    try {
      checkFields(e);
    } catch (err) {
      if (!(err instanceof ListError)) throw err;
      throw new Error(`entry ${i + 1}: ${err.code.replace('_', ' ')}`); // never the secret itself
    }
    return e;
  });
}

// why is the text of a failure of the Store: its code when it has one, else its message.
const why = (err) => String((err && (err.code || err.message)) || err);

// randomHex is n random bytes as lower-case hex; random fills a Uint8Array (as crypto.getRandomValues).
function randomHex(random, n) {
  const b = new Uint8Array(n);
  random(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

const defaultRandom = (a) => globalThis.crypto.getRandomValues(a);

// List holds the server list in memory and has the Store save it before every change.
class List {
  constructor(store, random = defaultRandom) {
    this.store = store;
    this.random = random;
    this.entries = [];
    this.notice = '';
    this.stuck = null; // the saved list could not be set aside: every write throws this
  }

  // open reads the saved list. None saved gives a list without entries, and nothing is written. A
  // saved list that cannot be read is set aside (kept under another name, never deleted) and the
  // list starts without entries; notice says so. It never dials.
  static open(store, { random } = {}) {
    if (!store) throw new Error('server list: no store');
    const l = new List(store, random);
    let raw;
    try {
      raw = store.read();
    } catch (err) {
      l.setAside(why(err));
      return l;
    }
    if (raw === null || raw === undefined) return l;
    try {
      l.entries = parseList(raw);
    } catch (err) {
      l.entries = [];
      l.setAside(err.message);
    }
    return l;
  }

  // setAside has the Store put the unreadable list out of the way and keeps one sentence as the
  // notice. When that fails the list works in memory and no write goes through.
  setAside(reason) {
    const where = this.store.where;
    let name = '';
    let failure = null;
    try {
      name = this.store.setAside(reason);
    } catch (err) {
      failure = why(err);
    }
    if (failure) {
      this.stuck = new Error(`server list: ${where} cannot be read and could not be set aside: ${failure}`);
      this.notice = `server list: ${where} cannot be read (${reason}); it could not be set aside (${failure}); starting with this computer only`;
    } else {
      this.notice = `server list: ${where} cannot be read (${reason}); set aside as ${name}; starting with this computer only`;
    }
  }

  all() { return this.entries.map((e) => ({ ...e })); }

  get(id) {
    const e = this.entries.find((x) => x.id === id);
    return e ? { ...e } : undefined;
  }

  // vet is the form checks of an entry without a write: e normalized, or the error add and update
  // would throw. An e.id names the entry that is edited, which may keep its own address.
  vet(e) {
    e = { ...e };
    this.check(e);
    return e;
  }

  check(e) {
    checkFields(e);
    const o = this.entries.find((x) => x.id !== e.id && x.address === e.address);
    if (o) throw ERR.duplicate(o.name);
  }

  // add checks e, gives it a new id (e.id is ignored), appends it and writes the file.
  add(e) {
    e = { ...e, id: '' };
    this.check(e);
    let id;
    do id = 's_' + randomHex(this.random, 6); while (this.entries.some((x) => x.id === id));
    e.id = id;
    this.write([...this.entries, e]);
    return { ...e };
  }

  // update runs f on a copy of the entry, checks the result and writes the file. The id stays
  // whatever f does. When f or a check throws, nothing changes.
  update(id, f) {
    if (id === LOCAL_ID) throw ERR.local();
    const i = this.entries.findIndex((x) => x.id === id);
    if (i < 0) throw ERR.notFound();
    const e = { ...this.entries[i] };
    f(e);
    e.id = id;
    this.check(e);
    const next = [...this.entries];
    next[i] = e;
    this.write(next);
    return { ...e };
  }

  remove(id) {
    if (id === LOCAL_ID) throw ERR.local();
    const i = this.entries.findIndex((x) => x.id === id);
    if (i < 0) throw ERR.notFound();
    this.write(this.entries.filter((x) => x.id !== id));
  }

  // write has the Store save entries (atomically) and only then makes them the list.
  write(entries) {
    if (this.stuck) throw this.stuck;
    const out = { version: FILE_VERSION, servers: entries.map((e) => ({
      id: e.id, name: e.name, address: e.address, secret: e.secret,
      selfSigned: e.selfSigned, pin: e.pin, instanceId: e.instanceId,
    })) };
    this.store.write(out);
    this.entries = entries;
  }
}

// CLIENT_ID is the form of the app's id, the X-AIWB-Client of every request of this app to every
// server: a lower-case UUID v4, which the Store makes once and keeps.
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

module.exports = {
  FILE_VERSION, CLIENT_ID, List, ListError, ERR, checkFields, normalPin, normalFingerprint, parseList,
};
