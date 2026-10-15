// SPIKE (rn-spike-electron): a minimal Expo app, exported for the web and loaded by the Electron window. It
// shows that the loaded page sees the window's bridge (window.aiwbApp), turns it into the page's Transport, and
// makes calls through it: a fast one, one with JSON and one with bytes, a slow one that it cancels, and the
// stream. It also loads what an export carries besides code: an image, a font, a lazy chunk. Everything it
// finds goes to window.__spike, which spikes/electron/main.js reads; the window shows a summary.
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { transportFromBridge, type Bridge } from './src/bridgeTransport';

declare global {
  interface Window { aiwbApp?: Bridge; __spike?: any }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (u: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', u as unknown as ArrayBuffer));
const errInfo = (e: any) => ({ name: e?.name, message: String(e?.message ?? e), isError: e instanceof Error, isDOMException: typeof DOMException !== 'undefined' && e instanceof DOMException });

async function check(out: Record<string, any>, name: string, fn: () => Promise<any>) {
  const t0 = performance.now();
  try { out[name] = { ok: true, ...(await fn()), ms: Math.round(performance.now() - t0) }; }
  catch (e) { out[name] = { ok: false, error: errInfo(e), ms: Math.round(performance.now() - t0) }; }
}

async function run(): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const violations: any[] = [];
  document.addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.violatedDirective, blocked: String(e.blockedURI).slice(0, 80), source: e.sourceFile?.slice(-40) }));
  const scripts = Array.from(document.scripts).map((s) => s.getAttribute('src') ?? '(inline)');
  out.load = {
    href: location.href, origin: location.origin, protocol: location.protocol, scripts,
    baseURI: document.baseURI,
    expoPaths: scripts.filter((s) => s.includes('_expo')),
    rnwStyleElement: !!document.getElementById('react-native-stylesheet'),
    cssRules: (document.getElementById('react-native-stylesheet') as HTMLStyleElement | null)?.sheet?.cssRules.length ?? null,
  };
  const bridge = window.aiwbApp;
  out.bridge = { present: typeof bridge, keys: bridge ? Object.keys(bridge).sort() : null, leaks: [typeof (window as any).require, typeof (window as any).Buffer], processGlobal: typeof (window as any).process === 'undefined' ? 'undefined' : { keys: Object.keys((window as any).process).slice(0, 8), versions: (window as any).process.versions ?? null, type: (window as any).process.type ?? null } };
  if (!bridge) return out;
  const t = transportFromBridge(bridge);
  const answer = (a: { text: string }) => JSON.parse(a.text);

  await check(out, 'call.fast', async () => { const a = await t.call({ server: 'local', method: 'GET', path: '/api/fast' }); return { status: a.status, sceneRev: a.sceneRev, body: answer(a) }; });
  await check(out, 'call.json', async () => { const a = await t.call({ server: 'local', method: 'POST', path: '/api/echo', body: { json: '{"name":"g"}' } }); return { status: a.status, body: answer(a) }; });
  await check(out, 'call.refused (face check: a path outside nothing fake; bad method)', async () => {
    try { await t.call({ server: 'local', method: 'TRACE' as any, path: '/api/fast' }); return { rejected: false }; }
    catch (e: any) { return { rejected: true, error: errInfo(e), isTransportError: e?.name === 'TransportError' }; }
  });

  // bytes: a pattern of 1 MB, as a Uint8Array, as a view into a bigger buffer, as a Blob
  const pattern = (n: number, seed: number) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255; return u; };
  await check(out, 'call.bytes.uint8array', async () => {
    const u = pattern(1 << 20, 1); const want = await sha256(u);
    const a = await t.call({ server: 'local', method: 'POST', path: '/api/bytes', body: { bytes: u, type: 'application/octet-stream' } });
    return { status: a.status, got: answer(a), wantSha: want, intact: answer(a).sha256 === want && answer(a).length === u.length };
  });
  await check(out, 'call.bytes.view (1000 bytes at offset 5000 of a 1 MB buffer)', async () => {
    const big = pattern(1 << 20, 2); const v = big.subarray(5000, 6000); const want = await sha256(v);
    const a = await t.call({ server: 'local', method: 'POST', path: '/api/bytes', body: { bytes: v, type: 'image/png' } });
    return { got: answer(a), intact: answer(a).sha256 === want && answer(a).length === 1000 && answer(a).type === 'image/png' };
  });
  await check(out, 'call.bytes.blob', async () => {
    const u = pattern(1 << 20, 3); const want = await sha256(u);
    const a = await t.call({ server: 'local', method: 'POST', path: '/api/bytes', body: { bytes: new Blob([u]), type: 'image/png' } });
    return { got: answer(a), intact: answer(a).sha256 === want };
  });
  await check(out, 'call.bytes.20MB (as a Uint8Array)', async () => {
    const u = pattern(20 << 20, 4); const want = await sha256(u); const t0 = performance.now();
    const a = await t.call({ server: 'local', method: 'POST', path: '/api/bytes', body: { bytes: u, type: 'image/png' } });
    return { intact: answer(a).sha256 === want, ms: Math.round(performance.now() - t0) };
  });

  // cancel by identifier
  await check(out, 'cancel.slowCall', async () => {
    const ac = new AbortController(); const t0 = performance.now();
    const p = t.call({ server: 'local', method: 'GET', path: '/api/slow/1', signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    try { await p; return { rejected: false }; }
    catch (e: any) { return { rejected: true, afterMs: Math.round(performance.now() - t0), error: errInfo(e), isSignalReason: e === ac.signal.reason }; }
  });
  await check(out, 'cancel.withReason', async () => {
    const ac = new AbortController(); const mine = new Error('my reason');
    const p = t.call({ server: 'local', method: 'GET', path: '/api/slow/2', signal: ac.signal });
    setTimeout(() => ac.abort(mine), 100);
    try { await p; return { rejected: false }; } catch (e: any) { return { rejected: true, isMyReason: e === mine }; }
  });
  await check(out, 'cancel.alreadyAborted (never sent)', async () => {
    const ac = new AbortController(); ac.abort();
    try { await t.call({ server: 'local', method: 'GET', path: '/api/slow/3-never-sent', signal: ac.signal }); return { rejected: false }; }
    catch (e: any) { return { rejected: true, error: errInfo(e) }; }
  });
  await check(out, 'cancel.afterFinished (no effect)', async () => {
    const ac = new AbortController();
    const a = await t.call({ server: 'local', method: 'GET', path: '/api/fast', signal: ac.signal });
    ac.abort(); await sleep(100);
    return { status: a.status };
  });
  await check(out, 'cancel.duringBlobRead (abort while the body is still being read)', async () => {
    const ac = new AbortController(); const u = new Uint8Array(30 << 20);
    const p = t.call({ server: 'local', method: 'POST', path: '/api/bytes-never-sent', body: { bytes: new Blob([u]), type: 'image/png' }, signal: ac.signal });
    ac.abort();
    try { await p; return { rejected: false }; } catch (e: any) { return { rejected: true, error: errInfo(e) }; }
  });
  await check(out, 'cancel.concurrent (40 calls, the odd ones cancelled)', async () => {
    const acs = Array.from({ length: 40 }, () => new AbortController());
    const ps = acs.map((ac, i) => t.call({ server: 'local', method: 'GET', path: `/api/many/${i}`, signal: ac.signal }).then((a) => ({ i, status: a.status, path: answer(a).path }), (e) => ({ i, rejected: errInfo(e) })));
    await sleep(100);
    acs.forEach((ac, i) => { if (i % 2) ac.abort(); });
    const rs = await Promise.all(ps);
    const evens = rs.filter((r: any) => r.i % 2 === 0); const odds = rs.filter((r: any) => r.i % 2 === 1);
    return {
      evensAnswered: evens.every((r: any) => r.status === 200 && r.path === `/api/many/${r.i}`),
      oddsRejectedAsAbort: odds.every((r: any) => r.rejected && r.rejected.name === 'AbortError'),
      evens: evens.length, odds: odds.length,
    };
  });

  // the stream: five events, one of them 50,000 characters, then closed
  await check(out, 'stream', async () => {
    const got: any[] = []; const states: string[] = [];
    const s = t.stream((e) => got.push(e), (st) => states.push(st));
    const t0 = performance.now();
    while (got.length < 5 && performance.now() - t0 < 10000) await sleep(20);
    s.close(); await sleep(150);
    const after = got.length;
    return { n: got.length, order: got.map((e: any) => e.event.n), bigPad: got.find((e: any) => e.event.n === 3)?.event.pad.length, states, afterClose: got.length - after };
  });
  await check(out, 'pictureURL', async () => ({ url: t.pictureURL('local', 'c1', 'a'.repeat(64)) }));
  await check(out, 'app', async () => { const a = await t.app('servers.list'); return { status: a.status, text: a.text }; });

  await check(out, 'bench.calls (500 in a row, then 500 at once; fast path)', async () => {
    let t0 = performance.now();
    for (let i = 0; i < 500; i++) await t.call({ server: 'local', method: 'GET', path: '/api/fast' });
    const seq = performance.now() - t0;
    t0 = performance.now();
    await Promise.all(Array.from({ length: 500 }, () => t.call({ server: 'local', method: 'GET', path: '/api/fast' })));
    const par = performance.now() - t0;
    return { perCallMsInARow: +(seq / 500).toFixed(3), perCallMsAtOnce: +(par / 500).toFixed(3) };
  });

  // what an export carries besides code
  await check(out, 'lazy chunk (import())', async () => { const m = await import('./src/lazy'); return { value: m.lazyValue }; });
  await check(out, 'asset image (require(./assets/icon.png) shown by <Image>)', async () => {
    await sleep(50);
    const img = document.querySelector('img') as HTMLImageElement | null;
    if (!img) return { found: false };
    await img.decode().catch(() => {});
    return { found: true, src: img.currentSrc.slice(-60), loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth };
  });
  await check(out, 'font (expo-font, Ionicons.ttf)', async () => {
    const ok = await document.fonts.load('16px ionicons').then((l) => l.length > 0).catch(() => false);
    return { loaded: ok, faces: Array.from(document.fonts).map((f) => `${f.family}:${f.status}`) };
  });
  await check(out, 'wasm (a 8-byte empty module)', async () => {
    const m = await WebAssembly.compile(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    return { compiled: m instanceof WebAssembly.Module };
  });
  await check(out, 'eval / new Function', async () => { try { return { works: new Function('return 1')() === 1 }; } catch (e: any) { return { works: false, error: String(e.message).slice(0, 80) }; } });
  await sleep(100);
  out.cspViolations = violations;
  out.load.cssRulesAfter = (document.getElementById('react-native-stylesheet') as HTMLStyleElement | null)?.sheet?.cssRules.length ?? null;
  out.load.inlineStyleElements = document.querySelectorAll('style').length;
  return out;
}

export default function App() {
  const [text, setText] = useState('running…');
  useEffect(() => {
    run().then(
      (r) => { window.__spike = { ...r, done: true }; setText(`bridge: ${r.bridge?.present}; checks: ${Object.keys(r).length}`); },
      (e) => { window.__spike = { done: true, fatal: String(e?.stack ?? e) }; setText(`failed: ${e}`); },
    );
  }, []);
  return (
    <View style={styles.container}>
      <Text testID="summary">{text}</Text>
      <Image source={require('./assets/icon.png')} style={{ width: 48, height: 48 }} />
      <Ionicons name="checkmark-circle" size={32} color="green" />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
