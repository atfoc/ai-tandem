'use strict';

// The time limits of the connection module, in milliseconds. A test lowers them through the
// `timing` option of createClient; the app and the test host through AIWB_APP_WAITS.

const DEFAULT_TIMING = Object.freeze({
  dial: 3000, // the TCP connect
  handshake: 3000, // the TLS handshake
  headers: 3000, // an answer's headers, after the request was written
  hello: 10000, // GET /api/hello, with its body
  firstEvent: 10000, // the stream's snapshot, after its headers
  testStep: 5000, // each step of Test connection
  silence: 35000, // a stream without a byte, ping or event, for this long has ended
  backoff: Object.freeze([1000, 2000, 5000, 10000, 30000]), // the waits between attempts; the last repeats
  jitter: 0.2, // each wait changes by up to this part of it, more or less
  stable: 30000, // how long a stream stays open for the back-off to start again
  tooOld: 300000, // how long a too old server waits before it is asked again
  call: 15000, // a call with no limit of its own
  start: 45000,
  scene: 60000,
  imageCall: 60000, // an upload or a fetch of a picture
  delete: 180000,
  dirs: 10000,
  usage: 30000,
  unfollow: 5000,
  launch: 40000, // this computer's `launch -json`
  relaunch: 60000,
  secret: 10000,
  status: 10000,
});

// withDefaults fills every field a partial timing leaves out. Stable follows the back-off: a
// timing that sets backoff and not stable gets the last step of it.
function withDefaults(partial) {
  const t = { ...DEFAULT_TIMING, backoff: [...DEFAULT_TIMING.backoff] };
  for (const [k, v] of Object.entries(partial || {})) {
    if (v === undefined || v === null || !(k in DEFAULT_TIMING)) continue;
    t[k] = k === 'backoff' ? [...v] : v;
  }
  if (partial && partial.backoff && partial.stable === undefined) t.stable = t.backoff[t.backoff.length - 1];
  if (!t.backoff.length) t.backoff = [...DEFAULT_TIMING.backoff];
  return t;
}

// backoffFor is the wait before the attempt after n failed ones in a row, n from 0: the n-th step,
// the last one from then on, with its jitter. rand is Math.random, replaced by tests.
function backoffFor(t, n, rand = Math.random) {
  const steps = t.backoff;
  let d = steps[Math.min(n, steps.length - 1)];
  if (t.jitter > 0) d += d * t.jitter * (2 * rand() - 1);
  return Math.max(d, 0);
}

// parseDuration reads a duration in Go's syntax: "3.5s", "500ms", "2m", "1h30m". null when it is none.
function parseDuration(s) {
  const unit = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
  const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|ms|s|m|h)(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|ms|s|m|h))*$/.exec(s);
  if (!m) return null;
  let total = 0;
  for (const part of s.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/g)) total += parseFloat(part[1]) * unit[part[2]];
  return total;
}

const WAIT_NAMES = ['silence', 'backoff', 'tooold', 'call', 'start', 'scene', 'imagecall', 'delete', 'firstevent', 'hello'];

// parseAppWaits reads AIWB_APP_WAITS: name=duration pairs separated by commas, as in
// "silence=3.5s,backoff=3s". It returns a partial timing; "" gives {}. A bad value throws.
// backoff is the last step: the steps before it keep their share of it, and stable is it too.
function parseAppWaits(value) {
  const out = {};
  if (value === undefined || value === null || String(value).trim() === '') return out;
  for (const part of String(value).split(',')) {
    const i = part.indexOf('=');
    const name = (i < 0 ? part : part.slice(0, i)).trim();
    const text = i < 0 ? '' : part.slice(i + 1).trim();
    const d = parseDuration(text);
    if (i < 0 || !WAIT_NAMES.includes(name)) {
      throw new Error(`${JSON.stringify(part)} is not name=duration with one of the names ${WAIT_NAMES.join(', ')}`);
    }
    if (d === null || !(d > 0)) throw new Error(`${JSON.stringify(part)} is not a duration above 0`);
    switch (name) {
      case 'backoff': {
        const steps = DEFAULT_TIMING.backoff;
        const last = steps[steps.length - 1];
        out.backoff = steps.map((s) => (s * d) / last);
        out.stable = d;
        break;
      }
      case 'tooold': out.tooOld = d; break;
      case 'imagecall': out.imageCall = d; break;
      case 'firstevent': out.firstEvent = d; break;
      default: out[name] = d;
    }
  }
  return out;
}

module.exports = { DEFAULT_TIMING, withDefaults, backoffFor, parseDuration, parseAppWaits };
