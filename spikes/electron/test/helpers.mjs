// Helpers of the node tests (no Electron): a fake electron module for the preload, a fake ipcRenderer wired to
// the REAL IPC face of the desktop app (desktop/ipcface.js) through a fake ipcMain, and a model of what
// contextBridge does to what crosses it. The model is written from what the Electron run of probe/ found
// (plans/rn-rewrite/spikes/electron.md); the Electron run is the proof, the model is what lets `node --test`
// catch a regression of the bridge's shape without a window.
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const preloadFile = path.join(here, '../bridge/preload.js');
const { createIpcFace } = require('../../../desktop/ipcface.js');

export const PAGE_URL = 'file:///app/dist/index.html';

// loadPreload runs bridge/preload.js with a fake electron module; returns what it exposed.
export function loadPreload(ipcRenderer) {
  const exposed = {};
  const electron = { contextBridge: { exposeInMainWorld: (k, api) => { exposed[k] = api; } }, ipcRenderer };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  try {
    delete require.cache[preloadFile];
    require(preloadFile);
  } finally {
    Module._load = load;
    delete require.cache[preloadFile];
  }
  return exposed;
}

// A fake ipcRenderer that records everything and answers from `handlers`.
export function recorderRenderer(handlers = {}) {
  const r = { invoked: [], sent: [], listeners: new Map() };
  r.invoke = async (channel, payload) => { r.invoked.push([channel, payload]); return handlers[channel] ? handlers[channel](payload) : { status: 200, text: '{}', sceneRev: null }; };
  r.send = (channel, payload) => { r.sent.push([channel, payload]); };
  r.on = (channel, fn) => { r.listeners.set(channel, [...(r.listeners.get(channel) || []), fn]); };
  r.removeListener = (channel, fn) => { r.listeners.set(channel, (r.listeners.get(channel) || []).filter((x) => x !== fn)); };
  r.emit = (channel, payload) => (r.listeners.get(channel) || []).forEach((fn) => fn({ sender: 'main' }, payload));
  return r;
}

// A fake main process: the real createIpcFace on a fake ipcMain, and a fake ipcRenderer that reaches it the way
// Electron does (the payload is cloned, the handler gets an event naming the sender frame, a rejection comes back
// as an Error whose message is "Error invoking remote method ...").
export function faceRenderer({ client, pageURL = PAGE_URL, senderURL = pageURL }) {
  const handlers = new Map();
  const listeners = new Map();
  const frame = { url: senderURL };
  const webContents = { mainFrame: frame, sent: [], send(channel, payload) { webContents.sent.push([channel, payload]); renderer.emit(channel, payload); }, isDestroyed: () => false, on() {} };
  const win = { webContents, isDestroyed: () => false, on() {} };
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    removeAllListeners: (ch) => listeners.delete(ch),
  };
  const face = createIpcFace({ ipcMain, client, getWindow: () => win, pageURL, shell: {}, dialog: {}, home: '/tmp' });
  const event = { sender: webContents, senderFrame: frame };
  const renderer = recorderRenderer();
  renderer.invoke = async (ch, payload) => {
    renderer.invoked.push([ch, payload]);
    try { return await handlers.get(ch)(event, structuredClone(payload)); }
    catch (e) { throw new Error(`Error invoking remote method '${ch}': ${e}`); }
  };
  renderer.send = (ch, payload) => { renderer.sent.push([ch, payload]); const fn = listeners.get(ch); if (fn) fn(event, structuredClone(payload)); };
  return { renderer, face, webContents };
}

// A client like desktop/conn's for the face: calls that wait and end on abort.
export function slowClient() {
  const c = { calls: [], subscribers: [] };
  c.call = ({ server, method, path: p, body, signal }) => new Promise((resolve, reject) => {
    const entry = { server, method, path: p, body, aborted: false, done: false };
    c.calls.push(entry);
    const t = p.startsWith('/slow') ? null : setTimeout(() => { entry.done = true; resolve({ status: 200, text: JSON.stringify({ path: p }), sceneRev: null }); }, 5);
    signal.addEventListener('abort', () => { entry.aborted = true; clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
  c.subscribe = (cb) => { const h = { cb, closed: false, close() { h.closed = true; } }; c.subscribers.push(h); return h; };
  c.app = async (op) => ({ status: 200, body: { op } });
  c.localInfo = () => null;
  return c;
}

// ---- a model of contextBridge
const isPlain = (x) => Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null || Array.isArray(x);
const PASS = [ArrayBuffer, Date, Map, Set, RegExp, Blob];

// cross returns what the other world sees of x.
export function cross(x, seen = new Map()) {
  if (x === null || (typeof x !== 'object' && typeof x !== 'function')) return x;
  if (seen.has(x)) return seen.get(x);
  if (typeof x === 'function') return (...args) => cross(x(...args.map((a) => cross(a))));
  if (x instanceof Promise) return x.then((v) => cross(v), (e) => { throw crossError(e); });
  if (ArrayBuffer.isView(x) || PASS.some((C) => x instanceof C)) return x; // copied by Electron; same value in the model
  if (x instanceof Error) return crossError(x);
  if (!isPlain(x)) return {}; // AbortSignal, ReadableStream, MessagePort, a class instance's methods: nothing own to copy
  const out = Array.isArray(x) ? [] : {};
  seen.set(x, out);
  for (const k of Reflect.ownKeys(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d.enumerable) out[k] = cross(d.get ? d.get.call(x) : x[k], seen);
  }
  return out;
}
// An Error crosses as a plain Error with its message: the name, the code and every other property are lost.
// A DOMException is not an Error here and crosses as {}.
function crossError(e) {
  if (e instanceof Error) return new Error(e.message);
  return cross(e);
}

// exposeThroughBridge: what the page sees of the preload's API.
export const exposeThroughBridge = (api) => cross(api);
