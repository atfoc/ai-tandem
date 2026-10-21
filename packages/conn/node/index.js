'use strict';

// The connection module on Node: the desktop app's main process and the test host (plan D17). It
// is the shared code of the package root with the Node ports: the Connector over node:tls and the
// Session over node:http2 (connector.js, session.js), the Store over files (store.js) and this
// computer's server (local.js). Plain CommonJS with Node's own modules only, so it runs in the
// Electron main process and in plain Node.

const { createClient, parseAppWaits } = require('../index');
const { nodeConnector } = require('./connector');
const { fileStore, ensureStateDir, writeFileAtomic } = require('./store');
const { nodeLocal } = require('./local');

// createNodeClient makes the client of every server (plan C3.2) with the Node ports.
//
//   stateDir  holds servers.json and client-id; made 0700 when missing
//   local     null (a host of remote servers only) or { bin, home, env?, run? }
//   timing    optional partial timing; see core/timing.js
//   log       optional (line) => void; never given a secret
//   dial      test seam: replaces net.connect
//   roots     test seam: PEM roots a certificate without the self-signed box is verified against
function createNodeClient(options) {
  const { stateDir, local = null, timing, log, dial, roots } = options || {};
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('createClient: stateDir is required');
  ensureStateDir(stateDir);
  return createClient({
    connector: nodeConnector({ dial, roots }),
    store: fileStore(stateDir),
    local: local ? nodeLocal(local) : null,
    timing,
    log,
  });
}

module.exports = { createNodeClient, parseAppWaits, nodeConnector, fileStore, nodeLocal, ensureStateDir, writeFileAtomic };
