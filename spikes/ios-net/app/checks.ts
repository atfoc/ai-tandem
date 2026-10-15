// The spike's checks, run by the app on launch. The runner (../run.mjs) hands the configuration in AIWB_CONFIG and reads the lines
// this logs (NSLog "AIWB_SPIKE ..." and Documents/aiwb-spike.log). Each check logs one line `CHECK <name> PASS|FAIL <detail>`; the end is
// `DONE {"passed":n,"failed":n}`.
import { Native, Problem, NetError, openSession, readCertificate, normalFingerprint, type Session } from './modules/aiwb-net/src';
import { EventReader } from './modules/aiwb-net/src/sse';

export type Config = {
  mode: 'checks' | 'long';
  host: string;
  port: number;
  pin: string;
  secret: string;
  clientId: string;
  /** a fingerprint that is not the server's */
  wrongPin: string;
  /** a TLS server with another certificate, counting what is written to it; the pin of the server on `port` is wrong for it */
  tripwireWrongPort: number;
  /** the same kind of server, the app holds its pin: the control that shows the tripwire sees what is written */
  tripwireControlPort: number;
  tripwirePin: string;
  /** a dotted name that resolves to 127.0.0.1 (needs the internet's DNS); the server refuses its Host with a 403, which shows TLS got through */
  dottedName: string;
  /** servers with a certificate of a given validity, each listing the dotted name; they answer 200 to anything */
  certTests: { name: string; port: number; pin: string }[];
  /** a server whose event stream goes silent after two events, the connection staying open */
  stall: { port: number; pin: string };
  closedPort: number;
  plainPort: number;
  /** long mode: how long the stream is held */
  longMs: number;
  heartbeatMs: number;
};

const log = (line: string) => Native.log(line);
let passed = 0;
let failed = 0;

async function check(name: string, f: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await f();
    passed++;
    log(`CHECK ${name} PASS ${detail} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    const e = err as Error;
    log(`CHECK ${name} FAIL ${e && e.message ? e.message : String(err)} (${Date.now() - t0} ms)`);
  }
}

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

const identify = (c: Config, extra: Record<string, string> = {}) => ({
  'X-AIWB-Secret': c.secret,
  'X-AIWB-Client': c.clientId,
  'X-AIWB-Level': '6',
  ...extra,
});

async function expectProblem(what: string, p: Promise<unknown>, outcome: string): Promise<Problem> {
  try {
    await p;
  } catch (err) {
    assert(err instanceof Problem, `${what}: expected Problem ${outcome}, got ${(err as Error).name}: ${(err as Error).message}`);
    assert(err.outcome === outcome, `${what}: expected outcome ${outcome}, got ${err.outcome} (${err.detail})`);
    return err;
  }
  throw new Error(`${what}: expected Problem ${outcome}, but it succeeded`);
}

export async function runChecks(c: Config) {
  log(`START mode=checks host=${c.host} port=${c.port} pin=${c.pin.slice(0, 11)}...`);

  await check('fingerprint-normal-form', async () => {
    const n = normalFingerprint(c.pin.toLowerCase().replace(/:/g, ''));
    assert(n === c.pin, `normal form ${n}`);
    assert(normalFingerprint('xyz') === null, 'a non-fingerprint');
    assert(normalFingerprint(c.pin.slice(0, -3)) === null, 'a short fingerprint');
    return n;
  });

  await check('4-utf8-chunker-every-cut', async () => {
    const r = Native.selfTestUtf8('a é ✓ 日本語 😀 𝒳 e\u0301 \r\n data: {"name":"ü😀"}');
    assert(r.startsWith('ok'), r);
    return r;
  });

  await check('1-read-certificate', async () => {
    const fp = await readCertificate(c.host, c.port, 5000);
    assert(fp === c.pin, `read ${fp}, server prints ${c.pin}`);
    return `fingerprint ${fp} equals the one the server printed`;
  });

  let s!: Session;
  await check('1-pin-accepted-hello', async () => {
    s = await openSession(c.host, c.port, c.pin);
    const a = await s.fetch({ method: 'GET', path: '/api/hello', headers: identify(c), maxBytes: 64 << 10, limitMs: 10000 });
    assert(a.status === 200, `status ${a.status}`);
    const h = JSON.parse(a.text());
    assert(h.app === 'ai-whiteboard', 'hello.app');
    log(`HELLO ${a.text()} protocol=${a.protocol} reused=${a.reused}`);
    return `200 ${a.text()}`;
  });

  await check('2-http2-negotiated', async () => {
    const a = await s.fetch({ method: 'GET', path: '/api/hello', headers: identify(c), maxBytes: 64 << 10, limitMs: 10000 });
    assert(a.protocol === 'h2', `networkProtocolName ${JSON.stringify(a.protocol)}`);
    assert(a.reused, 'the second request did not reuse the connection');
    return `networkProtocolName=${a.protocol} reusedConnection=${a.reused}`;
  });

  await check('1-pin-accepted-in-lower-case-without-colons', async () => {
    const s2 = await openSession(c.host, c.port, c.pin.toLowerCase().replace(/:/g, ''));
    try {
      const a = await s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 });
      assert(a.status === 200, `status ${a.status}`);
      return 'a pin in any normal form is accepted';
    } finally { s2.close(); }
  });

  await check('1-pin-accepted-by-name-localhost', async () => {
    const s2 = await openSession('localhost', c.port, c.pin);
    try {
      const a = await s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 });
      assert(a.status === 200, `status ${a.status}`);
      return `200 over h2 via the name localhost (protocol ${a.protocol}); the IP and localhost are covered by ATS's local networking rule`;
    } finally { s2.close(); }
  });

  await check('1-pin-accepted-by-dotted-host-name', async () => {
    const s2 = await openSession(c.dottedName, c.port, c.pin);
    try {
      const a = await s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 });
      // the server refuses a Host it was not set up with (403 bad host): the answer shows the pinned TLS handshake went through
      assert(a.status === 200 || a.status === 403, `status ${a.status}`);
      return `${a.status} ${a.text().trim()} via ${c.dottedName} (protocol ${a.protocol}): the pin is the only rule, the name of the certificate does not matter, with NSAllowsArbitraryLoads (see the report)`;
    } catch (err) {
      if (err instanceof Problem && err.outcome === 'name_not_found') return `SKIPPED: ${c.dottedName} does not resolve here (${err.detail})`;
      if (err instanceof Problem) throw new Error(`Problem ${err.outcome}: ${err.detail}`);
      throw err;
    } finally { s2.close(); }
  });

  for (const t of c.certTests) {
    await check(`1-pin-accepted-by-dotted-name-cert-${t.name}`, async () => {
      const s2 = await openSession(c.dottedName, t.port, t.pin);
      try {
        const a = await s2.fetch({ path: '/', limitMs: 10000 });
        assert(a.status === 200, `status ${a.status}`);
        return `200 ${a.text()} via ${c.dottedName} (${a.protocol})`;
      } catch (err) {
        if (err instanceof Problem) throw new Error(`Problem ${err.outcome}: ${err.detail}`);
        throw err;
      } finally { s2.close(); }
    });
  }

  await check('1-no-pin-is-outcome-fingerprint', async () => {
    const p = await expectProblem('no pin', openSession(c.host, c.port, ''), 'fingerprint');
    return `Problem ${p.outcome}`;
  });

  await check('1-wrong-pin-is-cert_changed', async () => {
    const s2 = await openSession(c.host, c.port, c.wrongPin);
    try {
      const p = await expectProblem('wrong pin', s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 }), 'cert_changed');
      assert(p.fingerprint === c.pin, `presented ${p.fingerprint}`);
      assert(p.pinned === c.wrongPin, `pinned ${p.pinned}`);
      return `Problem cert_changed presented=${p.fingerprint} pinned=${p.pinned}`;
    } finally { s2.close(); }
  });

  await check('1-wrong-pin-on-the-stream-too', async () => {
    const s2 = await openSession(c.host, c.port, c.wrongPin);
    try {
      const p = await expectProblem('wrong pin stream', s2.stream({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), headersMs: 5000 }, () => {}), 'cert_changed');
      return `Problem ${p.outcome}`;
    } finally { s2.close(); }
  });

  await check('1-tripwire-wrong-pin-refused-before-any-byte', async () => {
    const s2 = await openSession(c.host, c.tripwireWrongPort, c.pin);
    try {
      const p = await expectProblem('tripwire', s2.fetch({ method: 'POST', path: '/api/hello', headers: identify(c), body: 'the-body-bytes', limitMs: 10000 }), 'cert_changed');
      assert(p.pinned === c.pin, 'pinned');
      assert(p.fingerprint === c.tripwirePin, `presented ${p.fingerprint}, tripwire has ${c.tripwirePin}`);
      return `Problem cert_changed presented=${p.fingerprint}; the runner reads the tripwire's byte count`;
    } finally { s2.close(); }
  });

  await check('1-tripwire-control-pin-accepted-bytes-arrive', async () => {
    const s2 = await openSession(c.host, c.tripwireControlPort, c.tripwirePin);
    try {
      try {
        await s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 3000 });
      } catch (err) {
        return `request fails as the tripwire hangs up (${(err as Error).name} ${(err as Error).message}); the runner must see bytes at the tripwire`;
      }
      throw new Error('the tripwire answered a request');
    } finally { s2.close(); }
  });

  await check('1-read-certificate-sends-nothing (tripwire)', async () => {
    const fp = await readCertificate(c.host, c.tripwireWrongPort, 5000);
    assert(fp === c.tripwirePin, `read ${fp}`);
    return `read ${fp} from the tripwire; the runner must see no byte`;
  });

  await check('3-authenticated-chats-list', async () => {
    const a = await s.fetch({ path: '/api/state', headers: identify(c), maxBytes: 32 << 20, limitMs: 15000 });
    assert(a.status === 200, `status ${a.status}`);
    const st = JSON.parse(a.text());
    assert(Array.isArray(st.chats), 'state.chats');
    return `200 state with chats=${st.chats.length} boards=${(st.boards || []).length} (${a.body.length} bytes, protocol ${a.protocol})`;
  });

  await check('3-secret-refused-401', async () => {
    const a = await s.fetch({ path: '/api/state', headers: identify(c, { 'X-AIWB-Secret': 'not-the-secret' }), limitMs: 10000 });
    assert(a.status === 401, `status ${a.status}`);
    return `401 ${a.text()}`;
  });

  await check('3-size-limit', async () => {
    try {
      await s.fetch({ path: '/api/state', headers: identify(c), maxBytes: 100, limitMs: 10000 });
    } catch (err) {
      assert(err instanceof NetError && err.code === 'too_long', `got ${(err as Error).name} ${(err as Error).message}`);
      // and the session still works afterwards
      const a = await s.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 });
      assert(a.status === 200, 'hello after the limit');
      return 'NetError too_long for a 100 byte limit on /api/state; the session is usable after it';
    }
    throw new Error('the body was not limited');
  });

  let boardId = '';
  await check('3-post-with-headers-and-body', async () => {
    const body = JSON.stringify({ name: 'spike ünïcode ✓ 日本語', group: '__ungrouped__' });
    const a = await s.fetch({ method: 'POST', path: '/api/boards', headers: identify(c, { 'content-type': 'application/json' }), body, limitMs: 10000 });
    assert(a.status === 200, `status ${a.status}: ${a.text()}`);
    const b = JSON.parse(a.text());
    assert(b.name === 'spike-ünïcode-✓-日本語', `name ${b.name}`); // the server turns the spaces of a name into -
    boardId = b.id;
    return `200 board ${b.id} named ${b.name}`; // body and headers arrived intact, unicode too
  });

  await check('3-timeout', async () => {
    try {
      // The event stream sends its snapshot at once; the whole body never ends: the call limit must fire.
      await s.fetch({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), limitMs: 1500, maxBytes: 1 << 30 });
    } catch (err) {
      assert(err instanceof NetError && err.code === 'timeout', `got ${(err as Error).name} ${(err as Error).message}`);
      return 'NetError timeout after 1.5 s on a never-ending body';
    }
    throw new Error('no timeout');
  });

  await check('3-cancel-a-request', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 700);
    try {
      await s.fetch({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), limitMs: 20000, maxBytes: 1 << 30, signal: ac.signal });
    } catch (err) {
      assert((err as Error).name === 'AbortError', `got ${(err as Error).name} ${(err as Error).message}`);
      return `AbortError ${Date.now() - t0} ms after the call, the signal fired at 700 ms`;
    }
    throw new Error('not cancelled');
  });

  await check('4-event-stream', async () => {
    const reader = new EventReader();
    const events: any[] = [];
    let pings = 0;
    let raw = 0;
    const firstAt: Record<string, number> = {};
    const t0 = Date.now();
    const stream = await s.stream({ path: `/api/events?client=${encodeURIComponent(c.clientId)}`, headers: identify(c, { accept: 'text/event-stream' }), headersMs: 5000 }, (text) => {
      raw += text.length;
      pings += (text.match(/^: ping$/gm) || []).length;
      for (const data of reader.push(text)) {
        const ev = JSON.parse(data);
        events.push(ev);
        if (!(ev.type in firstAt)) firstAt[ev.type] = Date.now() - t0;
      }
    });
    assert(stream.status === 200, `status ${stream.status}`);
    assert(String(stream.headers['content-type']).startsWith('text/event-stream'), `content-type ${stream.headers['content-type']}`);
    const until = async (what: string, f: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!f()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
    };
    await until('the snapshot', () => events.some((e) => e.type === 'snapshot'), 10000);
    const order = events.map((e) => e.type);
    assert(order[0] === 'hello' || order[0] === 'snapshot', `first event ${order[0]}`);
    // a change made through the same session produces an event on the stream (a request and a stream at once on one h2 connection)
    const r = await s.fetch({ method: 'POST', path: `/api/boards/${boardId}/rename`, headers: identify(c, { 'content-type': 'application/json' }), body: JSON.stringify({ name: 'renamed during the stream' }), limitMs: 10000 });
    log(`RENAME status=${r.status} ${r.text().slice(0, 120)}`);
    await until('a board event', () => events.some((e) => e.type === 'board' && e.board && e.board.name === 'renamed-during-the-stream'), 10000);
    await until('a ping', () => pings > 0, 30000);
    // cancel
    const t1 = Date.now();
    stream.cancel();
    const end = await Promise.race([stream.ended, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    assert(end !== null, 'the stream did not end after cancel');
    assert((end.error as Error).name === 'AbortError', `ended with ${end.error && (end.error as Error).name}`);
    log(`STREAM-END protocol=${end.protocol} reused=${end.reused} bytes=${end.bytes}`);
    assert(end.protocol === 'h2', `stream protocol ${end.protocol}`);
    return `order=${order.slice(0, 4).join(',')} firstAt=${JSON.stringify(firstAt)} events=${events.length} pings=${pings} chars=${raw}; cancel ended in ${Date.now() - t1} ms as AbortError; stream protocol=${end.protocol} reusedConnection=${end.reused}`;
  });

  await check('4-stream-multibyte-boundaries', async () => {
    // The native chunker holds back an incomplete UTF-8 sequence: the board name above holds 2, 3 and 4 byte characters.
    const reader = new EventReader();
    const names: string[] = [];
    const stream = await s.stream({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), headersMs: 5000 }, (text) => {
      assert(!text.includes('�'), 'a replacement character: a character was cut');
      for (const d of reader.push(text)) { const ev = JSON.parse(d); if (ev.type === 'snapshot') names.push(...(ev.boards || []).map((b: any) => b.name)); }
    });
    await new Promise((r) => setTimeout(r, 1500));
    stream.cancel();
    await stream.ended;
    assert(names.includes('renamed-during-the-stream'), `names ${JSON.stringify(names)}`);
    return `snapshot boards ${JSON.stringify(names)}`;
  });

  await check('4-silent-stream-ended-by-a-js-watchdog', async () => {
    // The Conn's rule (desktop/conn/conn.js): no byte for `silence` ends the stream. URLSession's own timeouts are set to a day, so the
    // watchdog is JS's: a timer that every chunk refreshes, and cancel().
    const SILENCE = 3000;
    const s2 = await openSession('127.0.0.1', c.stall.port, c.stall.pin);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let chunks = 0;
      let cancelledAt = 0;
      const t0 = Date.now();
      let stream: Awaited<ReturnType<Session['stream']>> | undefined;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { cancelledAt = Date.now(); stream?.cancel(); }, SILENCE); };
      stream = await s2.stream({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), headersMs: 5000 }, () => { chunks++; arm(); });
      arm();
      const end = await Promise.race([stream.ended, new Promise<null>((r) => setTimeout(() => r(null), 15000))]);
      clearTimeout(timer);
      assert(end !== null, 'the silent stream was not ended');
      assert(end.error !== null && (end.error as Error).name === 'AbortError', `ended with ${end.error && (end.error as Error).name}`);
      assert(chunks >= 1, 'no chunk arrived before the silence');
      const a = await s2.fetch({ path: '/api/hello', headers: identify(c), limitMs: 5000 });
      assert(a.status === 200 && a.reused, `the session after the cancel: ${a.status} reused=${a.reused}`);
      return `${chunks} chunk(s), silent; the watchdog fired ${cancelledAt - t0} ms after the open and the stream ended ${Date.now() - cancelledAt} ms after cancel(); the h2 connection was reused afterwards (reused=${a.reused})`;
    } finally { s2.close(); }
  });

  await check('5-error-outcomes', async () => {
    const out: string[] = [];
    const s3 = await openSession(c.host, c.closedPort, c.pin);
    out.push((await expectProblem('closed port', s3.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 }), 'refused')).outcome);
    s3.close();
    const s4 = await openSession(c.host, c.plainPort, c.pin);
    out.push((await expectProblem('plain http', s4.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 }), 'not_https')).outcome);
    s4.close();
    const s5 = await openSession('no-such-host.invalid', 443, c.pin);
    out.push((await expectProblem('unknown name', s5.fetch({ path: '/api/hello', headers: identify(c), limitMs: 10000 }), 'name_not_found')).outcome);
    s5.close();
    return out.join(', ');
  });

  await check('4-server-stops-ends-the-stream', async () => {
    const stream = await s.stream({ path: '/api/events', headers: identify(c, { accept: 'text/event-stream' }), headersMs: 5000 }, () => {});
    await new Promise((r) => setTimeout(r, 500));
    log('AWAIT-SERVER-STOP');
    const t0 = Date.now();
    const end = await Promise.race([stream.ended, new Promise<null>((r) => setTimeout(() => r(null), 60000))]);
    assert(end !== null, 'the stream did not end within 60 s of the server stopping');
    assert(!end.error || (end.error as Error).name !== 'AbortError', `ended with ${end.error && (end.error as Error).name}`);
    return `the stream ended ${Date.now() - t0} ms after the server was stopped, ${end.error ? 'with ' + (end.error as Error).name + ' ' + (end.error as Error).message : 'cleanly (the server closed the stream)'}`;
  });

  s.close();
  await check('session-closed', async () => {
    try { await s.fetch({ path: '/api/hello', headers: identify(c), limitMs: 3000 }); } catch (err) { return `${(err as Error).name} ${(err as Error).message}`; }
    throw new Error('a closed session answered');
  });

  log(`DONE ${JSON.stringify({ passed, failed })}`);
}

/** Holds the stream for c.longMs; counts what arrives; logs a heartbeat. The stream is opened again if it ends (and that is logged). */
export async function runLong(c: Config) {
  log(`START mode=long host=${c.host} port=${c.port} longMs=${c.longMs}`);
  const s = await openSession(c.host, c.port, c.pin);
  const t0 = Date.now();
  let events = 0;
  let pings = 0;
  let chars = 0;
  let boards = 0;
  let opens = 0;
  let ends = 0;
  let lastByteAt = Date.now();
  let maxSilence = 0;
  let lastName = '';
  const heartbeat = () => log(`BEAT t=${Math.round((Date.now() - t0) / 1000)}s opens=${opens} ends=${ends} events=${events} boardEvents=${boards} pings=${pings} chars=${chars} maxSilenceMs=${maxSilence} lastName=${lastName}`);
  const timer = setInterval(heartbeat, c.heartbeatMs);
  while (Date.now() - t0 < c.longMs) {
    const reader = new EventReader();
    opens++;
    try {
      const stream = await s.stream({ path: `/api/events?client=${encodeURIComponent(c.clientId)}`, headers: identify(c, { accept: 'text/event-stream' }), headersMs: 10000 }, (text) => {
        const now = Date.now();
        maxSilence = Math.max(maxSilence, now - lastByteAt);
        lastByteAt = now;
        chars += text.length;
        pings += (text.match(/^: ping$/gm) || []).length;
        for (const d of reader.push(text)) {
          events++;
          const ev = JSON.parse(d); // as the Conn parses every event
          if (ev.type === 'board') { boards++; lastName = ev.board && ev.board.name; }
        }
      });
      lastByteAt = Date.now();
      log(`STREAM-OPEN status=${stream.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
      const stop = setTimeout(() => stream.cancel(), Math.max(0, c.longMs - (Date.now() - t0)));
      const end = await stream.ended;
      clearTimeout(stop);
      ends++;
      log(`STREAM-ENDED after ${Math.round((Date.now() - t0) / 1000)}s error=${end.error ? (end.error as Error).name + ':' + (end.error as Error).message : 'none'} protocol=${end.protocol} reused=${end.reused} bytes=${end.bytes}`);
    } catch (err) {
      ends++;
      log(`STREAM-FAILED ${(err as Error).name} ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  clearInterval(timer);
  heartbeat();
  s.close();
  log(`DONE ${JSON.stringify({ events, boards, pings, chars, opens, ends, maxSilence })}`);
}
