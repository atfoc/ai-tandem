'use strict';

// fakeConnector is the Connector port (ports.d.ts) over scripted servers in memory: a name and a
// port find the server, and the server decides what dialing, the handshake, the pin and the
// protocol do (scripted-server.js `connect`). A name nothing listens at is refused; a name that
// ends in `.invalid` is not found, as in the stand-in tests. `calls` is every open and every
// readCertificate asked of it, for the tests that look at what was not asked.

const { Problem } = require('../../core/outcomes');
const { abortError } = require('../../core/abort');
const { FakeSession } = require('./scripted-server');

function fakeConnector({ servers = [] } = {}) {
  const net = new Map();
  const key = (host, port) => `${host}:${port}`;
  const c = {
    servers: net,
    calls: [], // {op: 'open' | 'readCertificate', at (ms), host, port, trust?}
    add(server) { net.set(key(server.host, server.port), server); return server; },
    remove(server) { net.delete(key(server.host, server.port)); },

    // lookup answers the server at host:port, or throws what dialing a name nothing answers throws.
    async lookup(host, port, { signal } = {}) {
      if (signal && signal.aborted) throw abortError();
      const s = net.get(key(host, port));
      if (s) return s;
      await new Promise((r) => setTimeout(r, 0));
      if (signal && signal.aborted) throw abortError();
      if (host.endsWith('.invalid')) throw new Problem('name_not_found', `getaddrinfo ENOTFOUND ${host}`);
      throw new Problem('refused', `connect ECONNREFUSED ${host}:${port}`);
    },

    async open({ host, port, trust, dialMs, handshakeMs, signal }) {
      c.calls.push({ op: 'open', at: Date.now(), host, port, trust: { selfSigned: !!trust.selfSigned, pin: trust.pin || '' } });
      const s = await c.lookup(host, port, { signal });
      return s.connect({ selfSigned: !!trust.selfSigned, pin: trust.pin || '', dialMs, handshakeMs, signal });
    },

    async readCertificate({ host, port, dialMs, handshakeMs, signal }) {
      c.calls.push({ op: 'readCertificate', at: Date.now(), host, port });
      const s = await c.lookup(host, port, { signal });
      return s.readCertificate({ dialMs, handshakeMs, signal });
    },
  };
  for (const s of servers) c.add(s);
  return c;
}

// fakeSession is a Session on a scripted server, for a test of something that uses a Session
// without a Connector. The certificate it accepted is the server's.
function fakeSession(server) { return new FakeSession(server, server.fingerprint); }

module.exports = { fakeConnector, fakeSession, FakeSession };
