const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// loadPreload runs preload.js with a fake electron module and returns what it exposes to the page
// and what it did with IPC.
function loadPreload() {
  const exposed = {};
  const invoked = [];
  const sent = [];
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: {
      invoke: async (...args) => { invoked.push(args); return 'answer'; },
      send: (...args) => sent.push(args),
      on: (channel, fn) => { listeners.set(channel, [...(listeners.get(channel) || []), fn]); },
      removeListener: (channel, fn) => { listeners.set(channel, (listeners.get(channel) || []).filter((x) => x !== fn)); },
    },
  };
  const file = require.resolve('../preload.js');
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? electron : load.call(this, request, ...rest);
  };
  try {
    delete require.cache[file];
    require(file);
  } finally {
    Module._load = load;
    delete require.cache[file];
  }
  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((fn) => fn({ sender: 'main' }, payload));
  return { exposed, invoked, sent, listeners, emit };
}

test('preload: the page gets window.aiwbApp with seven functions and nothing else', () => {
  const { exposed } = loadPreload();
  assert.deepEqual(Object.keys(exposed), ['aiwbApp']);
  assert.deepEqual(Object.keys(exposed.aiwbApp).sort(),
    ['app', 'call', 'cancel', 'onEvents', 'onStreamState', 'pickImages', 'stream']);
  for (const fn of Object.values(exposed.aiwbApp)) assert.equal(typeof fn, 'function');
});

test('preload: a call carries its five fields and nothing else the page added', async () => {
  const { exposed, invoked } = loadPreload();
  const body = { json: '{}' };
  assert.equal(await exposed.aiwbApp.call({ id: 'x', server: 'local', method: 'POST', path: '/api/groups', body, secret: 'no', extra: 1 }), 'answer');
  await exposed.aiwbApp.call({ id: 'y', server: 'local', method: 'GET', path: '/api/state' });
  assert.deepEqual(invoked, [
    ['aiwb:call', { id: 'x', server: 'local', method: 'POST', path: '/api/groups', body }],
    ['aiwb:call', { id: 'y', server: 'local', method: 'GET', path: '/api/state' }],
  ]);
});

test('preload: cancel, stream and app go over their channels with a fixed shape', async () => {
  const { exposed, invoked, sent } = loadPreload();
  exposed.aiwbApp.cancel('x');
  assert.deepEqual(sent, [['aiwb:cancel', { id: 'x' }]]);
  await exposed.aiwbApp.stream(true);
  await exposed.aiwbApp.stream('yes');
  await exposed.aiwbApp.app('servers.list');
  await exposed.aiwbApp.app('servers.remove', { id: 's_000000000001' });
  assert.deepEqual(invoked, [
    ['aiwb:stream', { open: true }],
    ['aiwb:stream', { open: false }],
    ['aiwb:app', { op: 'servers.list', args: undefined }],
    ['aiwb:app', { op: 'servers.remove', args: { id: 's_000000000001' } }],
  ]);
});

test('preload: onEvents and onStreamState hand the page the payload, never the IPC event, and unsubscribe', () => {
  const { exposed, emit, listeners } = loadPreload();
  const events = [];
  const states = [];
  const offEvents = exposed.aiwbApp.onEvents((batch) => events.push(batch));
  const offState = exposed.aiwbApp.onStreamState((s) => states.push(s));
  emit('aiwb:events', [{ server: 'local', event: {} }]);
  emit('aiwb:stream-state', 'open');
  assert.deepEqual(events, [[{ server: 'local', event: {} }]]);
  assert.deepEqual(states, ['open']);
  offEvents();
  offState();
  emit('aiwb:events', [1]);
  emit('aiwb:stream-state', 'closed');
  assert.equal(events.length, 1);
  assert.equal(states.length, 1);
  assert.deepEqual([listeners.get('aiwb:events'), listeners.get('aiwb:stream-state')], [[], []]);
});

test('preload: pickImages takes no argument and names no path', async () => {
  const { exposed, invoked } = loadPreload();
  assert.equal(await exposed.aiwbApp.pickImages('/etc/passwd', { filePaths: ['/etc/passwd'] }), 'answer');
  assert.deepEqual(invoked, [['aiwb:pick-images']]);
});
