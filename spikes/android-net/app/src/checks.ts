// The checks of the spike. Each reports one line `AIWBSPIKE {json}` (native Log.i, tag AIWBSPIKE) that
// run.sh reads from `adb logcat`. The configuration arrives in the launch URL: aiwbspike://run?cfg=<json>.

import { EventReader, Problem, Session, echoBytes, log, memory, readCertificate, sessionStats, sleep, stateOf, type Target } from './net';

export type Config = {
  host: string; port: number; pin: string; secret: string;
  dottedHost: string; closedPort: number; plainPort: number; probeWrongPort: number; probeControlPort: number; probePin: string; h2Port: number;
  minutes: number; idleMinutes: number; mutateEverySec: number;
};

const results: { name: string; ok: boolean }[] = [];
const emit = (o: object) => log('AIWBSPIKE ' + JSON.stringify(o));

function report(name: string, ok: boolean, info: object = {}) {
  results.push({ name, ok });
  emit({ check: name, ok, ...info });
}

async function check(name: string, f: () => Promise<object | void>) {
  try {
    const info = (await f()) || {};
    report(name, true, info);
  } catch (e: any) {
    report(name, false, { error: e instanceof Problem ? { outcome: e.outcome, detail: e.detail } : String(e && e.message || e) });
  }
}

function expect(cond: boolean, what: string) { if (!cond) throw new Error('expected ' + what); }

async function expectProblem(f: () => Promise<unknown>, outcome: string): Promise<Problem> {
  try { await f(); } catch (e) {
    if (e instanceof Problem && e.outcome === outcome) return e;
    throw new Error(`expected outcome ${outcome}, got ${e instanceof Problem ? e.outcome + ' (' + e.detail + ')' : e}`);
  }
  throw new Error(`expected outcome ${outcome}, got success`);
}

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

/** The pin with one hex digit changed. */
function wrongPin(pin: string) {
  return (pin[0] === 'A' ? 'B' : 'A') + pin.slice(1);
}

export async function runChecks(cfg: Config) {
  const t0 = Date.now();
  const clientId = uuid();
  const target: Target = { host: cfg.host, port: cfg.port, pin: cfg.pin, secret: cfg.secret, clientId };
  emit({ start: true, cfg: { ...cfg, secret: '<secret>' }, clientId });

  // 1. Connector.
  await check('cert_read_without_trust', async () => {
    const fp = await readCertificate(cfg.host, cfg.port);
    expect(fp === cfg.pin, `fingerprint ${fp} == pin ${cfg.pin}`);
    return { fingerprint: fp };
  });
  await check('cert_read_refused_port', async () => {
    const p = await expectProblem(() => readCertificate(cfg.host, cfg.closedPort), 'refused');
    return { outcome: p.outcome, state: stateOf(p.outcome), detail: p.detail };
  });
  await check('cert_read_plain_http_port', async () => {
    const p = await expectProblem(() => readCertificate(cfg.host, cfg.plainPort), 'not_https');
    return { outcome: p.outcome, detail: p.detail };
  });
  let session!: Session;
  await check('session_open_right_pin', async () => {
    session = await Session.open(target);
    expect(session.fingerprint === cfg.pin, 'session fingerprint is the pin');
    return { alpn: session.alpn, fingerprint: session.fingerprint };
  });
  await check('session_open_lowercase_pin_no_colons', async () => {
    const s = await Session.open({ ...target, pin: cfg.pin.replace(/:/g, '').toLowerCase() });
    s.close();
  });
  await check('session_open_wrong_pin_real_server', async () => {
    const bad = wrongPin(cfg.pin);
    const p = await expectProblem(() => Session.open({ ...target, pin: bad }), 'cert_changed');
    expect(p.fingerprint === cfg.pin, 'presented fingerprint reported');
    expect(p.pinned === bad, 'pinned reported');
    expect(stateOf(p.outcome) === 'certificate_changed', 'state certificate_changed');
    return { outcome: p.outcome, state: stateOf(p.outcome), presented: p.fingerprint, pinned: p.pinned };
  });
  await check('session_open_no_pin', async () => {
    const p = await expectProblem(() => Session.open({ ...target, pin: '' }), 'fingerprint');
    return { outcome: p.outcome, state: stateOf(p.outcome) };
  });
  await check('session_open_garbage_pin', async () => {
    const p = await expectProblem(() => Session.open({ ...target, pin: 'not a fingerprint' }), 'cert_changed');
    return { outcome: p.outcome, pinned: p.pinned };
  });
  // The probe server counts the application bytes it receives after a handshake (run.sh reads its log):
  // wrong pin -> 0 bytes; right pin -> the client preface and a request, to which it never answers.
  await check('wrong_pin_probe_server_sends_nothing', async () => {
    const p = await expectProblem(() => Session.open({ ...target, port: cfg.probeWrongPort }), 'cert_changed');
    return { outcome: p.outcome, presented: p.fingerprint };
  });
  // The same refusal on the connection the requests make themselves (no preflight handshake): the session
  // exists, the first request connects, the trust manager refuses inside that handshake, nothing is written.
  await check('wrong_pin_on_the_requests_own_connection_probe_gets_nothing', async () => {
    const s = await Session.open({ ...target, port: cfg.probeWrongPort }, 3000, 3000, false);
    try {
      const p = await expectProblem(() => s.fetch({ path: '/api/state', headers: s.identify(), limitMs: 5000 }), 'cert_changed');
      expect(p.fingerprint === cfg.probePin, 'presented fingerprint is the probe\'s, got ' + p.fingerprint);
      return { outcome: p.outcome, presented: p.fingerprint, pinned: p.pinned };
    } finally { s.close(); }
  });
  await check('right_pin_probe_server_gets_request_and_times_out', async () => {
    const s = await Session.open({ ...target, port: cfg.probeControlPort, pin: cfg.probePin });
    try {
      const p = await expectProblem(() => s.fetch({ path: '/api/hello', headers: s.identify(), limitMs: 2500 }), 'timeout');
      return { outcome: p.outcome };
    } finally { s.close(); }
  });

  // 2 and 3. HTTP/2, requests with headers, body and a limit.
  await check('hello_h2', async () => {
    const r = await session.fetch({ path: '/api/hello', headers: session.identify(), limitMs: 10000, maxBytes: 4096 });
    expect(r.status === 200, 'status 200');
    expect(r.protocol === 'h2', 'protocol h2, got ' + r.protocol);
    const h = r.json();
    expect(h.app === 'ai-whiteboard', 'app');
    return { status: r.status, protocol: r.protocol, hello: h, headers: r.headers };
  });
  await check('state_authenticated', async () => {
    const r = await session.fetch({ path: '/api/state', headers: session.identify(), limitMs: 10000 });
    expect(r.status === 200, 'status 200');
    expect(r.protocol === 'h2', 'h2');
    const s = r.json();
    return { status: r.status, protocol: r.protocol, bytes: r.bytes, keys: Object.keys(s), chats: Array.isArray(s.chats) ? s.chats.length : null };
  });
  await check('state_wrong_secret_is_401', async () => {
    const r = await session.fetch({ path: '/api/state', headers: session.identify({ 'x-aiwb-secret': 'wrong' }) });
    expect(r.status === 401, 'status 401, got ' + r.status);
    return { status: r.status, body: r.body };
  });
  await check('response_size_limit', async () => {
    const p = await expectProblem(() => session.fetch({ path: '/api/state', headers: session.identify(), maxBytes: 10 }), 'too_long');
    // and the session still works after the cancelled stream of the body
    const r = await session.fetch({ path: '/api/hello', headers: session.identify() });
    expect(r.status === 200, 'session usable after too_long');
    return { outcome: p.outcome };
  });
  let groupId = '';
  await check('post_with_json_body', async () => {
    const r = await session.fetch({
      method: 'POST', path: '/api/groups', headers: session.identify({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'spike ünïcödé ✓', parent: '' }), limitMs: 10000,
    });
    expect(r.status === 200, 'status 200, got ' + r.status + ' ' + r.body);
    groupId = r.json().id ?? r.json().ID ?? '';
    expect(!!groupId, 'group id in ' + r.body);
    return { status: r.status, body: r.body.slice(0, 200) };
  });
  await check('abort_a_request', async () => {
    const ac = new AbortController();
    const slow = await Session.open({ ...target, port: cfg.probeControlPort, pin: cfg.probePin });
    try {
      const p = slow.fetch({ path: '/api/hello', headers: slow.identify(), signal: ac.signal, limitMs: 20000 });
      setTimeout(() => ac.abort(), 300);
      const e = await expectProblem(() => p, 'aborted');
      return { outcome: e.outcome };
    } finally { slow.close(); }
  });

  // A dotted DNS name (iOS needs NSAllowsArbitraryLoads for it): the server was set up with this name too.
  await check('hello_by_dotted_dns_name', async () => {
    let s: Session;
    try { s = await Session.open({ ...target, host: cfg.dottedHost }); } catch (e) {
      if (e instanceof Problem && e.outcome === 'name_not_found') return { skipped: 'the emulator cannot resolve ' + cfg.dottedHost, detail: e.detail };
      throw e;
    }
    try {
      const r = await s.fetch({ path: '/api/hello', headers: s.identify({}), limitMs: 10000 });
      expect(r.status === 200 && r.protocol === 'h2', 'hello over h2 by name');
      return { host: cfg.dottedHost, status: r.status, protocol: r.protocol };
    } finally { s.close(); }
  });
  await check('one_h2_connection_for_a_stream_and_8_concurrent_requests', async () => {
    const s = await Session.open(target);
    try {
      const st = await s.stream({ path: `/api/events?client=${encodeURIComponent(clientId)}`, headers: s.identify({ accept: 'text/event-stream' }), headersMs: 3000, onChunk: () => {} });
      const rs = await Promise.all(Array.from({ length: 8 }, () => s.fetch({ path: '/api/state', headers: s.identify(), limitMs: 10000 })));
      expect(rs.every((r) => r.status === 200 && r.protocol === 'h2'), 'all 200 over h2');
      const stats = sessionStats(s);
      expect(stats.connects === 1, 'one connection, got ' + stats.connects);
      st.cancel();
      return stats;
    } finally { s.close(); }
  });
  await check('uint8array_round_trip_through_the_bridge', async () => {
    const n = 1 << 20;
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 255;
    const t = Date.now();
    const b = echoBytes(a);
    const ms = Date.now() - t;
    expect(b instanceof Uint8Array && b.length === n, 'a Uint8Array of the same length back, got ' + (b && b.constructor && b.constructor.name));
    for (let i = 0; i < n; i += 4093) expect(b[i] === a[n - 1 - i], 'byte ' + i);
    return { bytes: n, ms };
  });

  // The three ways a stream ends, and a stream that goes silent, against a Node HTTP/2 server (same certificate as the probe).
  const h2 = { ...target, port: cfg.h2Port, pin: cfg.probePin };
  const openStream = async (s: Session, path: string) => {
    const texts: string[] = [];
    const st = await s.stream({ path, headers: s.identify({ accept: 'text/event-stream' }), headersMs: 3000, onChunk: (t) => texts.push(t) });
    return { st, texts };
  };
  const endOf = (st: { ended: Promise<string> }, ms = 4000) => Promise.race([st.ended, sleep(ms).then(() => 'NO_END')]);
  await check('stream_ended_by_the_server_is_end_with_no_error', async () => {
    const s = await Session.open(h2);
    try {
      const { st, texts } = await openStream(s, '/end');
      const why = await endOf(st);
      expect(why === '', 'clean end, got ' + why);
      expect(texts.join('').includes('héllo ✓'), 'UTF-8 text intact');
      return { head: st.head.protocol, text: texts.join('').slice(0, 80) };
    } finally { s.close(); }
  });
  await check('stream_cut_by_a_dropped_connection_is_end_with_reset', async () => {
    const s = await Session.open(h2);
    try {
      const { st } = await openStream(s, '/reset');
      const why = await endOf(st);
      expect(why === 'reset', 'reset, got ' + why);
      // OkHttp does not tell that the connection is gone: the next request simply opens a new one (a new pin check).
      const r = await s.fetch({ path: '/nothing', headers: s.identify(), limitMs: 3000 });
      expect(r.status === 404, 'the next request works');
      return { error: why, nextRequestStatus: r.status, connects: sessionStats(s).connects };
    } finally { s.close(); }
  });
  await check('silent_stream_is_cut_by_a_js_watchdog_with_cancel', async () => {
    const s = await Session.open(h2);
    try {
      const { st, texts } = await openStream(s, '/silent');
      let last = Date.now();
      let n = texts.length;
      while (Date.now() - last < 3000) { await sleep(200); if (texts.length !== n) { n = texts.length; last = Date.now(); } }
      const t = Date.now();
      st.cancel();
      const why = await endOf(st, 3000);
      expect(why === 'aborted', 'aborted, got ' + why);
      return { silentMs: t - last, cancelMs: Date.now() - t };
    } finally { s.close(); }
  });

  // 4. The event stream.
  const query = `/api/events?client=${encodeURIComponent(clientId)}`;
  await check('stream_snapshot_first_then_events_and_cancel', async () => {
    const reader = new EventReader();
    const types: string[] = [];
    let chunks = 0;
    const s = await session.stream({
      path: query, headers: session.identify({ accept: 'text/event-stream' }), headersMs: 3000,
      onChunk: (text) => { chunks++; for (const raw of reader.push(text)) { try { types.push(JSON.parse(raw).type); } catch { types.push('?'); } } },
    });
    expect(s.head.status === 200, 'stream status 200');
    expect(s.head.protocol === 'h2', 'stream h2');
    expect(String(s.head.headers['content-type']).startsWith('text/event-stream'), 'content-type event-stream');
    for (let i = 0; i < 50 && !types.includes('snapshot'); i++) await sleep(100);
    // the server opens the stream with a hello event, then the snapshot: nothing else comes before it
    const at = types.indexOf('snapshot');
    expect(at >= 0 && types.slice(0, at).every((t) => t === 'hello'), 'snapshot first (after hello), got ' + JSON.stringify(types));
    // an event after the snapshot: rename the group
    const before = types.length;
    await session.fetch({
      method: 'PATCH', path: `/api/groups/${groupId}`, headers: session.identify({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'renamed' }),
    });
    for (let i = 0; i < 50 && types.length === before; i++) await sleep(100);
    expect(types.length > before, 'an event after the change');
    const t1 = Date.now();
    s.cancel();
    const why = await Promise.race([s.ended, sleep(3000).then(() => 'NO_END')]);
    expect(why === 'aborted', 'cancel ends the stream with aborted, got ' + why);
    return { types, chunks, cancelMs: Date.now() - t1, head: s.head };
  });
  await check('stream_open_cancel_x10_then_session_still_works', async () => {
    for (let i = 0; i < 10; i++) {
      const s = await session.stream({ path: query, headers: session.identify({ accept: 'text/event-stream' }), headersMs: 3000, onChunk: () => {} });
      await sleep(50);
      s.cancel();
      const why = await Promise.race([s.ended, sleep(3000).then(() => 'NO_END')]);
      expect(why === 'aborted', 'end aborted #' + i + ', got ' + why);
    }
    const r = await session.fetch({ path: '/api/hello', headers: session.identify() });
    expect(r.status === 200 && r.protocol === 'h2', 'hello after cancels');
  });
  await check('stream_ends_when_session_closes', async () => {
    const s2 = await Session.open(target);
    const s = await s2.stream({ path: query, headers: s2.identify({ accept: 'text/event-stream' }), headersMs: 3000, onChunk: () => {} });
    await sleep(200);
    s2.close();
    const why = await Promise.race([s.ended, sleep(3000).then(() => 'NO_END')]);
    expect(why !== 'NO_END', 'closeSession ends the stream, got ' + why);
    return { error: why };
  });

  emit({ summary: 'short checks', pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).map((r) => r.name) });

  // 5. The long stream.
  if (cfg.minutes > 0) await longStream(cfg, session, clientId, groupId);

  try { session.close(); } catch { /* gone */ }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  emit({ done: true, pass: results.filter((r) => r.ok).length, fail: failed, seconds: Math.round((Date.now() - t0) / 1000) });
}

async function longStream(cfg: Config, session: Session, clientId: string, groupId: string) {
  // Seed the board with groups so that each change makes an event of some kilobytes (the groups event holds all of them).
  let seeded = 0;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await session.fetch({
        method: 'POST', path: '/api/groups', headers: session.identify({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: `seed ${i} ` + 'y'.repeat(100), parent: '' }),
      });
      if (r.status === 200) seeded++;
    } catch { /* counted by seeded */ }
  }
  emit({ long: 'seeded', groups: seeded });
  const reader = new EventReader();
  const counts: Record<string, number> = {};
  let chunks = 0; let chars = 0; let lastChunk = Date.now(); let maxGap = 0; let eventsTotal = 0; let pings = 0;
  let idleStart = 0; let idleMaxGap = 0; let idlePings = 0;
  let endedWith: string | null = null;
  const s = await session.stream({
    path: `/api/events?client=${encodeURIComponent(clientId)}`, headers: session.identify({ accept: 'text/event-stream' }), headersMs: 3000,
    onChunk: (text) => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - lastChunk);
      const np = text.split(': ping').length - 1; // the server's keep-alive: a comment line
      pings += np;
      if (idleStart) { idleMaxGap = Math.max(idleMaxGap, now - lastChunk); idlePings += np; }
      lastChunk = now; chunks++; chars += text.length;
      for (const raw of reader.push(text)) {
        eventsTotal++;
        let type = '?';
        try { type = JSON.parse(raw).type; } catch { /* counted as ? */ }
        counts[type] = (counts[type] || 0) + 1;
      }
    },
  });
  s.ended.then((e) => { endedWith = e; });
  emit({ long: 'start', head: s.head, minutes: cfg.minutes, idleMinutes: cfg.idleMinutes });
  const startAt = Date.now();
  const end = startAt + cfg.minutes * 60000;
  const activeEnd = end - cfg.idleMinutes * 60000; // the last idleMinutes: no change is made, the stream is held idle
  let n = 0; let lastTick = 0; let mutations = 0;
  while (Date.now() < end && endedWith === null) {
    await sleep(cfg.mutateEverySec * 1000);
    n++;
    if (Date.now() >= activeEnd) {
      if (!idleStart) { idleStart = Date.now(); lastChunk = idleStart; emit({ long: 'idle_begins', elapsedSec: Math.round((idleStart - startAt) / 1000) }); }
    } else try {
      const r = await session.fetch({
        method: 'PATCH', path: `/api/groups/${groupId}`, headers: session.identify({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: `renamed ${n} ` + 'x'.repeat(n % 100) }), limitMs: 10000,
      });
      if (r.status === 200) mutations++;
    } catch (e: any) { emit({ long: 'mutation_failed', error: e && e.outcome || String(e) }); }
    if (Date.now() - lastTick >= 60000) {
      lastTick = Date.now();
      emit({ long: 'tick', elapsedSec: Math.round((Date.now() - startAt) / 1000), chunks, chars, events: eventsTotal, pings, idle: !!idleStart, counts, mutations, maxGapMs: maxGap, mem: memory() });
    }
  }
  const idleSec = idleStart ? (Date.now() - idleStart) / 1000 : 0;
  emit({ long: 'end', endedWith, chunks, chars, events: eventsTotal, pings, counts, mutations, maxGapMs: maxGap, idleSec: Math.round(idleSec), idlePings, idleMaxGapMs: idleMaxGap, mem: memory() });
  const held = endedWith === null;
  results.push({ name: 'long_stream_held', ok: held });
  emit({ check: 'long_stream_held', ok: held, endedWith, seconds: Math.round((Date.now() - startAt) / 1000) });
  if (cfg.idleMinutes > 0) {
    // pings every 20 s while idle; allow a lost one or two
    const want = Math.floor(idleSec / 20) - 2;
    const pingsOk = idlePings >= want && idleMaxGap < 45000;
    results.push({ name: 'idle_stream_gets_pings', ok: pingsOk });
    emit({ check: 'idle_stream_gets_pings', ok: pingsOk, idleSec: Math.round(idleSec), idlePings, wantAtLeast: want, idleMaxGapMs: idleMaxGap });
  }
  s.cancel();
  await Promise.race([s.ended, sleep(3000)]);
}
