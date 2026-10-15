'use strict';

// The port contract (architecture AD-15, goal D10): what every Connector and every Session must do,
// whatever is behind them — node:tls and node:http2 on the desktop, the JS adapter over the native
// module's fake, the real native module on a simulator. It is the statement of "the same pin rule
// and the same errors". Each implementation passes this one suite:
//
//   runConnectorContract(makeConnector, env)
//
//   makeConnector()   a Connector (ports.d.ts); called once per case. It must reach the servers
//                     `env.start` makes.
//   env.test(name, fn)  how a case is registered: node:test's `test`, or anything that runs
//                     `fn(t)` and fails the case when it throws. `t.skip(reason)` is used, when the
//                     runner has it, for a case that needs what the server cannot do.
//   env.start(kind, opts)  starts the server a case talks to and answers a handle:
//       'aiwb'        an HTTP/2 server over TLS with one certificate: GET /api/hello answers with no
//                     secret, GET /api/events is an event stream, the secret is in the handle
//       'h1'          a TLS server that negotiates HTTP/1.1 only
//       'plain'       a listener that does not speak TLS (HTTP/1.1 in the clear)
//       'closed'      a port nothing listens on
//       'blackhole'   a listener that takes the connection and never answers it (a handshake
//                     that never ends)
//     Every handle has host, port (a number), close() (async). The others also have
//         fingerprint                 the SHA-256 of the leaf, as the Connector must report it
//     and the 'aiwb' handle has
//         secret                      the secret its non-hello routes want (`x-aiwb-secret`)
//         requests()                  [{method, path, headers, body}] of the requests that arrived
//         connections()   (optional)  how many connections the server accepted
//         body(path, bytes)           GET path answers 200 with these bytes
//         echo(path)                  POST path answers 200 with the body it got
//         hang(path)                  path is never answered
//         waitStream()                resolves when an event stream (GET /api/events) is open
//         write(text)                 sends text, as it is, on the open event streams
//         endStreams()                ends the open event streams politely
//         cut()                       drops every connection
//     A case that needs a function the handle lacks is skipped, with the reason. A real Go server
//     can give the first group and `waitStream`/`write` only through its own events, so the cases
//     that script the server are skipped there; the rest are not.
//
// Nothing here names a module of Node: the suite also runs where there is none.

const { decode } = require('../../core/utf8');

const SECOND = 1000;

// ---- a small assert, so that nothing here needs node:assert ----

class ContractFailure extends Error {
  constructor(message) { super(message); this.name = 'ContractFailure'; }
}

const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
function ok(v, msg) { if (!v) throw new ContractFailure(msg || 'expected a true value'); }
function equal(a, b, msg) { if (a !== b) throw new ContractFailure(`${msg || 'not equal'}: got ${show(a)}, want ${show(b)}`); }
function match(s, re, msg) { if (!re.test(s)) throw new ContractFailure(`${msg || 'no match'}: ${show(s)} does not match ${re}`); }
function bytesEqual(a, b, msg) {
  ok(a instanceof Uint8Array, `${msg || 'bytes'}: not a Uint8Array`);
  equal(a.length, b.length, `${msg || 'bytes'}: length`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new ContractFailure(`${msg || 'bytes'}: differ at ${i}`);
}

// rejection is the error a promise rejects with; it fails when the promise resolves.
async function rejection(p, msg) {
  try { await p; } catch (err) { return err; }
  throw new ContractFailure(`${msg || 'the call'} should have been rejected`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, what, ms = 15 * SECOND) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new ContractFailure(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// isProblem and isNet say what an error is by its name, as core/outcomes.js does.
const problem = (err, outcome, what) => {
  ok(err && err.name === 'Problem', `${what}: a Problem, got ${err && err.name}: ${err && err.message}`);
  equal(err.outcome, outcome, `${what}: outcome`);
  ok(typeof err.detail === 'string', `${what}: detail is a string`);
  ok(typeof err.fingerprint === 'string' && typeof err.pinned === 'string', `${what}: fingerprint and pinned are strings`);
  return err;
};
const netError = (err, code, what) => {
  ok(err && err.name === 'NetError', `${what}: a NetError, got ${err && err.name}: ${err && err.message}`);
  equal(err.code, code, `${what}: code`);
  return err;
};
const aborted = (err, what) => ok(err && err.name === 'AbortError', `${what}: an AbortError, got ${err && err.name}: ${err && err.message}`);

// wrongPin is a fingerprint in the normal form that is not fp.
const wrongPin = (fp) => (fp.startsWith('00:') ? 'FF' : '00') + fp.slice(2);

// ---- the suite ----

function runConnectorContract(makeConnector, env) {
  const { start } = env;
  const name = (n) => `connector contract: ${n}`;
  const skip = (t, why) => { if (t && typeof t.skip === 'function') t.skip(why); };

  // run starts a server of a kind and a Connector, runs fn, and closes the server and every session.
  function scenario(label, kind, fn, { needs = [], opts } = {}) {
    env.test(name(label), async (t) => {
      const srv = await start(kind, opts);
      const sessions = [];
      try {
        const lacking = needs.filter((f) => typeof srv[f] !== 'function');
        if (lacking.length) return skip(t, `the server cannot ${lacking.join(', ')}`);
        const connector = makeConnector();
        const ctx = {
          connector,
          srv,
          open: async (trust, extra = {}) => {
            const s = await connector.open({ host: srv.host, port: String(srv.port), trust, dialMs: 3 * SECOND, handshakeMs: 3 * SECOND, ...extra });
            sessions.push(s);
            return s;
          },
          pinned: () => ({ selfSigned: true, pin: srv.fingerprint }),
          headers: (extra = {}) => ({ 'x-aiwb-secret': srv.secret, 'x-aiwb-client': '00000000-0000-4000-8000-000000000000', 'x-aiwb-level': '6', ...extra }),
          req: (path, extra = {}) => ({ method: 'GET', path, headers: ctx.headers(), body: null, ...extra }),
        };
        await fn(ctx, t);
      } finally {
        for (const s of sessions) { try { s.close(); } catch { /* gone */ } }
        await srv.close();
      }
    });
  }

  // collect reads a TextStream into what it said: the text, the number of ends, the error of the end.
  function collect(body) {
    const got = { text: '', chunks: 0, ends: 0, err: undefined };
    body.onChunk((s) => { ok(typeof s === 'string', 'a chunk is a string'); got.text += s; got.chunks++; });
    body.onEnd((err) => { got.ends++; got.err = err; });
    return got;
  }

  const eventsPath = '/api/events';

  scenario('open with the pin gives a session on that certificate, and open sends nothing', 'aiwb', async ({ srv, open, pinned, req }) => {
    const s = await open(pinned());
    equal(s.fingerprint, srv.fingerprint, 'the session names the certificate it accepted');
    equal(s.isClosed(), false, 'a new session is open');
    equal(srv.requests().length, 0, 'open wrote no request');
    const r = await s.fetch({ ...req('/api/hello', { headers: {} }), limitMs: 5 * SECOND });
    equal(r.status, 200, 'hello');
    ok(r.body instanceof Uint8Array, 'the body is a Uint8Array');
    equal(JSON.parse(decode(r.body)).app, 'ai-whiteboard', 'the body of hello');
    ok(Object.keys(r.headers).every((k) => k === k.toLowerCase()), 'header names are lower-case');
    match(r.headers['content-type'], /^application\/json/, 'content-type');
    equal(srv.requests().length, 1);
    equal(srv.requests()[0].headers['x-aiwb-secret'], undefined, 'the secret goes only where the caller puts it');
  }, { needs: ['requests'] });

  scenario('close ends the session: isClosed, onClose once (at once when it has ended), requests refused as closed', 'aiwb', async ({ open, pinned, req }) => {
    const s = await open(pinned());
    let told = 0;
    s.onClose(() => { told++; });
    equal(told, 0);
    s.close();
    await until(() => told === 1, 'onClose');
    await sleep(30);
    equal(told, 1, 'onClose is called once');
    equal(s.isClosed(), true);
    let late = 0;
    s.onClose(() => { late++; });
    equal(late, 1, 'onClose after the end is called at once');
    netError(await rejection(s.fetch(req('/api/hello')), 'fetch on a closed session'), 'closed', 'fetch on a closed session');
    netError(await rejection(s.stream(req(eventsPath)), 'stream on a closed session'), 'closed', 'stream on a closed session');
    s.close(); // twice is nothing
  });

  scenario('a wrong pin is cert_changed with the presented and the pinned fingerprint, and nothing is written', 'aiwb', async ({ srv, open }) => {
    const bad = wrongPin(srv.fingerprint);
    const err = problem(await rejection(open({ selfSigned: true, pin: bad }), 'open with a wrong pin'), 'cert_changed', 'wrong pin');
    equal(err.fingerprint, srv.fingerprint, 'the presented fingerprint');
    equal(err.pinned, bad, 'the pinned fingerprint');
    equal(srv.requests().length, 0, 'not a request reached the server');
  }, { needs: ['requests'] });

  scenario('the self-signed box with no pin is fingerprint, without dialing', 'aiwb', async ({ srv, open }) => {
    problem(await rejection(open({ selfSigned: true, pin: '' }), 'open with no pin'), 'fingerprint', 'no pin');
    equal(srv.requests().length, 0);
    if (typeof srv.connections === 'function') equal(srv.connections(), 0, 'no connection was made');
  }, { needs: ['requests'] });

  scenario('readCertificate answers the leaf\'s fingerprint, whatever the certificate, and sends no request', 'aiwb', async ({ srv, connector }) => {
    const fp = await connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 3 * SECOND });
    equal(fp, srv.fingerprint);
    equal(srv.requests().length, 0);
  }, { needs: ['requests'] });

  scenario('a refused port is refused, for open and for readCertificate', 'closed', async ({ srv, connector, open }) => {
    problem(await rejection(open({ selfSigned: true, pin: wrongPin('AA:'.repeat(31) + 'AA') }), 'open'), 'refused', 'open');
    problem(await rejection(connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 3 * SECOND }), 'readCertificate'), 'refused', 'readCertificate');
  });

  scenario('a listener that does not speak TLS is not_https, for open and for readCertificate', 'plain', async ({ srv, connector, open }) => {
    problem(await rejection(open({ selfSigned: true, pin: 'AA:'.repeat(31) + 'AA' }), 'open'), 'not_https', 'open');
    problem(await rejection(connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 3 * SECOND }), 'readCertificate'), 'not_https', 'readCertificate');
  });

  scenario('a TLS server that does not negotiate h2 is not_aiwb, once its certificate was accepted', 'h1', async ({ srv, open, pinned, connector }) => {
    problem(await rejection(open(pinned()), 'open with the pin'), 'not_aiwb', 'no h2');
    const err = problem(await rejection(open({ selfSigned: true, pin: wrongPin(srv.fingerprint) }), 'open with a wrong pin'), 'cert_changed', 'wrong pin on a server without h2');
    equal(err.fingerprint, srv.fingerprint);
    equal(await connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 3 * SECOND }), srv.fingerprint, 'its certificate can be read');
  });

  scenario('a handshake that never ends is tls_timeout after handshakeMs, and an abort ends it', 'blackhole', async ({ srv, connector, open }) => {
    const t0 = Date.now();
    problem(await rejection(connector.open({ host: srv.host, port: String(srv.port), trust: { selfSigned: true, pin: 'AA:'.repeat(31) + 'AA' }, dialMs: 3 * SECOND, handshakeMs: 200 }), 'open'), 'tls_timeout', 'open');
    ok(Date.now() - t0 < 5 * SECOND, 'it did not wait for the production limit');
    problem(await rejection(connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 200 }), 'readCertificate'), 'tls_timeout', 'readCertificate');
    const ac = new AbortController();
    const pending = open({ selfSigned: true, pin: 'AA:'.repeat(31) + 'AA' }, { handshakeMs: 20 * SECOND, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    aborted(await rejection(pending, 'open aborted'), 'open aborted in the handshake');
    const done = new AbortController();
    done.abort();
    aborted(await rejection(open({ selfSigned: true, pin: 'AA:'.repeat(31) + 'AA' }, { signal: done.signal }), 'open with an aborted signal'), 'open with an aborted signal');
    aborted(await rejection(connector.readCertificate({ host: srv.host, port: String(srv.port), dialMs: 3 * SECOND, handshakeMs: 3 * SECOND, signal: done.signal }), 'readCertificate with an aborted signal'), 'readCertificate with an aborted signal');
  });

  scenario('the stream gives the text of its body in order, then ends once, without an error', 'aiwb', async ({ srv, open, pinned, req }) => {
    const s = await open(pinned());
    const r = await s.stream(req(eventsPath, { headers: { 'x-aiwb-secret': srv.secret, 'x-aiwb-level': '6', accept: 'text/event-stream' } }));
    equal(r.status, 200);
    match(r.headers['content-type'], /^text\/event-stream/, 'content-type');
    const got = collect(r.body);
    await srv.waitStream();
    const parts = ['data: {"n":1}\n\n', 'data: é✓😀 text\n\n', ': ping\n\n', 'data: {"n":', '2}\n\n', 'data: last\n\n'];
    for (const p of parts) { srv.write(p); await sleep(5); }
    await until(() => got.text.endsWith('data: last\n\n'), 'the text');
    equal(got.text, parts.join(''), 'the text, in order, whole');
    equal(got.ends, 0, 'not ended while the server holds it');
    srv.endStreams();
    await until(() => got.ends === 1, 'the end');
    await sleep(30);
    equal(got.ends, 1, 'one end');
    equal(got.err, undefined, 'a clean end has no error');
    equal(got.text, parts.join(''), 'nothing after the end');
    equal(s.isClosed(), false, 'the session outlives its stream');
  }, { needs: ['waitStream', 'write', 'endStreams'] });

  scenario('cancel stops the stream: no chunk and no end after it', 'aiwb', async ({ srv, open, pinned, req }) => {
    const s = await open(pinned());
    const r = await s.stream(req(eventsPath));
    const got = collect(r.body);
    await srv.waitStream();
    srv.write('data: one\n\n');
    await until(() => got.text === 'data: one\n\n', 'the first text');
    r.body.cancel();
    srv.write('data: two\n\n');
    srv.endStreams();
    await sleep(200);
    equal(got.text, 'data: one\n\n', 'nothing after cancel');
    equal(got.ends, 0, 'no end after cancel');
    equal(s.isClosed(), false, 'the session goes on');
    equal((await s.fetch({ ...req('/api/hello', { headers: {} }), limitMs: 5 * SECOND })).status, 200, 'and serves');
  }, { needs: ['waitStream', 'write', 'endStreams'] });

  scenario('a cut ends the stream with a NetError reset, closes the session and refuses new requests', 'aiwb', async ({ srv, open, pinned, req }) => {
    const s = await open(pinned());
    let closed = 0;
    s.onClose(() => { closed++; });
    const r = await s.stream(req(eventsPath));
    const got = collect(r.body);
    await srv.waitStream();
    srv.write('data: before\n\n');
    await until(() => got.text.length > 0, 'the text');
    srv.cut();
    await until(() => got.ends === 1, 'the end');
    netError(got.err, 'reset', 'the end of a cut stream');
    await until(() => closed === 1 && s.isClosed(), 'the session to close');
    netError(await rejection(s.fetch(req('/api/hello')), 'fetch after the cut'), 'closed', 'fetch after the cut');
  }, { needs: ['waitStream', 'write', 'cut'] });

  scenario('close ends every request on the session: a fetch that waits is reset, a stream ends with reset', 'aiwb', async ({ srv, open, pinned, req }) => {
    srv.hang('/api/hung');
    const s = await open(pinned());
    const r = await s.stream(req(eventsPath));
    const got = collect(r.body);
    const waiting = rejection(s.fetch(req('/api/hung')), 'a fetch the server never answers');
    await until(() => srv.requests().some((q) => q.path === '/api/hung'), 'the request to arrive');
    s.close();
    netError(await waiting, 'reset', 'the fetch that waited');
    await until(() => got.ends === 1, 'the end of the stream');
    netError(got.err, 'reset', 'the stream that was open');
  }, { needs: ['hang', 'requests'] });

  scenario('fetch brings the status, the headers and the exact bytes; a body goes out as it is', 'aiwb', async ({ srv, open, pinned, req }) => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7 + 3) & 0xff); // not text, bigger than a chunk
    srv.body('/api/blob', bytes);
    srv.echo('/api/echo');
    const s = await open(pinned());
    const r = await s.fetch({ ...req('/api/blob'), limitMs: 10 * SECOND, maxBytes: 1 << 20 });
    equal(r.status, 200);
    bytesEqual(r.body, bytes, 'the answer');
    const sent = Uint8Array.from([0, 255, 254, 0, 1, 0x80, 0xc3, 0x28, 10, 13]); // not UTF-8
    const e = await s.fetch({ ...req('/api/echo', { method: 'POST', body: sent, headers: { ...{ 'x-aiwb-secret': srv.secret, 'x-aiwb-level': '6' }, 'content-type': 'application/octet-stream' } }), limitMs: 10 * SECOND });
    bytesEqual(e.body, sent, 'the echo');
    const seen = srv.requests().find((q) => q.method === 'POST');
    equal(seen.path, '/api/echo');
    equal(seen.headers['content-type'], 'application/octet-stream', 'a header the caller set');
    bytesEqual(seen.body, sent, 'the body the server got');
    const none = await s.fetch({ ...req('/api/echo', { method: 'POST', body: null }), limitMs: 5 * SECOND });
    equal(none.body.length, 0, 'no body, an empty echo');
  }, { needs: ['body', 'echo', 'requests'] });

  scenario('a body above maxBytes is a NetError too_long, and the session serves on', 'aiwb', async ({ srv, open, pinned, req }) => {
    srv.body('/api/blob', new Uint8Array(5000).fill(65));
    const s = await open(pinned());
    netError(await rejection(s.fetch({ ...req('/api/blob'), limitMs: 10 * SECOND, maxBytes: 1000 }), 'fetch above maxBytes'), 'too_long', 'fetch above maxBytes');
    const same = await s.fetch({ ...req('/api/blob'), limitMs: 10 * SECOND, maxBytes: 5000 });
    equal(same.body.length, 5000, 'a body of exactly maxBytes is whole');
    equal(s.isClosed(), false);
  }, { needs: ['body'] });

  scenario('headersMs without headers is a NetError timeout, for fetch and for stream; limitMs for the whole fetch', 'aiwb', async ({ srv, open, pinned, req }) => {
    srv.hang('/api/hung');
    const s = await open(pinned());
    let t0 = Date.now();
    netError(await rejection(s.fetch({ ...req('/api/hung'), headersMs: 150, limitMs: 20 * SECOND }), 'fetch'), 'timeout', 'headersMs of fetch');
    ok(Date.now() - t0 < 5 * SECOND, 'headersMs was waited, not the limit');
    netError(await rejection(s.stream({ ...req('/api/hung'), headersMs: 150 }), 'stream'), 'timeout', 'headersMs of stream');
    t0 = Date.now();
    netError(await rejection(s.fetch({ ...req('/api/hung'), limitMs: 150 }), 'fetch with limitMs'), 'timeout', 'limitMs of fetch');
    ok(Date.now() - t0 < 5 * SECOND, 'limitMs was waited');
    equal(s.isClosed(), false, 'a request that timed out does not end the session');
    equal((await s.fetch({ ...req('/api/hello', { headers: {} }), limitMs: 5 * SECOND })).status, 200, 'and it serves');
  }, { needs: ['hang'] });

  scenario('abort is an AbortError: before the request, while it waits, for a stream before and after its headers', 'aiwb', async ({ srv, open, pinned, req }) => {
    srv.hang('/api/hung');
    const s = await open(pinned());
    // before: the request is not made
    const done = new AbortController();
    done.abort();
    aborted(await rejection(s.fetch({ ...req('/api/hello'), signal: done.signal }), 'fetch'), 'fetch with an aborted signal');
    aborted(await rejection(s.stream({ ...req(eventsPath), signal: done.signal }), 'stream'), 'stream with an aborted signal');
    equal(srv.requests().length, 0, 'an aborted request was not sent');
    // while it waits for its headers
    let ac = new AbortController();
    let pending = rejection(s.fetch({ ...req('/api/hung'), signal: ac.signal, limitMs: 20 * SECOND }), 'fetch');
    await until(() => srv.requests().length === 1, 'the request to arrive');
    ac.abort();
    aborted(await pending, 'fetch aborted while it waits');
    ac = new AbortController();
    pending = rejection(s.stream({ ...req('/api/hung'), signal: ac.signal }), 'stream');
    await until(() => srv.requests().length === 2, 'the request to arrive');
    ac.abort();
    aborted(await pending, 'stream aborted before its headers');
    // after its headers: the body stops, with no end
    ac = new AbortController();
    const r = await s.stream({ ...req(eventsPath), signal: ac.signal });
    const got = collect(r.body);
    await srv.waitStream();
    srv.write('data: one\n\n');
    await until(() => got.text === 'data: one\n\n', 'the text');
    ac.abort();
    srv.write('data: two\n\n');
    await sleep(150);
    equal(got.text, 'data: one\n\n', 'no chunk after the abort');
    equal(got.ends, 0, 'no end after the abort');
    equal(s.isClosed(), false, 'the session goes on');
  }, { needs: ['hang', 'requests', 'waitStream', 'write'] });

  scenario('one session carries what is asked of it at once: fetches and a stream on one connection', 'aiwb', async ({ srv, open, pinned, req }) => {
    srv.body('/api/a', new Uint8Array(100).fill(1));
    srv.body('/api/b', new Uint8Array(200).fill(2));
    const s = await open(pinned());
    const r = await s.stream(req(eventsPath));
    const got = collect(r.body);
    await srv.waitStream();
    const [a, b] = await Promise.all([s.fetch({ ...req('/api/a'), limitMs: 10 * SECOND }), s.fetch({ ...req('/api/b'), limitMs: 10 * SECOND })]);
    equal(a.body.length, 100);
    equal(b.body.length, 200);
    srv.write('data: x\n\n');
    await until(() => got.text === 'data: x\n\n', 'the text');
    if (typeof srv.connections === 'function') equal(srv.connections(), 1, 'one connection');
  }, { needs: ['body', 'waitStream', 'write'] });

}

module.exports = { runConnectorContract, ContractFailure };
