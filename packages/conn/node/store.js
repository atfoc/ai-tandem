'use strict';

// The Store over files (the desktop's and the test host's): <stateDir>/servers.json holds the
// entries with their secrets, mode 0600, written atomically; <stateDir>/client-id the app's id. The
// checks of the list are core/list.js's; this only reads, writes and sets aside.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CLIENT_ID } = require('../core/list');

const FILE_NAME = 'servers.json';

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

// fileStore is the Store of stateDir. now is the clock of the name an unreadable file is set aside
// under (a test seam). It makes no folder: the first write does, as createNodeClient does at once.
function fileStore(stateDir, { now = () => new Date() } = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('server list: no state folder');
  const file = path.join(stateDir, FILE_NAME);
  return {
    where: file,

    // read: null for a missing or empty file. A file that cannot be read, or holds no JSON object,
    // throws (the List then sets it aside with the error's code or text as the reason).
    read() {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      if (text.trim() === '') return null;
      const raw = JSON.parse(text);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      return raw;
    },

    write(list) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(file, JSON.stringify(list, null, 2) + '\n', 0o600);
    },

    // setAside renames the file to servers.json.unreadable-<UTC time>, -2, -3… when that is taken.
    setAside() {
      const base = `${FILE_NAME}.unreadable-${stamp(now())}`;
      for (let n = 1; ; n++) {
        const candidate = n > 1 ? `${base}-${n}` : base;
        const to = path.join(stateDir, candidate);
        if (fs.existsSync(to)) continue;
        fs.renameSync(file, to);
        return candidate;
      }
    },

    clientId: () => clientId(stateDir),
  };
}

module.exports = { FILE_NAME, fileStore, clientId, ensureStateDir, writeFileAtomic };
