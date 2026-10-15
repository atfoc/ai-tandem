'use strict';

// The Session port over node:http2 (plan A5): one session per entry, and the stream, the calls and
// the pictures of a server all go over it. The Connector (connector.js) opens the TLS socket and
// judges its certificate before HTTP/2 starts on it, so nothing is sent to a certificate that the
// pin refused.

const http2 = require('node:http2');
const { NetError } = require('../core/outcomes');
const { abortError } = require('../core/abort');

// bufferOf is a body as Node writes it: a Buffer over the same bytes.
const bufferOf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

// textStream is the body of a response read as UTF-8 text, as a TextStream: chunks in order, then
// one end, with NetError 'reset' when the stream was cut (the network, the session destroyed under
// it, the server's RST_STREAM) and none when the server ended it; nothing after cancel. The end is
// decided when the stream closes: Node emits 'end' for a stream whose session was destroyed too (a
// close() here, a socket that broke), so 'end' alone does not say the body was whole. What does: a
// clean end is 'end' on a stream that is not yet destroyed, and a stream the peer reset closes with a
// rstCode other than 0 (measured on Node 24).
function textStream(req) {
  let ended = false;
  let endErr;
  let onEnd = null;
  let cancelled = false;
  let complete = false;
  req.setEncoding('utf8');
  const end = (err) => {
    if (ended) return;
    ended = true;
    endErr = err;
    if (onEnd && !cancelled) onEnd(err);
  };
  req.on('end', () => { complete = !req.destroyed; });
  req.on('close', () => { end(complete && !req.rstCode ? undefined : new NetError('reset')); });
  return {
    onChunk(f) { req.on('data', (text) => { if (!cancelled) f(text); }); },
    onEnd(f) {
      onEnd = f;
      if (ended && !cancelled) f(endErr);
    },
    cancel() {
      cancelled = true;
      if (!req.closed && !req.destroyed) req.close(http2.constants.NGHTTP2_CANCEL);
    },
  };
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

  isClosed() {
    return this.closed;
  }

  // request writes a request and resolves with its response's headers: { status, headers, req }.
  // req is the HTTP/2 stream, its body not yet read. body is a Uint8Array or null. headersMs is
  // the time the headers may take after the request was written. Aborting the signal cancels the
  // request.
  request({ method, path, headers, body, signal, headersMs }) {
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
      req.on('response', (h) => done(resolve, { status: Number(h[':status']), headers: h, req }));
      req.on('close', () => done(reject, new NetError('reset')));
      if (body != null) req.end(bufferOf(body));
    });
  }

  // stream is request with the body read as text as it comes (the event stream): { status,
  // headers, body: TextStream }. Aborting the signal after the headers cancels the body.
  async stream({ signal, ...rest }) {
    const res = await this.request({ ...rest, signal });
    const body = textStream(res.req);
    if (signal) {
      const onAbort = () => body.cancel();
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      res.req.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    return { status: res.status, headers: res.headers, body };
  }

  // fetch is request and the whole body: { status, headers, body: Uint8Array (a Buffer) }. limitMs
  // is the time of all of it, maxBytes the most the body may hold (NetError 'too_long' above it).
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
        res = await this.request({ ...rest, signal: ac.signal });
      } catch (err) {
        throw reason || err;
      }
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let ended = false;
        const req = res.req;
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

const WINDOW = 4 << 20; // bytes of flow-control window per stream; the connection's is twice that

// startSession starts HTTP/2 on a TLS socket whose certificate was accepted.
function startSession(sock, host, port) {
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

module.exports = { Session, NetError, startSession, textStream };
