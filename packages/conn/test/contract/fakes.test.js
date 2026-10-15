'use strict';

// The port contract on the fake Connector and the scripted server (test/fakes): the fakes the
// core-on-fakes cases and the native module's JS fake are built on behave as a real Connector does.

const test = require('node:test');
const { ScriptedServer } = require('../fakes/scripted-server');
const { fakeConnector } = require('../fakes/fake-connector');
const { runConnectorContract } = require('./connector-contract');

const connector = fakeConnector();

// aiwb is the handle of the contract over a scripted server that sends no hello and no snapshot.
function handle(s) {
  connector.add(s);
  return {
    host: s.host,
    port: s.port,
    fingerprint: s.fingerprint,
    secret: s.secret,
    close: async () => { s.cut(); connector.remove(s); },
    requests: () => s.requests.map((r) => ({ method: r.method, path: r.path, headers: r.headers, body: r.body })),
    connections: () => s.dials,
    body: (path, bytes) => { s.routes.set(`GET ${path}`, () => ({ bytes, type: 'application/octet-stream' })); },
    echo: (path) => { s.routes.set(`POST ${path}`, (req) => ({ bytes: req.body || new Uint8Array(0), type: 'application/octet-stream' })); },
    hang: (path) => { s.hangPaths.add(path); },
    waitStream: () => s.waitStreams(1),
    write: (text) => s.write(text),
    endStreams: () => s.endStreams(),
    cut: () => s.cut(),
  };
}

async function start(kind) {
  const base = { withHello: false, noSnapshot: true };
  switch (kind) {
    case 'aiwb': return handle(new ScriptedServer(base));
    case 'h1': return handle(new ScriptedServer({ ...base, transport: 'http1' }));
    case 'plain': return handle(new ScriptedServer({ ...base, transport: 'plain' }));
    case 'blackhole': return handle(new ScriptedServer({ ...base, handshakeHang: true }));
    case 'closed': return { host: 'nothing.test', port: 9, close: async () => {} };
    default: throw new Error(`unknown kind ${kind}`);
  }
}

runConnectorContract(() => connector, { test, start });
