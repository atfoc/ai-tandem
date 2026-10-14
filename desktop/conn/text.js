'use strict';

// Texts of another server or of the network, made fit to show (port of the clean helpers of
// internal/servers/test.go): valid UTF-8, no control characters, a limit on length, and never an
// entry's secret.

const MAX_DETAIL = 300; // characters of a text of the network's or of the other server's
const MAX_AGENTS = 16; // agent kinds taken from another server
const MAX_HELLO = 64 << 10; // bytes read of a hello
const MAX_STATE = 32 << 20; // bytes read of an event or a state

// hide replaces every occurrence of the secret in s by "…".
function hide(s, secret) {
  if (!secret) return s;
  return s.split(secret).join('…');
}

// strip takes out of s what is not shown: invalid UTF-16, control characters, space at the ends.
function strip(s) {
  s = String(s);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  s = s.replace(/[\u0000-\u001f\u007f-\u009f�]/gu, '');
  return s.trim();
}

function cut(s, max = MAX_DETAIL) {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

const clean = (s) => cut(strip(s));

// cleanOf is clean for a text the server of an entry may have written: its secret is replaced
// before the text is cut, and once more after the characters that are not shown are gone, which
// may have stood inside it.
const cleanOf = (s, secret) => cut(hide(strip(hide(String(s), secret)), secret));

// cleanAgents makes a list of agent kinds from another server fit to show, at most MAX_AGENTS.
function cleanAgents(list, secret) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    if (out.length === MAX_AGENTS) break;
    if (typeof a !== 'string') continue;
    const c = cleanOf(a, secret);
    if (c !== '') out.push(c);
  }
  return out;
}

// stateAgents checks the parts of an API snapshot a client requires (agents, catalogs, home,
// defaultCwd, chats) and returns its usable agents; null when a part is missing.
function stateAgents(v, secret) {
  const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObject(v)) return null;
  if (!Array.isArray(v.agents) || !isObject(v.catalogs) || typeof v.home !== 'string' || v.home === '' ||
    typeof v.defaultCwd !== 'string' || !Array.isArray(v.chats)) return null;
  return cleanAgents(v.agents, secret);
}

// errorOf is the "error" text of a JSON error answer, or "".
function errorOf(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v.error === 'string' ? v.error : '';
  } catch {
    return '';
  }
}

module.exports = { MAX_DETAIL, MAX_AGENTS, MAX_HELLO, MAX_STATE, hide, strip, cut, clean, cleanOf, cleanAgents, stateAgents, errorOf };
