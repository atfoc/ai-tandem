#!/usr/bin/env node
// Repeatable run of the Android network spike (see plans/rn-rewrite/spikes/android-net.md).
//
//   node spikes/android-net/run.mjs [--minutes 21] [--idle-minutes 3] [--no-build] [--keep-emulator] [--sample-every 180]
//
// The stream is held for --minutes in all (0 = the short checks only); the last --idle-minutes of them nothing is changed,
// so that only the server's pings arrive.
//
// It: builds the server and starts a SCRATCH server (never the user's: its own -home and port), starts a probe
// (a TLS server that counts the bytes it is sent, and a plain TCP one), takes the emulator (lock
// /tmp/aiwb-android-emulator.lock) and boots it when it is not running, builds and installs the app (release
// variant, JS bundled, no Metro), starts it with a launch URL that holds the configuration, reads the result lines
// the app writes to logcat with the tag AIWBSPIKE, samples `dumpsys meminfo` during the long stream, checks the
// probe's counts, and cleans up (scratch server, probe, adb reverse, app, lock; the emulator too unless
// --keep-emulator). Exit code 0 only when every check passed. Output: spikes/android-net/out/ (not committed).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const appDir = path.join(here, 'app');
const outDir = path.join(here, 'out');
const PKG = 'dev.aiwb.netspike';
const LOCK = '/tmp/aiwb-android-emulator.lock';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
const MINUTES = Number(opt('minutes', '21'));
const SAMPLE_EVERY = Number(opt('sample-every', '180'));
const DOTTED = 'localtest.me'; // resolves to 127.0.0.1 (public DNS); the scratch server is set up with it too
const IDLE = Number(opt('idle-minutes', '3'));
const MUTATE_EVERY = Number(opt('mutate-every', '1'));

const ANDROID_HOME = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
const JAVA_HOME = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
const env = {
  ...process.env, ANDROID_HOME, JAVA_HOME,
  PATH: [path.join(JAVA_HOME, 'bin'), path.join(ANDROID_HOME, 'platform-tools'), path.join(ANDROID_HOME, 'emulator'), process.env.PATH].join(':'),
};
const adbBin = path.join(ANDROID_HOME, 'platform-tools/adb');
const adb = (...a) => execFileSync(adbBin, a, { env, encoding: 'utf8', maxBuffer: 64 << 20 });
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanups = [];
let lockTaken = false;
async function cleanup() {
  for (const f of cleanups.reverse()) { try { await f(); } catch (e) { say('cleanup:', e.message); } }
  cleanups.length = 0;
  if (lockTaken) { try { fs.rmdirSync(LOCK); } catch { /* gone */ } lockTaken = false; }
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('uncaughtException', async (e) => { console.error(e); await cleanup(); process.exit(1); });

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej);
});
const run = (cmd, args, o = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, { env, ...o });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-android-net-'));
  say('scratch folder', tmp);

  // The emulator: one agent at a time.
  try { fs.mkdirSync(LOCK); lockTaken = true; } catch { throw new Error(`${LOCK} is held: another agent uses the emulator`); }

  // The scratch server.
  const bin = path.join(tmp, 'ai-whiteboard');
  say('go build');
  execFileSync('go', ['build', '-o', bin, './cmd/ai-whiteboard'], { cwd: repo, env, stdio: 'inherit' });
  const home = path.join(tmp, 'home'); const work = path.join(tmp, 'work');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const port = await freePort();
  const senv = { ...env, AIWB_MCP_PORT: '0', AIWB_REMOTE_BIND: '127.0.0.1', CURSOR_CONFIG_DIR: path.join(tmp, 'cursor') };
  const setup = execFileSync(bin, ['remote', 'setup', '-home', home, '-port', String(port), '-name', '127.0.0.1', '-name', DOTTED], { env: senv, encoding: 'utf8' });
  const pin = /^Fingerprint:\s*(\S+)/m.exec(setup)?.[1];
  const secret = fs.readFileSync(path.join(home, 'remote-secret'), 'utf8').trim();
  if (!pin || !secret) throw new Error('remote setup gave no fingerprint or secret');
  cleanups.push(async () => { say('stop scratch server'); await run(bin, ['stop', '-home', home], { env: senv }); });
  const launch = await run(bin, ['launch', '-json', '-home', home, '-cwd', work, '-claude', '/nonexistent/claude', '-cursor', '/nonexistent/agent', '-pi', '/nonexistent/pi', '-cursor-cost', '/nonexistent/cursor-cost'], { env: senv });
  if (launch.code !== 0) throw new Error('launch failed: ' + launch.err + launch.out);
  say(`scratch server on 127.0.0.1:${port}, pin ${pin}`);

  // The probe.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=probe'], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(tmp, 'c.pem'));
  const probePin = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex').toUpperCase().match(/../g).join(':');
  const probeLog = [];
  const probeServer = (label) => new Promise(async (resolve) => {
    const srv = tls.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert, ALPNProtocols: ['h2'] }, (sock) => {
      const rec = { label, secure: true, bytes: 0, alpn: sock.alpnProtocol };
      probeLog.push(rec);
      sock.on('data', (d) => { rec.bytes += d.length; });
      sock.on('error', () => {});
    });
    srv.on('tlsClientError', () => probeLog.push({ label, secure: false, bytes: 0, tlsClientError: true }));
    const p = await freePort();
    srv.listen(p, '127.0.0.1', () => resolve({ srv, port: p }));
    cleanups.push(() => new Promise((r) => { srv.close(); r(); }));
  });
  const wrong = await probeServer('wrong-pin'); const control = await probeServer('right-pin');
  // An HTTP/2 server (Node's, not the Go one) with an event stream that ends, whose connection drops, or that goes silent.
  const h2srv = http2.createSecureServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert });
  const rawSockets = new Map(); // the TCP socket of each HTTP/2 session (Node refuses socket calls on session.socket)
  h2srv.on('connection', (sock) => { sock.on('error', () => {}); sock.once('data', () => {}); h2srv.once('session', (ss) => { ss.on('error', () => {}); rawSockets.set(ss, sock); }); });
  h2srv.on('stream', (st, h) => {
    st.on('error', () => {});
    const p = h[':path'];
    if (!['/silent', '/end', '/reset'].includes(p)) { st.respond({ ':status': 404 }); st.end(); return; }
    st.respond({ ':status': 200, 'content-type': 'text/event-stream' });
    const ev = (t) => `data: ${JSON.stringify({ type: t, text: 'héllo ✓' })}\n\n`;
    if (p === '/end') st.end(ev('hello') + ev('snapshot'));
    else if (p === '/reset') { st.write(ev('hello') + ev('snapshot')); setTimeout(() => rawSockets.get(st.session)?.destroy(), 300); } // the connection drops
    else st.write(ev('hello') + ev('snapshot')); // /silent: two events, then nothing, the stream stays open
  });
  const h2Port = await new Promise((r) => h2srv.listen(0, '127.0.0.1', () => r(h2srv.address().port)));
  cleanups.push(() => new Promise((r) => { h2srv.close(); r(); }));
  const plainSrv = net.createServer((s) => { s.on('error', () => {}); s.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); });
  const plainPort = await new Promise((r) => plainSrv.listen(0, '127.0.0.1', () => r(plainSrv.address().port)));
  cleanups.push(() => plainSrv.close());
  const closedPort = await freePort();

  // The emulator.
  let started = null;
  if (!adb('devices').includes('emulator-')) {
    say('starting the emulator');
    started = spawn(path.join(ANDROID_HOME, 'emulator/emulator'), ['-avd', 'Medium_Phone_API_36.1', '-no-snapshot', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect'], { env, detached: true, stdio: 'ignore' });
    started.unref();
    for (let i = 0; i < 90; i++) { await sleep(5000); try { if (adb('shell', 'getprop', 'sys.boot_completed').trim() === '1') break; } catch { /* not yet */ } }
  }
  if (!flag('keep-emulator')) cleanups.push(() => { say('stop emulator'); try { adb('emu', 'kill'); } catch { /* gone */ } });
  say('device', adb('shell', 'getprop', 'ro.product.model').trim(), 'API', adb('shell', 'getprop', 'ro.build.version.sdk').trim(), adb('shell', 'getprop', 'ro.product.cpu.abi').trim());
  adb('shell', 'svc', 'power', 'stayon', 'true');
  cleanups.push(() => { try { adb('shell', 'svc', 'power', 'stayon', 'false'); } catch { /* gone */ } });
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  for (const p of [port, plainPort, h2Port, wrong.port, control.port]) adb('reverse', `tcp:${p}`, `tcp:${p}`);
  cleanups.push(() => { for (const p of [port, plainPort, h2Port, wrong.port, control.port]) { try { adb('reverse', '--remove', `tcp:${p}`); } catch { /* gone */ } } });

  // The app.
  if (!flag('no-build')) {
    if (!fs.existsSync(path.join(appDir, 'node_modules'))) { say('npm install'); execFileSync('npm', ['install'], { cwd: appDir, env, stdio: 'inherit' }); }
    if (!fs.existsSync(path.join(appDir, 'android'))) { say('expo prebuild'); execFileSync('npx', ['expo', 'prebuild', '--platform', 'android'], { cwd: appDir, env: { ...env, CI: '1' }, stdio: 'inherit' }); }
    say('gradle assembleRelease');
    execFileSync('./gradlew', ['app:assembleRelease', '-x', 'lint', '-x', 'test'], { cwd: path.join(appDir, 'android'), env, stdio: 'inherit' });
  }
  const apk = path.join(appDir, 'android/app/build/outputs/apk/release/app-release.apk');
  say('install', adb('install', '-r', apk).trim());
  cleanups.push(() => { try { adb('shell', 'am', 'force-stop', PKG); } catch { /* gone */ } });
  adb('shell', 'am', 'force-stop', PKG);
  adb('logcat', '-c');

  // Logcat.
  const lines = []; const state = { done: null, longStartAt: 0, longEndSeen: false };
  const lc = spawn(adbBin, ['logcat', '-v', 'brief', '-s', 'AIWBSPIKE:I', 'AndroidRuntime:E', 'ReactNativeJS:E'], { env });
  cleanups.push(() => lc.kill());
  let buf = '';
  lc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
      const m = /AIWBSPIKE\(\s*\d+\):\s*AIWBSPIKE (\{.*\})$/.exec(line);
      if (!m) { if (/AndroidRuntime|ReactNativeJS/.test(line)) say('!!', line); continue; }
      let o; try { o = JSON.parse(m[1]); } catch { continue; }
      lines.push(o);
      const s = JSON.stringify(o);
      say(s.length > 400 ? s.slice(0, 400) + '…' : s);
      if (o.long === 'start') state.longStartAt = Date.now();
      if (o.long === 'end') state.longEndSeen = true;
      if (o.done) state.done = o;
    }
  });

  const cfg = { host: '127.0.0.1', dottedHost: DOTTED, port, pin, secret, closedPort, plainPort, probeWrongPort: wrong.port, probeControlPort: control.port, probePin, h2Port, minutes: MINUTES, idleMinutes: MINUTES > IDLE ? IDLE : 0, mutateEverySec: MUTATE_EVERY };
  const url = 'aiwbspike://run?cfg=' + encodeURIComponent(JSON.stringify(cfg));
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, PKG);
  say('app started; waiting');

  // Memory samples.
  const samples = [];
  const sample = (label) => {
    const t = adb('shell', 'dumpsys', 'meminfo', PKG);
    const g = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
    const s = {
      label, atSec: state.longStartAt ? Math.round((Date.now() - state.longStartAt) / 1000) : null,
      totalPssKb: g(/TOTAL PSS:\s+(\d+)/) ?? g(/TOTAL\s+(\d+)/), totalRssKb: g(/TOTAL RSS:\s+(\d+)/),
      javaHeapKb: g(/Java Heap:\s+(\d+)/), nativeHeapKb: g(/Native Heap:\s+(\d+)/), graphicsKb: g(/Graphics:\s+(\d+)/),
    };
    samples.push(s); say('MEM', JSON.stringify(s));
    fs.appendFileSync(path.join(outDir, 'meminfo.txt'), `=== ${label} ${new Date().toISOString()}\n${t}\n`);
  };
  const deadline = Date.now() + (MINUTES + 12) * 60000;
  let nextSample = 0; let sampledStart = false;
  while (!state.done && Date.now() < deadline) {
    await sleep(2000);
    if (state.longStartAt && !sampledStart) { await sleep(10000); sample('start'); sampledStart = true; nextSample = Date.now() + SAMPLE_EVERY * 1000; }
    else if (sampledStart && !state.longEndSeen && Date.now() >= nextSample) { sample('interval'); nextSample = Date.now() + SAMPLE_EVERY * 1000; }
    if (state.longEndSeen && sampledStart && !samples.some((s) => s.label === 'end')) sample('end');
  }
  await sleep(500);
  if (MINUTES > 0 && !samples.some((s) => s.label === 'end') && sampledStart) sample('end');

  // Verdict.
  const checks = lines.filter((l) => l.check);
  const failed = checks.filter((c) => !c.ok);
  const probe = {
    wrongPinBytes: probeLog.filter((p) => p.label === 'wrong-pin').reduce((a, p) => a + p.bytes, 0),
    wrongPinConnections: probeLog.filter((p) => p.label === 'wrong-pin').length,
    controlBytes: probeLog.filter((p) => p.label === 'right-pin').reduce((a, p) => a + p.bytes, 0),
  };
  say('probe', JSON.stringify(probe), JSON.stringify(probeLog));
  const ok = !!state.done && failed.length === 0 && state.done.fail.length === 0 && probe.wrongPinBytes === 0 && probe.controlBytes > 0;
  fs.writeFileSync(path.join(outDir, 'lines.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok, done: state.done, failed: failed.map((c) => c.check), probe, probeLog, samples, minutes: MINUTES, pin }, null, 2));
  say(ok ? 'ALL CHECKS PASSED' : 'FAILED: ' + (state.done ? JSON.stringify(failed.map((c) => c.check)) : 'the app did not finish'));
  return ok;
}

let ok = false;
try { ok = await main(); } catch (e) { console.error(e); } finally { await cleanup(); }
process.exit(ok ? 0 : 1);
