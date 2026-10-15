'use strict';
// SPIKE: raw contextBridge probe. Exposes functions that look at what crossed, and hand back values of
// every kind, so probe/page.js (the main world) can record what the bridge does with each.
const { contextBridge } = require('electron');

const tag = (x) => Object.prototype.toString.call(x);
// describe says what the preload (the isolated world) received.
function describe(x) {
  const d = { typeof: typeof x, tag: tag(x) };
  try { d.ctor = x && x.constructor && x.constructor.name; } catch { d.ctor = '?'; }
  if (x !== null && (typeof x === 'object' || typeof x === 'function')) {
    d.keys = Object.keys(x).slice(0, 12);
    d.isUint8Array = x instanceof Uint8Array;
    d.isArrayBuffer = x instanceof ArrayBuffer;
    d.isView = ArrayBuffer.isView(x);
    d.isAbortSignal = typeof AbortSignal !== 'undefined' && x instanceof AbortSignal;
    d.isBlob = typeof Blob !== 'undefined' && x instanceof Blob;
    d.isError = x instanceof Error;
    d.hasAddEventListener = typeof x.addEventListener;
    d.byteLength = x.byteLength;
    d.byteOffset = x.byteOffset;
    d.bufferByteLength = x.buffer && x.buffer.byteLength;
    d.isBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(x);
  } else d.value = String(x);
  return d;
}

const api = {
  info: () => ({ sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, versions: process.versions.electron, hasBuffer: typeof Buffer, hasRequireFs: (() => { try { require('node:fs'); return true; } catch (e) { return String(e.message).slice(0, 60); } })(), hasRequireLocal: (() => { try { require('./nothing-here.js'); return true; } catch (e) { return String(e.message).slice(0, 80); } })(), randomUUID: typeof crypto.randomUUID, secure: window.isSecureContext }),
  describe,
  echo: (x) => x,
  // function proxying
  callBack: (fn, ...args) => { try { return { ok: true, ret: fn(...args) }; } catch (e) { return { ok: false, err: String(e) }; } },
  callBackAsync: async (fn, ...args) => fn(...args),
  fnLater: (fn) => { setTimeout(() => fn('later'), 50); return true; },
  keepFn: (fn) => { api.__kept = fn; return true; },
  callKept: () => api.__kept('kept'),
  retFn: () => (a, b) => `fn(${a},${b})`,
  retObj: () => ({ n: 1, f: (x) => x * 2, nested: { g: () => 'g' } }),
  retObjWithPromise: () => ({ id: 'x1', done: Promise.resolve('done!'), cancel: () => 'cancelled' }),
  // promises
  promiseOk: (v) => Promise.resolve(v),
  promiseWithProps: () => { const p = Promise.resolve(7); p.cancel = () => 'cancel!'; p.id = 'abc'; return p; },
  promiseReject: () => Promise.reject(Object.assign(new RangeError('boom'), { code: 'E_BOOM', extra: { a: 1 } })),
  promiseRejectDOM: () => Promise.reject(new DOMException('The call was aborted.', 'AbortError')),
  promiseRejectPlain: () => Promise.reject({ status: 499, name: 'Plain' }),
  promiseRejectCustomName: () => { const e = new Error('transport down'); e.name = 'TransportError'; return Promise.reject(e); },
  throwSync: () => { throw Object.assign(new TypeError('sync'), { code: 'E_SYNC' }); },
  pageFnThrows: (fn) => { try { fn(); return 'no throw'; } catch (e) { return describe(e); } },
  pageFnReturnsPromise: (fn) => fn(),
  // iteration and streams
  asyncGenerator: () => (async function* () { yield 1; yield 2; yield 3; })(),
  asyncIterableObject: () => ({ [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < 3 ? { value: ++i, done: false } : { value: undefined, done: true }) }; } }),
  handRolledIterator: () => { let i = 0; return { next: async () => (i < 3 ? { value: ++i, done: false } : { value: undefined, done: true }), return: async () => ({ done: true }) }; },
  syncGenerator: () => (function* () { yield 1; yield 2; })(),
  readableStream: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
  blob: () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-test' }),
  messageChannelPort: () => new MessageChannel().port1,
  symbolKey: () => ({ [Symbol('k')]: 1, [Symbol.for('k2')]: 2, plain: 3 }),
  getterObject: () => ({ get g() { return 'got'; }, v: 1 }),
  classInstance: () => new (class Foo { constructor() { this.a = 1; } m() { return 'm'; } })(),
  dateMapSet: () => ({ d: new Date(0), m: new Map([[1, 2]]), s: new Set([1]), r: /x/g, big: (() => { try { return BigInt(5); } catch { return 'nobigint'; } })(), u: undefined, nan: NaN, inf: Infinity }),
  circular: () => { const a = { n: 1 }; a.self = a; return a; },
  // bytes
  uint8: (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i += 4096) u[i] = i & 255; u[n - 1] = 7; return u; },
  uint8View: () => { const b = new ArrayBuffer(100); const v = new Uint8Array(b, 10, 20); v.fill(9); return v; },
  arrayBuffer: (n) => new ArrayBuffer(n),
  float64: () => new Float64Array([1.5, 2.5]),
  dataView: () => new DataView(new ArrayBuffer(8)),
  nodeBuffer: () => Buffer.from('abc'),
  sharedArrayBuffer: () => { try { return new SharedArrayBuffer(8); } catch (e) { return 'no SAB: ' + e.message; } },
  // checks a Uint8Array the page sent: sum of first bytes and the buffer's size (is the whole buffer copied for a view?)
  checkBytes: (x) => ({ ...describe(x), first: x[0], last: x[x.length - 1], len: x.length }),
  checkAB: (ab) => { const u = new Uint8Array(ab); return { ...describe(ab), first: u[0], last: u[u.length - 1] }; },
  readBlob: async (b) => { const ab = await b.arrayBuffer(); const u = new Uint8Array(ab); return { size: b.size, type: b.type, read: ab.byteLength, first: u[0], last: u[u.length - 1] }; },
  big: (n) => ({ rows: Array.from({ length: n }, (_, i) => ({ i, s: 'x'.repeat(20) })) }),
  mutate: (x) => { x.changed = true; if (x.arr) x.arr.push('p'); return true; },
  keepRef: (x) => { api.__ref = x; return true; },
  readRef: () => api.__ref,
};
contextBridge.exposeInMainWorld('probeApi', api);
