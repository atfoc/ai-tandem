'use strict';

// The port contract on the Node connector, against the stand-in server (test/standin.js) with its
// fixture certificate: node:tls and node:http2 pass the suite the native module's adapter passes
// against its fake.

const test = require('node:test');
const https = require('node:https');
const { nodeConnector } = require('../../node/connector');
const { standin, blackhole, plainHttp, closedPort, fingerprintOf, pem } = require('../standin');
const { runConnectorContract } = require('./connector-contract');

// The handle of the contract (connector-contract.js) over a stand-in that sends no hello and no
// snapshot, so that the event stream carries what the case writes and nothing else.
async function aiwb() {
  const s = await standin({ withHello: false });
  s.noSnapshot = true;
  let connections = 0;
  s.server.on('connection', () => { connections++; });
  return {
    host: '127.0.0.1',
    port: s.port,
    fingerprint: s.fingerprint,
    secret: s.secret,
    close: () => s.close(),
    requests: () => s.requests.map((r) => ({ method: r.method, path: r.path, headers: r.headers, body: new Uint8Array(r.body) })),
    connections: () => connections,
    body: (path, bytes) => { s.routes.set(`GET ${path}`, () => ({ bytes: Buffer.from(bytes), type: 'application/octet-stream' })); },
    echo: (path) => { s.routes.set(`POST ${path}`, (req, res, body) => ({ bytes: body, type: 'application/octet-stream' })); },
    hang: (path) => { s.hangPaths.add(path); },
    waitStream: () => s.waitStreams(1),
    write: (text) => { for (const res of s.streams) res.write(text); },
    endStreams: () => s.endStreams(),
    cut: () => s.cut(),
  };
}

// h1 is a TLS server that negotiates HTTP/1.1 only.
async function h1() {
  const server = https.createServer({ key: pem('a', 'key'), cert: pem('a', 'crt'), ALPNProtocols: ['http/1.1'] }, (req, res) => { res.end('hello'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    host: '127.0.0.1',
    port: server.address().port,
    fingerprint: fingerprintOf('a'),
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}

async function start(kind) {
  switch (kind) {
    case 'aiwb': return aiwb();
    case 'h1': return h1();
    case 'plain': { const p = await plainHttp(); return { host: '127.0.0.1', port: p.port, close: async () => p.close() }; }
    case 'closed': return { host: '127.0.0.1', port: await closedPort(), close: async () => {} };
    case 'blackhole': { const b = await blackhole(); return { host: '127.0.0.1', port: b.port, close: async () => b.close() }; }
    default: throw new Error(`unknown kind ${kind}`);
  }
}

runConnectorContract(() => nodeConnector({}), { test, start });
