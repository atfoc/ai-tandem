'use strict';

// The one place TLS is decided (port of internal/servers/dial.go): a connection is made and its
// certificate judged here before anything is written to it. With the self-signed box, the
// certificate is accepted by its SHA-256 fingerprint and by nothing else; without it, by the roots
// and the name. Every failure is a Problem.

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { Problem } = require('./outcomes');
const { clean } = require('./text');
const { normalFingerprint } = require('./list');

// abortError is what a call or an attempt rejects with when its signal aborted.
function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

// fingerprintOf is the SHA-256 of a DER certificate: uppercase hex pairs joined by ":".
function fingerprintOf(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

// dialProblem names a failed dial: the first three rows of the error table.
function dialProblem(err) {
  const detail = clean(err && err.message ? err.message : String(err));
  switch (err && err.code) {
    case 'ECONNREFUSED': return new Problem('refused', detail);
    case 'ENOTFOUND': case 'EAI_AGAIN': return new Problem('name_not_found', detail);
    default: return new Problem('no_route', detail);
  }
}

// dialSocket connects over IPv4 within dialMs. dial is the test seam for net.connect.
function dialSocket({ host, port, dialMs, signal, dial }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const sock = (dial || net.connect)({ host, port: Number(port), family: 4 });
    let timer = null;
    const done = (fn, v) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.removeListener('connect', onConnect);
      sock.removeListener('error', onError);
      sock.on('error', () => {}); // a later error of the socket is the TLS socket's to report
      fn(v);
    };
    const onConnect = () => done(resolve, sock);
    const onError = (err) => { sock.destroy(); done(reject, dialProblem(err)); };
    const onAbort = () => { sock.destroy(); done(reject, abortError()); };
    timer = setTimeout(() => { sock.destroy(); done(reject, new Problem('no_route', 'the connection timed out')); }, dialMs);
    sock.once('connect', onConnect);
    sock.once('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// tlsProblem names a failed handshake.
function tlsProblem(err) {
  const detail = clean(err && err.message ? err.message : String(err));
  const code = err && err.code;
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG' ||
    code === 'ERR_SSL_HTTP_REQUEST' || code === 'ERR_SSL_HTTPS_PROXY_REQUEST' ||
    (code === 'EPROTO' && /wrong version number|packet length too long|http request/i.test(detail))) {
    return new Problem('not_https', detail);
  }
  return new Problem('tls_error', detail);
}

// handshake runs TLS on raw within handshakeMs and takes any certificate: judge decides.
function handshake({ raw, host, handshakeMs, signal, roots }) {
  return new Promise((resolve, reject) => {
    const opts = {
      socket: raw,
      host,
      ALPNProtocols: ['h2', 'http/1.1'], // a server that answers http/1.1 is not ours: openSession says so
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false, // judge decides, before anything is written
    };
    if (!net.isIP(host)) opts.servername = host;
    if (roots) opts.ca = roots;
    let sock = null;
    let timer = null;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (fn === reject) { raw.destroy(); if (sock) { sock.destroy(); sock.on('error', () => {}); } }
      fn(v);
    };
    const onAbort = () => done(reject, abortError());
    try {
      sock = tls.connect(opts);
    } catch (err) {
      return done(reject, tlsProblem(err));
    }
    sock.once('secureConnect', () => done(resolve, sock));
    sock.once('error', (err) => done(reject, tlsProblem(err)));
    sock.once('close', () => done(reject, new Problem('tls_error', 'the connection closed during the handshake')));
    timer = setTimeout(() => done(reject, new Problem('tls_timeout')), handshakeMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function expired(cert) {
  const t = Date.parse(cert.valid_to);
  return Number.isFinite(t) && t < Date.now();
}

// verifyProblem names a certificate that failed verification without the pin. As in Go the name
// outranks the dates, and the dates outrank "self-signed".
function verifyProblem(sock, host, cert) {
  const code = String(sock.authorizationError || '');
  const detail = clean(code);
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || tls.checkServerIdentity(host, cert) !== undefined) return new Problem('cert_name', detail);
  if (code === 'CERT_HAS_EXPIRED' || expired(cert)) return new Problem('cert_expired', detail);
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return new Problem('self_signed', detail);
  return new Problem('cert_untrusted', detail);
}

// judge accepts or refuses the certificate the handshake presented. It returns the fingerprint.
function judge(sock, host, trust) {
  const cert = sock.getPeerCertificate(false);
  if (!cert || !cert.raw) throw new Problem('tls_error', 'the server presented no certificate');
  const presented = fingerprintOf(cert.raw);
  if (trust.selfSigned) {
    if (!trust.pin) throw new Problem('fingerprint', '', { fingerprint: presented });
    const pinned = normalFingerprint(trust.pin); // a pin that is no fingerprint fits no certificate
    if (pinned === null || pinned !== presented) throw new Problem('cert_changed', '', { fingerprint: presented, pinned: pinned || String(trust.pin) });
    return presented;
  }
  if (!sock.authorized) throw verifyProblem(sock, host, cert);
  return presented;
}

// connectPinned connects to host:port and returns the TLS socket after a handshake that accepted
// the certificate under trust ({selfSigned, pin, roots}); nothing is written before that. It
// throws a Problem, or an AbortError. With the box on and no pin nothing is dialed.
async function connectPinned({ host, port, trust, dialMs, handshakeMs, signal, dial }) {
  if (trust.selfSigned && !trust.pin) throw new Problem('fingerprint');
  const raw = await dialSocket({ host, port, dialMs, signal, dial });
  const sock = await handshake({ raw, host, handshakeMs, signal, roots: trust.roots });
  try {
    const fingerprint = judge(sock, host, trust);
    sock.fingerprint = fingerprint;
  } catch (err) {
    sock.destroy();
    throw err;
  }
  return sock;
}

// readCertificate is the handshake that reads the certificate and sends no request: it accepts any
// certificate, takes the leaf's fingerprint and closes.
async function readCertificate({ host, port, dialMs, handshakeMs, signal, dial, roots }) {
  const raw = await dialSocket({ host, port, dialMs, signal, dial });
  const sock = await handshake({ raw, host, handshakeMs, signal, roots });
  try {
    const cert = sock.getPeerCertificate(false);
    if (!cert || !cert.raw) throw new Problem('tls_error', 'the server presented no certificate');
    return fingerprintOf(cert.raw);
  } finally {
    sock.destroy();
  }
}

module.exports = { abortError, fingerprintOf, connectPinned, readCertificate, dialProblem, tlsProblem };
