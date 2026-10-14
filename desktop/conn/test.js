'use strict';

// Test connection (port of internal/servers/test.go): an address tried in five steps, which says
// where it ended: the address, the dial, TLS, hello and the state. Each step has `testStep`. The
// secret is sent from step 5 on, so only after the certificate was accepted and the server said
// who it is: hello needs none (plan A10). With the box on and no pin the test ends at step 3 with
// the fingerprint of the certificate, read in a handshake that sends no request. No text of the
// result holds the secret, whatever the server answers.

const { parseAddress } = require('./address');
const { openSession, NetError } = require('./session');
const { readCertificate } = require('./tls');
const {
  MIN_FEATURE_LEVEL, CLIENT_LEVEL, HELLO_PATH, STATE_PATH, Problem, message, step,
} = require('./outcomes');
const { hide, cleanOf, stateAgents, errorOf, MAX_HELLO, MAX_STATE } = require('./text');
const { INSTANCE_ID } = require('./conn');

// result is the Result of an outcome at its step of the table.
function result(outcome) {
  return { ok: outcome === 'connected', step: step(outcome), outcome, message: message(outcome) };
}

// problemResult is the Result of a connection that was not made. The network's text may quote
// the server's certificate, so it is shown without the secret.
function problemResult(err, secret) {
  if (!(err instanceof Problem)) {
    const r = result('tls_error');
    r.detail = cleanOf(err && err.message ? err.message : String(err), secret);
    return r;
  }
  const r = result(err.outcome);
  const detail = hide(err.detail, secret);
  if (detail) r.detail = detail;
  if (err.fingerprint) r.fingerprint = err.fingerprint;
  if (err.pinned) r.pinned = err.pinned;
  return r;
}

// noAnswer is the Result of a request of step 4 or 5 that got no answer.
function noAnswer(err, stepNo, secret) {
  if (err instanceof Problem) return problemResult(err, secret);
  const r = result('no_answer');
  r.step = stepNo;
  if (!(err instanceof NetError && (err.code === 'timeout')) && err && err.message) r.detail = cleanOf(err.message, secret);
  return r;
}

// testConnection tries target {address, secret, selfSigned, pin} against the identity {localId,
// others: {instanceId: name}, expect}.
async function testConnection(mgr, target, ident) {
  const tm = mgr.timing;
  const stepMs = tm.testStep;
  const secret = typeof target.secret === 'string' ? target.secret : '';

  // 1: the address.
  const a = parseAddress(target.address);
  if (!a) return result('bad_address');

  // 2 and 3: the dial and TLS.
  const timing = { ...tm, dial: stepMs, handshake: stepMs };
  if (target.selfSigned && !target.pin) {
    try {
      const fp = await readCertificate({ host: a.host, port: a.port, dialMs: stepMs, handshakeMs: stepMs, dial: mgr.dial, roots: mgr.roots });
      const r = result('fingerprint');
      r.fingerprint = fp;
      return r;
    } catch (err) {
      return problemResult(err, secret);
    }
  }
  let session;
  try {
    session = await openSession({
      host: a.host, port: a.port, timing, dial: mgr.dial,
      trust: { selfSigned: !!target.selfSigned, pin: target.pin || '', roots: mgr.roots },
    });
  } catch (err) {
    return problemResult(err, secret);
  }
  try {
    const get = (path, limit, withSecret) => session.fetch({
      method: 'GET', path, limitMs: stepMs, headersMs: stepMs, maxBytes: limit,
      headers: {
        ...(withSecret ? { 'x-aiwb-secret': secret } : {}),
        'x-aiwb-client': mgr.clientId,
        'x-aiwb-level': String(CLIENT_LEVEL),
      },
    });

    // 4: hello.
    let res;
    try {
      res = await get(HELLO_PATH, MAX_HELLO, false);
    } catch (err) {
      if (err instanceof NetError && err.code === 'too_long') return result('not_aiwb');
      return noAnswer(err, 4, secret);
    }
    let text = res.body.toString('utf8');
    if (res.status === 401) return result('secret_refused');
    if (res.status === 403 && errorOf(text) === 'bad host') return result('bad_host');
    if (res.status !== 200) {
      const r = result('not_aiwb');
      r.detail = `HTTP ${res.status}`;
      const msg = cleanOf(errorOf(text), secret);
      if (msg) r.detail += `: ${msg}`;
      return r;
    }
    let hello;
    try { hello = JSON.parse(text); } catch { return result('not_aiwb'); }
    if (hello === null || typeof hello !== 'object' || Array.isArray(hello)) return result('not_aiwb');
    const instance = typeof hello.instanceId === 'string' ? hello.instanceId : '';
    if (hello.app !== 'ai-whiteboard' || !INSTANCE_ID.test(instance)) return result('not_aiwb');
    const version = cleanOf(typeof hello.version === 'string' ? hello.version : '', secret);
    const level = Number.isInteger(hello.featureLevel) ? hello.featureLevel : 0;
    const seen = (outcome) => {
      const r = result(outcome);
      if (version) r.version = version;
      r.instanceId = instance;
      if (level) r.featureLevel = level;
      return r;
    };
    const local = (ident && ident.localId) || mgr.localInstanceId || '';
    if (level < MIN_FEATURE_LEVEL) return seen('too_old');
    if (local && instance === local) return seen('is_local');
    const others = (ident && ident.others) || {};
    if (Object.prototype.hasOwnProperty.call(others, instance)) {
      const r = seen('duplicate');
      r.message += ` ${others[instance]}`;
      return r;
    }
    if (ident && ident.expect && instance !== ident.expect) return seen('another_server');

    // 5: the state, with the secret.
    if (!/^[\x21-\x7e]{1,256}$/.test(secret)) return seen('secret_refused');
    try {
      res = await get(STATE_PATH, MAX_STATE, true);
    } catch (err) {
      if (err instanceof NetError && err.code === 'too_long') return seen('no_state');
      const r = noAnswer(err, 5, secret);
      r.version = version || undefined;
      r.instanceId = instance;
      if (level) r.featureLevel = level;
      if (r.version === undefined) delete r.version;
      return r;
    }
    text = res.body.toString('utf8');
    if (res.status === 401) return seen('secret_refused');
    if (res.status === 403 && errorOf(text) === 'bad host') return seen('bad_host');
    let agents = null;
    if (res.status === 200) {
      try { agents = stateAgents(JSON.parse(text), secret); } catch { agents = null; }
    }
    if (agents === null) return seen('no_state');
    const r = seen('connected');
    if (agents.length) r.agents = agents;
    return r;
  } finally {
    session.close();
  }
}

module.exports = { testConnection, result };
