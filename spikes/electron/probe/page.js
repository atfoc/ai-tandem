// SPIKE: the main world side of the contextBridge probe. Each experiment records what arrived on this
// side (or what the preload said arrived on its side). The result is window.__probe; main.js prints it.
(async () => {
  const P = window.probeApi;
  const R = {};
  const tag = (x) => Object.prototype.toString.call(x);
  // see: what this world received.
  const see = (x) => {
    const d = { typeof: typeof x, tag: tag(x) };
    try { d.ctor = x && x.constructor && x.constructor.name; } catch { d.ctor = '?'; }
    if (x !== null && (typeof x === 'object' || typeof x === 'function')) {
      try { d.keys = Object.keys(x).slice(0, 12); } catch { /* */ }
      d.isUint8Array = x instanceof Uint8Array;
      d.isArrayBuffer = x instanceof ArrayBuffer;
      d.isError = x instanceof Error;
      d.isPromise = x instanceof Promise;
      d.byteLength = x.byteLength;
      d.hasAsyncIterator = typeof x[Symbol.asyncIterator];
      d.hasIterator = typeof x[Symbol.iterator];
    } else d.value = String(x);
    return d;
  };
  const exp = async (name, fn) => {
    const t0 = performance.now();
    try { R[name] = { ok: true, ...(await fn()) }; } catch (e) { R[name] = { ok: false, threw: see(e), message: String(e && e.message || e), name: e && e.name }; }
    R[name].ms = Math.round(performance.now() - t0);
  };

  await exp('info', async () => ({ preload: P.info(), main: { sandbox: typeof process, require: typeof require, Buffer: typeof Buffer, secure: window.isSecureContext, origin: location.origin, href: location.href.slice(0, 60) } }));

  // ---- what the PRELOAD sees of what the page passes in
  await exp('in.abortSignal', async () => ({ preloadSaw: P.describe(new AbortController().signal) }));
  await exp('in.abortSignalAborted', async () => { const ac = new AbortController(); ac.abort(); return { preloadSaw: P.describe(ac.signal), pageSaysAborted: ac.signal.aborted }; });
  await exp('in.signalInsideObject', async () => { const ac = new AbortController(); return { preloadSaw: P.describe({ signal: ac.signal, a: 1 }), signalKey: P.describe({ signal: ac.signal }).keys }; });
  await exp('in.signalLikePlainObject', async () => { const ac = new AbortController(); let aborted = 0; const like = { aborted: ac.signal.aborted, listen: (cb) => { ac.signal.addEventListener('abort', cb, { once: true }); return () => ac.signal.removeEventListener('abort', cb); } }; const r = P.callBack((l) => { const off = l.listen(() => { aborted++; }); return typeof off; }, like); ac.abort(); return { callBack: r, abortHeardInSide: aborted }; });
  await exp('in.uint8', async () => ({ preloadSaw: P.checkBytes(new Uint8Array([5, 6, 7])) }));
  await exp('in.uint8View', async () => { const b = new ArrayBuffer(1000); const v = new Uint8Array(b, 100, 10); v[0] = 42; v[9] = 43; return { preloadSaw: P.checkBytes(v) }; });
  await exp('in.arrayBuffer', async () => ({ preloadSaw: P.describe(new ArrayBuffer(16)) }));
  await exp('in.blob', async () => ({ preloadSaw: P.describe(new Blob([new Uint8Array(4)], { type: 'image/png' })) }));
  await exp('in.file', async () => ({ preloadSaw: P.describe(new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })) }));
  await exp('in.function', async () => ({ preloadSaw: P.describe(() => 1), called: P.callBack((a, b) => a + b, 2, 3) }));
  await exp('in.asyncFunction', async () => { const r = P.callBackAsync(async (a) => a + 1, 1); return { retIsPromise: see(r), awaited: await r }; });
  await exp('in.pageFnThrows', async () => ({ preloadCaught: P.pageFnThrows(() => { throw Object.assign(new Error('from page'), { code: 'E_PAGE' }); }) }));
  await exp('in.pageFnReturnsPromise', async () => { const r = P.pageFnReturnsPromise(() => Promise.resolve('page-promise')); return { ret: see(r), awaited: await r }; });
  await exp('in.callbackLater', async () => { const got = await new Promise((res) => { P.fnLater((x) => res(x)); }); return { got }; });
  await exp('in.keptFunctionStillWorks', async () => { P.keepFn((x) => `page:${x}`); return { out: P.callKept() }; });
  await exp('in.objectIdentity', async () => { const o = { arr: [1] }; P.keepRef(o); P.mutate(o); return { mutatedInPage: o.changed === true, arr: o.arr.length, sameRefBack: P.readRef() === o }; });
  await exp('in.circular', async () => { const a = { n: 1 }; a.self = a; return { preloadSaw: P.describe(a) }; });

  // ---- what the PAGE sees of what the preload hands back
  await exp('out.primitive', async () => ({ a: P.echo('s'), b: P.echo(1), c: P.echo(null), d: P.echo(undefined) }));
  await exp('out.function', async () => { const f = P.retFn(); return { see: see(f), called: f(1, 2) }; });
  await exp('out.objectWithFunctions', async () => { const o = P.retObj(); return { see: see(o), f: o.f(21), g: o.nested.g() }; });
  await exp('out.objectWithPromiseAndCancel', async () => { const o = P.retObjWithPromise(); return { see: see(o), done: see(o.done), cancel: typeof o.cancel === 'function' ? o.cancel() : 'no cancel fn', awaitedDone: await Promise.resolve(o.done).then((v) => v, (e) => 'rejected:' + e) }; });
  await exp('out.promiseOk', async () => { const p = P.promiseOk({ a: 1 }); return { isPromise: p instanceof Promise, v: await p }; });
  await exp('out.promiseWithProps', async () => { const p = P.promiseWithProps(); return { see: see(p), cancelType: typeof p.cancel, idType: typeof p.id, v: await p }; });
  await exp('out.promiseReject.RangeError', async () => { try { await P.promiseReject(); return { threw: false }; } catch (e) { return { threw: true, see: see(e), name: e.name, message: e.message, code: e.code, extra: e.extra, instanceofError: e instanceof Error, instanceofRangeError: e instanceof RangeError }; } });
  await exp('out.promiseReject.DOMException', async () => { try { await P.promiseRejectDOM(); return { threw: false }; } catch (e) { return { threw: true, see: see(e), name: e && e.name, message: e && e.message, instanceofDOMException: e instanceof DOMException, instanceofError: e instanceof Error }; } });
  await exp('out.promiseReject.customNamedError', async () => { try { await P.promiseRejectCustomName(); return { threw: false }; } catch (e) { return { threw: true, name: e.name, message: e.message, instanceofError: e instanceof Error }; } });
  await exp('out.promiseReject.plainObject', async () => { try { await P.promiseRejectPlain(); return { threw: false }; } catch (e) { return { threw: true, see: see(e), status: e && e.status }; } });
  await exp('out.throwSync', async () => { try { P.throwSync(); return { threw: false }; } catch (e) { return { threw: true, name: e.name, message: e.message, code: e.code, instanceofError: e instanceof Error, instanceofTypeError: e instanceof TypeError }; } });
  await exp('out.asyncGenerator', async () => { const g = P.asyncGenerator(); const r = { see: see(g) }; try { const got = []; for await (const v of g) got.push(v); r.iterated = got; } catch (e) { r.iterError = String(e.message || e); } return r; });
  await exp('out.asyncIterableObject', async () => { const g = P.asyncIterableObject(); const r = { see: see(g) }; try { const got = []; for await (const v of g) got.push(v); r.iterated = got; } catch (e) { r.iterError = String(e.message || e); } return r; });
  await exp('out.handRolledIteratorObject', async () => { const it = P.handRolledIterator(); const r = { see: see(it) }; const got = []; for (;;) { const s = await it.next(); if (s.done) break; got.push(s.value); } r.manualNext = got; r.returnFn = typeof it.return; return r; });
  await exp('out.syncGenerator', async () => { const g = P.syncGenerator(); const r = { see: see(g) }; try { r.iterated = [...g]; } catch (e) { r.iterError = String(e.message || e); } return r; });
  await exp('out.readableStream', async () => { const s = P.readableStream(); return { see: see(s), hasGetReader: typeof s.getReader }; });
  await exp('out.blob', async () => { const b = P.blob(); const r = { see: see(b) }; try { r.size = b.size; r.type = b.type; r.text = await b.text(); } catch (e) { r.err = String(e.message || e); } return r; });
  await exp('out.messagePort', async () => ({ see: see(P.messageChannelPort()) }));
  await exp('out.symbolKeys', async () => { const o = P.symbolKey(); return { keys: Object.keys(o), symbols: Object.getOwnPropertySymbols(o).length, plain: o.plain }; });
  await exp('out.getter', async () => { const o = P.getterObject(); const dsc = Object.getOwnPropertyDescriptor(o, 'g'); return { v: o.v, g: o.g, descriptorIsGetter: !!(dsc && dsc.get), keys: Object.keys(o) }; });
  await exp('out.classInstance', async () => { const o = P.classInstance(); return { see: see(o), a: o.a, m: typeof o.m, ctor: o.constructor && o.constructor.name }; });
  await exp('out.dateMapSetEtc', async () => { const o = P.dateMapSet(); return { d: see(o.d), m: see(o.m), s: see(o.s), r: see(o.r), big: see(o.big), hasU: 'u' in o, nan: o.nan, inf: o.inf }; });
  await exp('out.circular', async () => { const o = P.circular(); return { n: o.n, selfIsSelf: o.self === o }; });
  await exp('out.uint8', async () => { const u = P.uint8(10); return { see: see(u), sameRealm: u instanceof Uint8Array, len: u.length, last: u[9] }; });
  await exp('out.uint8View(offset 10,len 20 of a 100-byte buffer)', async () => { const v = P.uint8View(); return { see: see(v), length: v.length, byteOffset: v.byteOffset, bufferLen: v.buffer.byteLength, bytes: Array.from(v.slice(0, 3)) }; });
  await exp('out.arrayBuffer', async () => { const b = P.arrayBuffer(16); return { see: see(b), byteLength: b.byteLength }; });
  await exp('out.float64Array', async () => { const f = P.float64(); return { see: see(f), vals: Array.from(f) }; });
  await exp('out.dataView', async () => ({ see: see(P.dataView()) }));
  await exp('out.nodeBuffer', async () => { const b = P.nodeBuffer(); return { see: see(b), isUint8Array: b instanceof Uint8Array, text: new TextDecoder().decode(b) }; });
  await exp('out.sharedArrayBuffer', async () => { const s = P.sharedArrayBuffer(); return { see: typeof s === 'string' ? s : see(s) }; });

  // ---- cost of carrying bytes (copy on every crossing, both ways)
  for (const mb of [1, 10, 50]) {
    await exp(`cost.out.${mb}MB (preload makes bytes, page receives)`, async () => { const t = performance.now(); const u = P.uint8(mb * 1024 * 1024); return { receivedBytes: u.length, crossingMs: Math.round(performance.now() - t) }; });
    await exp(`cost.in.${mb}MB (page sends bytes to preload)`, async () => { const u = new Uint8Array(mb * 1024 * 1024); u[0] = 1; u[u.length - 1] = 2; const t = performance.now(); const d = P.checkBytes(u); return { preloadSawBytes: d.len, first: d.first, last: d.last, crossingMs: Math.round(performance.now() - t) }; });
  }
  for (const mb of [10, 50]) {
    await exp(`cost.in.${mb}MB as ArrayBuffer`, async () => { const u = new Uint8Array(mb * 1024 * 1024); u[0] = 1; u[u.length - 1] = 2; const t = performance.now(); const d = P.checkAB(u.buffer); return { preloadSaw: d.byteLength, first: d.first, last: d.last, crossingMs: Math.round(performance.now() - t) }; });
    await exp(`cost.in.${mb}MB as Blob, preload reads it with blob.arrayBuffer()`, async () => { const u = new Uint8Array(mb * 1024 * 1024); u[0] = 1; u[u.length - 1] = 2; const b = new Blob([u]); const t = performance.now(); const d = await P.readBlob(b); return { ...d, totalMs: Math.round(performance.now() - t) }; });
  }
  await exp('cost.in.50MB as Uint8Array.slice() of a view (explicit copy first)', async () => { const u = new Uint8Array(new ArrayBuffer(60 * 1024 * 1024), 100, 50 * 1024 * 1024); u[0] = 1; const t = performance.now(); const d = P.checkBytes(u.slice()); return { len: d.len, bufferByteLength: d.bufferByteLength, crossingMs: Math.round(performance.now() - t) }; });
  await exp('cost.view.in (10-byte view into a 50MB buffer sent to preload)', async () => { const b = new ArrayBuffer(50 * 1024 * 1024); const v = new Uint8Array(b, 100, 10); const t = performance.now(); const d = P.checkBytes(v); return { preloadSaw: { len: d.len, byteOffset: d.byteOffset, bufferByteLength: d.bufferByteLength }, crossingMs: Math.round(performance.now() - t) }; });
  await exp('cost.objects.out (20000 small objects)', async () => { const t = performance.now(); const o = P.big(20000); return { rows: o.rows.length, crossingMs: Math.round(performance.now() - t) }; });

  window.__probe = R;
  window.__probeDone = true;
})();
