'use strict';

// The server list file (port of internal/servers/list.go): <stateDir>/servers.json holds the
// entries with their secrets, mode 0600, written atomically. This computer's entry is never in it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseAddress } = require('./address');
const { LOCAL_ID } = require('./outcomes');

const FILE_NAME = 'servers.json';
const FILE_VERSION = 1; // of servers.json; a file of a later one is not read
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

// parseList reads the file's text. Unknown fields are ignored; a version after this build's and
// any invalid entry are errors: an entry has to pass the checks a new one passes.
function parseList(text) {
  const raw = JSON.parse(text);
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

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// writeFileAtomic writes the file next to path and renames it over path, with the mode.
function writeFileAtomic(file, data, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// List holds servers.json in memory and writes it back after every change.
class List {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.notice = '';
    this.stuck = null; // the file could not be set aside: every write throws this
  }

  // open reads <root>/servers.json. A missing or empty file gives a list without entries, and
  // nothing is written. A file that cannot be read is set aside (renamed beside itself, never
  // deleted) and the list starts without entries; notice says so. It never dials.
  static open(root, now = () => new Date()) {
    if (!root) throw new Error('server list: no state folder');
    const l = new List(path.join(root, FILE_NAME));
    let text;
    try {
      text = fs.readFileSync(l.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return l;
      l.setAside(err.code || err.message, now);
      return l;
    }
    if (text.trim() === '') return l;
    try {
      l.entries = parseList(text);
    } catch (err) {
      l.entries = [];
      l.setAside(err.message, now);
    }
    return l;
  }

  // setAside renames the unreadable file to servers.json.unreadable-<UTC time> and keeps one
  // sentence as the notice. When the rename fails the list works in memory and no write goes through.
  setAside(why, now) {
    const base = `${FILE_NAME}.unreadable-${stamp(now())}`;
    let name = '';
    let failure = null;
    for (let n = 1; ; n++) {
      const candidate = n > 1 ? `${base}-${n}` : base;
      const to = path.join(path.dirname(this.file), candidate);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(this.file, to);
        name = candidate;
      } catch (err) {
        failure = err.code || err.message;
      }
      break;
    }
    if (failure) {
      this.stuck = new Error(`server list: ${this.file} cannot be read and could not be set aside: ${failure}`);
      this.notice = `server list: ${this.file} cannot be read (${why}); it could not be set aside (${failure}); starting with this computer only`;
    } else {
      this.notice = `server list: ${this.file} cannot be read (${why}); set aside as ${name}; starting with this computer only`;
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
    do id = 's_' + crypto.randomBytes(6).toString('hex'); while (this.entries.some((x) => x.id === id));
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

  // write saves entries (mode 0600, atomically) and only then makes them the list.
  write(entries) {
    if (this.stuck) throw this.stuck;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const out = { version: FILE_VERSION, servers: entries.map((e) => ({
      id: e.id, name: e.name, address: e.address, secret: e.secret,
      selfSigned: e.selfSigned, pin: e.pin, instanceId: e.instanceId,
    })) };
    writeFileAtomic(this.file, JSON.stringify(out, null, 2) + '\n', 0o600);
    this.entries = entries;
  }
}

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// clientId is the app's id: a lowercase UUID v4 in <stateDir>/client-id, made once (mode 0600). It
// is the X-AIWB-Client of every request of this app to every server.
function clientId(root) {
  const file = path.join(root, 'client-id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (CLIENT_ID.test(id)) return id;
  } catch { /* made below */ }
  const id = crypto.randomUUID();
  writeFileAtomic(file, id + '\n', 0o600);
  return id;
}

// ensureStateDir makes the folder of the files, mode 0700, when it is missing.
function ensureStateDir(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}

module.exports = {
  FILE_NAME, List, ListError, ERR, checkFields, normalPin, normalFingerprint, clientId, ensureStateDir, writeFileAtomic,
};
