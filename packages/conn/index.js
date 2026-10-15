'use strict';

// The shared connection code of the app (goal D9): the client of every server, its server list, the
// pinned connection to each server with the secret, the check of a picture's bytes, and one stream
// per server with its opening again, its back-off and its silence. It is platform-free: the
// platform gives three ports (ports.d.ts), the Connector that opens a Session to a server, the
// Store of the server list, and on the desktop the LocalPort of this computer's server. The Node
// ports and today's entry are in node/ (`@aiwb/conn/node`).

const { Manager } = require('./core/manager');
const { parseAppWaits, DEFAULT_TIMING } = require('./core/timing');
const { Problem, NetError, OUTCOMES } = require('./core/outcomes');
const { abortError } = require('./core/abort');
const { normalFingerprint } = require('./core/list');

// createClient makes the client of every server (plan C3.2).
//
//   connector  the Connector: opens a Session to a server under a trust rule; reads a certificate
//   store      the Store: the saved server list and the client id
//   local      null (a client of remote servers only) or a LocalPort (node/local.js nodeLocal)
//   timing     optional partial timing; see core/timing.js
//   log        optional (line) => void; never given a secret
//   random     optional: fills a Uint8Array with random bytes (the entry ids); crypto.getRandomValues
function createClient(options) {
  const { connector, store, local = null, timing, log, random } = options || {};
  if (!connector || !store) throw new Error('createClient: connector and store are required');
  const mgr = new Manager({ connector, store, local, timing, log, random });
  return {
    clientId: mgr.clientId,
    subscribe: (onEnvelope) => mgr.subscribe(onEnvelope),
    call: (req) => mgr.call(req),
    picture: (req) => mgr.picture(req),
    app: (op, args) => mgr.app(op, args),
    wake: () => mgr.wake(),
    localInfo: () => (local ? local.info() : null),
    close: () => mgr.close(),
  };
}

module.exports = { createClient, parseAppWaits, DEFAULT_TIMING, Problem, NetError, OUTCOMES, abortError, normalFingerprint };
