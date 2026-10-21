'use strict';

// The desktop's voice face (voice-chats architecture VC-3, VC-4, VC-5): the main process makes every call to the voice
// service (ElevenLabs), because the key never enters the page. It keeps the key file, relays the page's requests and
// sockets with the key in a header, answers the microphone's questions and permits the page's microphone. The page's side is
// preload.js (window.aiwbVoice, app/src/voice/platform/bridge.types.ts); ipcface.js registers this on the channels. Nothing
// here imports electron: the electron objects are given, so `node --test` can load this file with fakes.
//
// Only the calls of VC-5's table are made, with only the query keys of the table, and nothing else is ever sent with the key.
// What crosses back to the page is a status, bytes of an answer's body, the text of a socket's frames and fixed words for a
// failure: never the key, a header, an address or the text of the network library's error.

const path = require('node:path');
const fs = require('node:fs');
const { atPage } = require('./lib');

const VOICE_HTTP = 'https://api.elevenlabs.io';
const VOICE_WS = 'wss://api.elevenlabs.io';
const KEY_FILE = 'voice-key';

const MIC_SETTINGS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone',
};

const TTS_PATH = /^\/v1\/text-to-speech\/[A-Za-z0-9]{1,64}\/stream$/;
const VOICES_PATH = '/v2/voices';
const STT_PATH = '/v1/speech-to-text/realtime';
const TTS_QUERY = new Set(['output_format']);
const VOICES_QUERY = new Set(['page_size', 'next_page_token', 'search', 'sort', 'sort_direction', 'include_total_count']);
const STT_QUERY = new Set(['model_id', 'audio_format', 'language_code', 'commit_strategy', 'vad_silence_threshold_secs', 'include_timestamps']);

// A key is what a header can carry: printable ASCII without a space. ElevenLabs keys are shorter than this.
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;
const MAX_ID = 0x7fffffff;
const MAX_QUERY_VALUE = 512;
const MAX_JSON = 16 * 1024;
const MAX_FRAME = 256 * 1024;
const MAX_REQUESTS = 32;
const MAX_SOCKETS = 2;
const MAX_VOICES_BODY = 8 * 1024 * 1024;
const MAX_PREVIEW_URLS = 10000;
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 15000;

// What a failing call throws: one of these words, never more. The page's preload passes the word on.
//
//   voice_refused      the call is not one the page may make
//   voice_no_key       there is no key on this computer (and none was given for the call)
//   voice_unreachable  the service was not reached, or the network library failed
//   voice_cancelled    the page cancelled the call
//   voice_failed       anything else
class VoiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceError';
  }
}
const refused = () => new VoiceError('voice_refused');

// isLoopbackHost says whether a URL's hostname is this computer's own.
function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

// serviceBase says where the service is: the two constants, unless the app is not packaged and AIWB_VOICE_BASE names a
// loopback address (the stand-in voice service of the tests, `http://127.0.0.1:<port>/voice`). A packaged app ignores it.
// dev says the base is the stand-in's, so that a preview clip of its own origin may be plain http.
function serviceBase({ env, isPackaged }) {
  const own = { http: VOICE_HTTP, ws: VOICE_WS, dev: false, origin: null };
  const value = env && env.AIWB_VOICE_BASE;
  if (isPackaged || typeof value !== 'string' || value === '') return own;
  let u;
  try {
    u = new URL(value);
  } catch {
    return own;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLoopbackHost(u.hostname)) return own;
  if (u.username || u.password || u.search || u.hash) return own;
  const prefix = u.pathname.replace(/\/+$/, '');
  const root = `${u.protocol}//${u.host}${prefix}`;
  return { http: root, ws: root.replace(/^http/, 'ws'), dev: true, origin: u.origin };
}

// queryString reads the page's query into a string, or throws: only keys of allowed, only string values.
function queryString(query, allowed) {
  if (query === undefined || query === null) return '';
  if (typeof query !== 'object' || Array.isArray(query)) throw refused();
  const params = new URLSearchParams();
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (!allowed.has(k) || typeof v !== 'string' || v.length > MAX_QUERY_VALUE) throw refused();
    params.append(k, v);
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const validId = (id) => Number.isInteger(id) && id > 0 && id <= MAX_ID;

// createVoice makes the voice face of the main process:
//
//   handle(op, args)   the page's calls (channel aiwb:voice), each answered or rejected with a VoiceError
//   cancel(id)         ends a request (aiwb:voice-cancel)
//   socketSend(id, text), socketClose(id)    a socket's frames and end (aiwb:voice-send)
//   closeAll()         ends every request and socket, with no event: the page is gone
//
// app has isPackaged; systemPreferences, the microphone's calls on macOS and Windows; shell, openExternal; userData, the
// app's data folder (the key is <userData>/client/voice-key); emit(event) delivers an event to the page. The rest are seams
// of the tests: the environment, the platform, fetch, WebSocket and the file functions of @aiwb/conn/node.
function createVoice({
  app, systemPreferences, shell, userData, emit,
  env = process.env, platform = process.platform,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  files = require('@aiwb/conn/node'),
}) {
  const base = serviceBase({ env, isPackaged: app.isPackaged });
  const dir = path.join(userData, 'client');
  const keyFile = path.join(dir, KEY_FILE);
  // requests and sockets by the page's id; one id names one of them at a time.
  const requests = new Map();
  const sockets = new Map();
  // The preview clips main may fetch: the preview_url of every voice of a /v2/voices answer it relayed.
  const previews = new Set();

  const inUse = (id) => requests.has(id) || sockets.has(id);

  // ---- the key

  // readKey reads the key file, at each call and never earlier. null when there is none.
  function readKey() {
    let text;
    try {
      text = fs.readFileSync(keyFile, 'utf8');
    } catch {
      return null;
    }
    const key = text.trim();
    return KEY_SHAPE.test(key) ? key : null;
  }

  // keyFor is the key of one call: the one the page gave (a key that is not stored yet), else the file's.
  function keyFor(given) {
    if (given !== undefined) {
      if (typeof given !== 'string' || !KEY_SHAPE.test(given.trim())) throw refused();
      return given.trim();
    }
    const key = readKey();
    if (!key) throw new VoiceError('voice_no_key');
    return key;
  }

  function setKey(args) {
    const key = args && typeof args.key === 'string' ? args.key.trim() : '';
    if (!KEY_SHAPE.test(key)) throw refused();
    files.ensureStateDir(dir);
    files.writeFileAtomic(keyFile, `${key}\n`, 0o600);
  }

  // ---- requests

  // checkRequest reads a request of the page into { method, url, body }, or throws.
  function checkRequest(req) {
    if (!req || typeof req !== 'object' || !validId(req.id) || typeof req.path !== 'string') throw refused();
    let allowed;
    let body;
    if (req.method === 'POST' && TTS_PATH.test(req.path)) {
      allowed = TTS_QUERY;
      body = req.json === undefined ? undefined : JSON.stringify(req.json);
      if (typeof body !== 'string' || body.length > MAX_JSON || req.json === null || typeof req.json !== 'object') throw refused();
    } else if (req.method === 'GET' && req.path === VOICES_PATH) {
      allowed = VOICES_QUERY;
      if (req.json !== undefined) throw refused();
    } else {
      throw refused();
    }
    return { method: req.method, url: base.http + req.path + queryString(req.query, allowed), body };
  }

  async function request(req) {
    const { method, url, body } = checkRequest(req);
    const { id } = req;
    if (inUse(id) || requests.size >= MAX_REQUESTS) throw refused();
    const key = keyFor(req.key);
    const mine = new AbortController();
    requests.set(id, mine);
    const headers = { 'xi-api-key': key };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: mine.signal, redirect: 'error' });
    } catch {
      const cancelled = mine.signal.aborted;
      if (requests.get(id) === mine) requests.delete(id);
      throw new VoiceError(cancelled ? 'voice_cancelled' : 'voice_unreachable');
    }
    // The body follows the answer: after this call has returned.
    const voices = method === 'GET' && res.status === 200;
    setImmediate(() => pump(id, mine, res, voices));
    return { status: res.status };
  }

  // pump sends the body of an answer as `data` events and then `end`, or `error`. For a voices answer it also reads the
  // preview addresses, before `end`, so that a clip can be asked for as soon as the page has the list.
  async function pump(id, mine, res, voices) {
    const current = () => requests.get(id) === mine;
    const kept = voices ? [] : null;
    let size = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          if (!current()) return;
          const bytes = new Uint8Array(chunk);
          if (kept) {
            size += bytes.length;
            if (size <= MAX_VOICES_BODY) kept.push(bytes);
          }
          emit({ id, kind: 'data', bytes });
        }
      }
      if (!current()) return;
      if (kept && size <= MAX_VOICES_BODY) learnPreviews(kept);
      emit({ id, kind: 'end' });
    } catch {
      if (current()) emit({ id, kind: 'error' });
    } finally {
      if (current()) requests.delete(id);
    }
  }

  // learnPreviews remembers the preview_url of each voice of an answer (its body in pieces). An answer that is not the
  // list changes nothing.
  function learnPreviews(pieces) {
    let list;
    try {
      list = JSON.parse(Buffer.concat(pieces).toString('utf8')).voices;
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const v of list) {
      const url = v && v.preview_url;
      if (typeof url !== 'string' || previews.size >= MAX_PREVIEW_URLS) continue;
      if (previewAllowedScheme(url)) previews.add(url);
    }
  }

  // previewAllowedScheme: https only; the stand-in's own origin (AIWB_VOICE_BASE, an unpackaged app) may be plain http.
  function previewAllowedScheme(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol === 'https:') return true;
    return base.dev && u.origin === base.origin;
  }

  async function preview(args) {
    const url = args && args.url;
    if (typeof url !== 'string' || !previews.has(url)) throw refused();
    try {
      const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) });
      if (res.status !== 200 || !res.body) throw new Error('no clip');
      const declared = Number(res.headers.get('content-length'));
      if (declared > PREVIEW_MAX_BYTES) throw new Error('too big');
      const pieces = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > PREVIEW_MAX_BYTES) throw new Error('too big');
        pieces.push(chunk);
      }
      return new Uint8Array(Buffer.concat(pieces));
    } catch {
      throw new VoiceError('voice_unreachable');
    }
  }

  function cancel(id) {
    const ac = requests.get(id);
    if (!ac) return;
    requests.delete(id);
    ac.abort();
  }

  // ---- sockets

  function socketOpen(args) {
    if (!args || !validId(args.id) || args.path !== STT_PATH) throw refused();
    const { id } = args;
    const url = base.ws + STT_PATH + queryString(args.query, STT_QUERY);
    if (inUse(id) || sockets.size >= MAX_SOCKETS) throw refused();
    const key = keyFor(undefined);
    let ws;
    try {
      ws = new WebSocketImpl(url, { headers: { 'xi-api-key': key } });
    } catch {
      throw new VoiceError('voice_unreachable');
    }
    const mine = { ws, silent: false };
    sockets.set(id, mine);
    return new Promise((resolve, reject) => {
      let opened = false;
      const live = () => sockets.get(id) === mine;
      ws.addEventListener('open', () => {
        opened = true;
        if (live() && !mine.silent) emit({ id, kind: 'open' });
        resolve();
      });
      ws.addEventListener('message', (e) => {
        // Text frames only: the service speaks JSON text.
        if (live() && !mine.silent && typeof e.data === 'string') emit({ id, kind: 'message', text: e.data });
      });
      ws.addEventListener('close', (e) => {
        const wasLive = live();
        if (wasLive) sockets.delete(id);
        if (!opened) {
          reject(new VoiceError(mine.silent ? 'voice_cancelled' : 'voice_unreachable'));
          return;
        }
        if (wasLive && !mine.silent) emit({ id, kind: 'close', code: Number.isInteger(e.code) ? e.code : 1006 });
      });
      // An error is followed by a close, which says it.
      ws.addEventListener('error', () => {});
    });
  }

  function socketSend(id, text) {
    const s = sockets.get(id);
    if (!s || typeof text !== 'string' || text.length > MAX_FRAME || s.ws.readyState !== 1) return;
    try {
      s.ws.send(text);
    } catch { /* the close event says it */ }
  }

  function socketClose(id) {
    const s = sockets.get(id);
    if (!s) return;
    try {
      s.ws.close(1000);
    } catch { /* already closing */ }
  }

  // ---- the microphone

  const hasMicCalls = platform === 'darwin' || platform === 'win32';

  async function micStatus() {
    if (!hasMicCalls) return 'granted';
    const s = systemPreferences.getMediaAccessStatus('microphone');
    return s === 'granted' || s === 'denied' || s === 'restricted' ? s : 'undetermined';
  }

  async function micAsk() {
    if (platform !== 'darwin') return true;
    return Boolean(await systemPreferences.askForMediaAccess('microphone'));
  }

  async function micOpenSettings() {
    const url = MIC_SETTINGS[platform];
    if (url) await shell.openExternal(url);
  }

  // ---- the page's calls

  const OPS = {
    'key.has': async () => readKey() !== null,
    'key.set': async (args) => { setKey(args); },
    'key.clear': async () => { fs.rmSync(keyFile, { force: true }); },
    request,
    'socket.open': socketOpen,
    preview,
    'mic.status': micStatus,
    'mic.ask': micAsk,
    'mic.openSettings': micOpenSettings,
  };

  async function handle(op, args) {
    if (typeof op !== 'string' || !Object.hasOwn(OPS, op)) throw refused();
    try {
      return await OPS[op](args);
    } catch (err) {
      throw err instanceof VoiceError ? err : new VoiceError('voice_failed');
    }
  }

  function closeAll() {
    for (const ac of requests.values()) ac.abort();
    requests.clear();
    for (const s of sockets.values()) {
      s.silent = true;
      try {
        s.ws.close(1000);
      } catch { /* already closing */ }
    }
    sockets.clear();
  }

  return { handle, cancel, socketSend, socketClose, closeAll, keyFile };
}

// makePermissionHandler is the session's permission request handler (VC-5): the microphone, audio only, is granted to the
// app's own page in its main window; any other `media` request (a camera, another page) is refused. Every other permission is
// answered as Electron answers it with no handler: granted.
function makePermissionHandler({ getWindow, pageURL }) {
  return (webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true);
      return;
    }
    const win = getWindow();
    const types = details && details.mediaTypes;
    const ok = Boolean(win) && !win.isDestroyed() && webContents === win.webContents
      && Array.isArray(types) && types.length === 1 && types[0] === 'audio'
      && typeof details.requestingUrl === 'string' && atPage(details.requestingUrl, pageURL);
    callback(ok);
  };
}

module.exports = {
  createVoice,
  VoiceError,
  serviceBase,
  makePermissionHandler,
  KEY_FILE,
  VOICE_HTTP,
  VOICE_WS,
};
