'use strict';

// parseAddress reads a server's address as typed (port of internal/servers/address.go): scheme
// https, a host that is a DNS name or an IPv4 literal (normalName), an explicit port 1 to 65535, a
// path of "" or "/", and no user, query or fragment. address is the stored form, lower-cased
// "https://host:port". It returns null for anything else.

// normalName lower-cases s and checks it as a DNS name or an IPv4 literal (remote.NormalName).
function normalName(s) {
  s = s.toLowerCase();
  if (s === '' || s.length > 253 || s.includes('..')) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  if (/^[.-]|[.-]$/.test(s)) return null;
  return s;
}

function parseAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/[?#]/.test(s)) return null;
  const m = /^https:\/\/([^/\s@]*)\/?$/i.exec(s);
  if (!m) return null;
  const hostport = m[1];
  const i = hostport.lastIndexOf(':');
  if (i < 0) return null;
  const host = normalName(hostport.slice(0, i));
  const p = hostport.slice(i + 1);
  if (host === null || !/^[0-9]+$/.test(p)) return null;
  const n = Number(p);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return null;
  return { address: `https://${host}:${n}`, host, port: String(n) };
}

module.exports = { parseAddress, normalName };
