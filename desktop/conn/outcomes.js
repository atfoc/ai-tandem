'use strict';

// Outcomes of a connection test and of an attempt, the states of an entry, and the levels (port of
// internal/servers/outcome.go and view.go).

// MIN_FEATURE_LEVEL is the lowest hello featureLevel the app connects to, and CLIENT_LEVEL the level
// it states in X-AIWB-Level on every request.
const MIN_FEATURE_LEVEL = 6;
const CLIENT_LEVEL = 6;

const HELLO_PATH = '/api/hello';
const STATE_PATH = '/api/state';
const STREAM_PATH = '/api/events';

const LOCAL_ID = 'local';
const LOCAL_NAME = 'This computer';

// OUTCOMES is the table: every outcome with the step of the test it ends and its message to the
// user. The message of duplicate is followed by the other entry's name.
const OUTCOMES = {
  bad_address: [1, 'Not a valid https address'],
  refused: [2, 'Nothing listens there: is the server running on that machine?'],
  name_not_found: [2, 'Name not found'],
  no_route: [2, 'No answer: is the VPN up?'],
  tls_timeout: [3, "No answer: is the VPN up, and does a firewall on the server's machine let the port through?"],
  not_https: [3, 'Not HTTPS: is this the address of an AI Whiteboard server?'],
  fingerprint: [3, 'Compare this fingerprint with the one shown on the other machine, then accept it'],
  cert_changed: [3, 'Certificate changed'],
  cert_name: [3, 'The certificate is not for this name'],
  cert_expired: [3, 'The certificate has expired'],
  self_signed: [3, 'Self-signed certificate: tick the box'],
  cert_untrusted: [3, 'The certificate is not trusted'],
  tls_error: [3, 'The secure connection failed'],
  secret_refused: [4, 'Secret not accepted'],
  bad_host: [4, 'The server does not know this name: run set-up there with it'],
  not_aiwb: [4, 'Something else answers there'],
  too_old: [4, 'Server too old: update it on that machine'],
  is_local: [4, "This is this computer's server"],
  duplicate: [4, 'Already added as'],
  another_server: [4, 'Another server answers at this address'],
  no_answer: [4, 'No answer from the server'],
  connected: [5, 'Connected'],
  no_state: [5, "Connected, but the server's state could not be read"],
};

const message = (outcome) => (OUTCOMES[outcome] ? OUTCOMES[outcome][1] : '');
const step = (outcome) => (OUTCOMES[outcome] ? OUTCOMES[outcome][0] : 0);

// stateOf is the state a connection enters when an attempt ended with the outcome.
function stateOf(outcome) {
  switch (outcome) {
    case 'connected': return 'connected';
    case 'self_signed': case 'cert_name': case 'cert_expired': case 'cert_untrusted': return 'certificate_not_accepted';
    case 'secret_refused': return 'secret_not_accepted';
    case 'fingerprint': return 'fingerprint_not_accepted';
    case 'cert_changed': return 'certificate_changed';
    case 'bad_host': return 'name_not_known';
    case 'not_aiwb': return 'not_aiwb';
    case 'too_old': return 'too_old';
    case 'is_local': case 'duplicate': case 'another_server': return 'another_server';
    default: return 'unreachable'; // refused, name_not_found, no_route, tls_timeout, not_https, tls_error, no_answer, no_state
  }
}

// retries: a connection in the state tries again by itself, with back-off and without end.
const retries = (state) => state === 'unreachable' || state === 'certificate_not_accepted' || state === 'not_started';

// stops: a connection in the state sends nothing more until the user does something (an edit, an
// accept, a test, Retry). The one thing a too_old one still sends is its hello, every `tooOld`.
const stops = (state) => state !== 'connecting' && state !== 'connected' && !retries(state);

// Problem is why no connection was made: the outcome, the text of the failure and, for the outcome
// cert_changed, the presented certificate's fingerprint and the pinned one.
class Problem extends Error {
  constructor(outcome, detail = '', extra = {}) {
    super(outcome);
    this.name = 'Problem';
    this.outcome = outcome;
    this.detail = detail;
    this.fingerprint = extra.fingerprint || '';
    this.pinned = extra.pinned || '';
  }
}

module.exports = {
  MIN_FEATURE_LEVEL, CLIENT_LEVEL, HELLO_PATH, STATE_PATH, STREAM_PATH, LOCAL_ID, LOCAL_NAME,
  OUTCOMES, message, step, stateOf, retries, stops, Problem,
};
