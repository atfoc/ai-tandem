'use strict';

// UTF-8 in plain JavaScript, so that the code of core/ needs no decoder of the platform (React
// Native's Hermes has none). It is the WHATWG decoder: decode is the fatal one (as the platform's
// decoder with fatal set: an invalid byte throws, a byte order mark at the start is dropped), and
// decodeLenient puts U+FFFD for every maximal invalid part and keeps a byte order mark (as Node's
// toString('utf8') of a byte array). encode puts U+FFFD for a lone surrogate.

const CHUNK = 0x2000; // code units handed to String.fromCharCode at a time

// units decodes bytes into UTF-16 code units: [array, count], or null at the first invalid byte
// when fatal.
function units(bytes, fatal) {
  const n = bytes.length;
  const out = new Uint16Array(n); // no byte makes more than one unit; four bytes make two
  let k = 0;
  let need = 0;
  let seen = 0;
  let cp = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (need === 0) {
      if (b < 0x80) { out[k++] = b; continue; }
      if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; continue; }
      if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        need = 2; cp = b & 0x0f; continue;
      }
      if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        need = 3; cp = b & 0x07; continue;
      }
      if (fatal) return null;
      out[k++] = 0xfffd;
      continue;
    }
    if (b < lower || b > upper) {
      // The sequence so far is one invalid part; this byte starts again.
      if (fatal) return null;
      need = 0; seen = 0; cp = 0; lower = 0x80; upper = 0xbf;
      out[k++] = 0xfffd;
      i--;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen !== need) continue;
    if (cp > 0xffff) {
      cp -= 0x10000;
      out[k++] = 0xd800 + (cp >> 10);
      out[k++] = 0xdc00 + (cp & 0x3ff);
    } else {
      out[k++] = cp;
    }
    need = 0; seen = 0; cp = 0;
  }
  if (need !== 0) {
    if (fatal) return null;
    out[k++] = 0xfffd;
  }
  return [out, k];
}

function text(out, from, to) {
  let s = '';
  for (let i = from; i < to; i += CHUNK) s += String.fromCharCode.apply(null, out.subarray(i, Math.min(i + CHUNK, to)));
  return s;
}

// decode is the text of bytes (a Uint8Array) that must be valid UTF-8; it throws a TypeError for
// any that is not. A byte order mark at the start is not part of the text.
function decode(bytes) {
  const u = units(bytes, true);
  if (u === null) throw new TypeError('The encoded data was not valid for encoding utf-8');
  const [out, k] = u;
  return text(out, k > 0 && out[0] === 0xfeff ? 1 : 0, k);
}

// decodeLenient is the text of bytes with U+FFFD for what is not UTF-8.
function decodeLenient(bytes) {
  const [out, k] = units(bytes, false);
  return text(out, 0, k);
}

// encodeJs is encode without the platform's encoder.
function encodeJs(s) {
  let size = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { size += 4; i++; }
    else size += 3; // a lone surrogate is U+FFFD, three bytes too
  }
  const out = new Uint8Array(size);
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) { out[k++] = c; continue; }
    if (c < 0x800) { out[k++] = 0xc0 | (c >> 6); out[k++] = 0x80 | (c & 0x3f); continue; }
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && (d & 0xfc00) === 0xdc00) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
        out[k++] = 0xf0 | (c >> 18); out[k++] = 0x80 | ((c >> 12) & 0x3f);
        out[k++] = 0x80 | ((c >> 6) & 0x3f); out[k++] = 0x80 | (c & 0x3f);
        continue;
      }
      c = 0xfffd;
    }
    out[k++] = 0xe0 | (c >> 12); out[k++] = 0x80 | ((c >> 6) & 0x3f); out[k++] = 0x80 | (c & 0x3f);
  }
  return out;
}

// encode is the UTF-8 bytes of s, a Uint8Array: the platform's encoder where there is one (Node and
// Hermes have it), else encodeJs, which gives the same bytes.
const platform = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const encode = platform ? (s) => platform.encode(s) : encodeJs;

module.exports = { decode, decodeLenient, encode, encodeJs };
