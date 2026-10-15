'use strict';

// A picture of a chat (port of Picture in internal/remotes/images.go): fetched over the entry's
// session and looked at before it goes on. It is taken from its bytes alone: one of the image types
// a message takes, within the size limit, whatever type the server claimed. No server can have the
// app show HTML or SVG of its making.

const { isNetError } = require('./outcomes');
const { abortError, isAbort } = require('./abort');
const { synth, noServer, notConnected, badAnswer, noAnswer } = require('./calls');
const { cleanOf } = require('./text');
const { decodeLenient } = require('./utf8');

const IMAGE_MAX_BYTES = 5 << 20; // model.ImageMaxBytes
const AT_A_TIME = 8; // fetches at a time per entry; the rest wait in order
const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE_ID = /^[0-9a-f]{64}$/;

// imageType is the type of the image b is, found from its first bytes alone; '' for anything else.
function imageType(b) {
  const starts = (s, at = 0) => {
    if (b.length < at + s.length) return false;
    for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (starts('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (starts('\xff\xd8\xff')) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (b.length >= 12 && starts('RIFF') && starts('WEBP', 8)) return 'image/webp';
  return '';
}

// Gate lets AT_A_TIME holders in and queues the rest in order; a waiter that is aborted leaves.
class Gate {
  constructor(n) {
    this.free = n;
    this.queue = [];
  }

  acquire(signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { resolve: () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); } };
      const onAbort = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(w);
    });
  }

  release() {
    const w = this.queue.shift();
    if (w) w.resolve(); else this.free++;
  }
}

// refusalOf is an answer that is no success as the server's own error: its status, code and
// sentence, and nothing else of it.
function refusalOf(conn, res) {
  let error = '';
  let code = '';
  try {
    const v = JSON.parse(decodeLenient(res.body));
    if (v && typeof v.error === 'string') error = cleanOf(v.error, conn.target.secret);
    if (v && typeof v.code === 'string') code = cleanOf(v.code, conn.target.secret);
  } catch { /* no JSON: the sentence below */ }
  if (!error) error = `${conn.name} answered with status ${res.status}.`;
  return { ok: false, status: res.status, text: JSON.stringify(code ? { error, code } : { error }) };
}

// picture answers {ok: true, type, data} or {ok: false, status, text}.
async function picture(mgr, req) {
  const r = req || {};
  const { server, chat, image, signal } = r;
  if (signal && signal.aborted) throw abortError();
  const fail = (a) => ({ ok: false, status: a.status, text: a.text });

  const conn = typeof server === 'string' ? mgr.connFor(server) : null;
  if (!conn) return fail(noServer());
  if (conn.shown.state !== 'connected' || !conn.link) {
    conn.retryIfBackingOff();
    return fail(notConnected(conn));
  }
  if (typeof chat !== 'string' || !CHAT_ID.test(chat) || typeof image !== 'string' || !IMAGE_ID.test(image)) {
    return fail(synth(400, 'an image id is 64 lower-case hex digits', 'image_id'));
  }

  const gate = conn.pictures || (conn.pictures = new Gate(AT_A_TIME));
  await gate.acquire(signal);
  try {
    const link = conn.link;
    if (conn.shown.state !== 'connected' || !link) return fail(notConnected(conn));
    let res;
    try {
      res = await link.session.fetch({
        method: 'GET', path: `/api/chats/${chat}/images/${image}`, headers: conn.identify(),
        limitMs: mgr.timing.imageCall, maxBytes: IMAGE_MAX_BYTES, signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (isNetError(err)) {
        if (err.code === 'too_long') return fail(badAnswer(conn));
        if (err.code === 'closed') return fail(notConnected(conn));
      }
      return fail(noAnswer(conn));
    }
    if (res.status === 401) {
      link.refused = true;
      link.stop();
      return fail(notConnected(conn));
    }
    if (res.status >= 400) return refusalOf(conn, res);
    if (res.status !== 200) return fail(badAnswer(conn));
    const type = imageType(res.body);
    if (type === '') return fail(badAnswer(conn));
    return { ok: true, type, data: new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.length) };
  } finally {
    gate.release();
  }
}

module.exports = { picture, imageType, IMAGE_MAX_BYTES, AT_A_TIME };
