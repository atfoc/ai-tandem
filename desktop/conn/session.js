'use strict';

// One HTTP/2 session per entry (plan A5): the stream, the calls and the pictures of a server all
// go over it. The TLS socket is opened and its certificate judged (tls.js) before HTTP/2 starts on
// it, so nothing is sent to a certificate that the pin refused.

const http2 = require('node:http2');
const { connectPinned, abortError } = require('./tls');
const { Problem } = require('./outcomes');

const WINDOW = 4 << 20; // bytes of flow-control window per stream; the connection's is twice that

// NetError is a request that got no usable answer: code is 'timeout', 'reset' (the connection or
// the stream ended), 'too_long' (the answer is above its limit) or 'closed' (the session is gone).
class NetError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NetError';
    this.code = code;
  }
}

class Session {
  constructor(h2, socket) {
    this.h2 = h2;
    this.socket = socket;
    this.closed = false;
    this.fingerprint = socket.fingerprint;
    this.listeners = [];
    const gone = () => {
      if (this.closed) return;
      this.closed = true;
      for (const f of this.listeners.splice(0)) f();
    };
    h2.on('error', () => { gone(); h2.destroy(); });
    h2.on('close', gone);
    h2.on('goaway', () => { gone(); });
    socket.on('error', () => {});
    socket.on('close', gone);
  }

  // onClose calls f once, when the session ended for any reason (at once when it already has).
  onClose(f) {
    if (this.closed) f(); else this.listeners.push(f);
  }

  // send writes a request and resolves with its response's headers: { status, headers, stream }.
  // The stream is the response's body, not yet read. body is a Buffer or null. headersMs is the
  // time the headers may take after the request was written. Aborting the signal cancels the
  // request.
  send({ method, path, headers, body, signal, headersMs }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      if (this.closed || this.h2.closed || this.h2.destroyed) return reject(new NetError('closed'));
      let req;
      try {
        req = this.h2.request({ ':method': method, ':path': path, ...headers }, { endStream: body == null });
      } catch (err) {
        return reject(new NetError('reset', err.message));
      }
      req.on('error', () => {});
      let timer = null;
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      const cancel = () => { if (!req.closed && !req.destroyed) req.close(http2.constants.NGHTTP2_CANCEL); };
      const onAbort = () => { cancel(); done(reject, abortError()); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (headersMs) timer = setTimeout(() => { cancel(); done(reject, new NetError('timeout', 'headers')); }, headersMs);
      req.on('response', (h) => done(resolve, { status: Number(h[':status']), headers: h, stream: req }));
      req.on('close', () => done(reject, new NetError('reset')));
      if (body != null) req.end(body);
    });
  }

  // fetch is send and the whole body: { status, headers, body: Buffer }. limitMs is the time of
  // all of it, maxBytes the most the body may hold (NetError 'too_long' above it).
  async fetch({ limitMs, maxBytes = Infinity, signal, ...rest }) {
    const ac = new AbortController();
    let reason = null;
    const stop = (r) => { if (!reason) reason = r; ac.abort(); };
    const onAbort = () => stop(abortError());
    if (signal) {
      if (signal.aborted) throw abortError();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = limitMs ? setTimeout(() => stop(new NetError('timeout')), limitMs) : null;
    try {
      let res;
      try {
        res = await this.send({ ...rest, signal: ac.signal });
      } catch (err) {
        throw reason || err;
      }
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let ended = false;
        const req = res.stream;
        const onStop = () => { if (!req.closed && !req.destroyed) req.close(http2.constants.NGHTTP2_CANCEL); reject(reason); };
        ac.signal.addEventListener('abort', onStop, { once: true });
        req.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { stop(new NetError('too_long')); return; }
          chunks.push(c);
        });
        req.on('end', () => { ended = true; ac.signal.removeEventListener('abort', onStop); resolve(Buffer.concat(chunks)); });
        req.on('close', () => { if (!ended) { ac.signal.removeEventListener('abort', onStop); reject(reason || new NetError('reset')); } });
        if (ac.signal.aborted) onStop();
      });
      return { status: res.status, headers: res.headers, body };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // close ends the session and every request on it.
  close() {
    if (!this.closed) { this.closed = true; for (const f of this.listeners.splice(0)) f(); }
    try { this.h2.destroy(); } catch { /* already gone */ }
    this.socket.destroy();
  }
}

// openSession connects to host:port under trust, then starts HTTP/2 on the socket. It throws a
// Problem (not_aiwb when the server does not negotiate h2) or an AbortError.
async function openSession({ host, port, trust, timing, signal, dial }) {
  const sock = await connectPinned({ host, port, trust, dialMs: timing.dial, handshakeMs: timing.handshake, signal, dial });
  if (sock.alpnProtocol !== 'h2') {
    sock.destroy();
    throw new Problem('not_aiwb', 'the server does not speak HTTP/2');
  }
  // Bigger windows than the 64 KiB default: a drawing or a picture over a VPN would otherwise move
  // one window per round trip.
  const h2 = http2.connect(`https://${host}:${port}`, {
    createConnection: () => sock,
    settings: { initialWindowSize: WINDOW },
    maxSessionMemory: 256,
  });
  const session = new Session(h2, sock);
  try { h2.setLocalWindowSize(WINDOW * 2); } catch { /* the default window stays */ }
  return session;
}

module.exports = { Session, NetError, openSession };
