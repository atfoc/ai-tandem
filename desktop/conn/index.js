'use strict';

// The shared connection module of the app and of the test host (plan D17): the server list and its
// secrets, the pinned HTTPS connection to every server, the secret, the check of a picture's bytes,
// and one stream per server and its opening again. It is plain CommonJS with Node's own modules
// only, so it runs in the Electron main process and in plain Node.

const { Manager } = require('./manager');
const { parseAppWaits } = require('./timing');

// createClient makes the client of every server (plan C3.2).
//
//   stateDir  holds servers.json and client-id; made 0700 when missing
//   local     null (a host of remote servers only) or { bin, home, env?, run? }
//   timing    optional partial timing; see timing.js
//   log       optional (line) => void; never given a secret
//   dial      test seam: replaces net.connect
//   roots     test seam: PEM roots a certificate without the self-signed box is verified against
function createClient(options) {
  const { stateDir, local = null, timing, log, dial, roots } = options || {};
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('createClient: stateDir is required');
  const mgr = new Manager({ stateDir, local, timing, log, dial, roots });
  return {
    clientId: mgr.clientId,
    subscribe: (onEnvelope) => mgr.subscribe(onEnvelope),
    call: (req) => mgr.call(req),
    picture: (req) => mgr.picture(req),
    app: (op, args) => mgr.app(op, args),
    localInfo() {
      const info = mgr.localConn && mgr.localConn.starter.info;
      return info ? { home: info.home, address: info.address, version: info.version, pid: info.pid } : null;
    },
    close: () => mgr.close(),
  };
}

module.exports = { createClient, parseAppWaits };
