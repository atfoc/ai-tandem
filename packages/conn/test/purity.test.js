'use strict';

// The rule of core/ (architecture AD-10): the shared code runs on Node and on React Native's Hermes,
// so it names nothing that only Node or a browser has. Bytes are Uint8Array, text from bytes goes
// through core/utf8.js, an abort is core/abort.js's, a timer is cleared and set again. The package's
// root (index.js) is held to the same rule: it is what a phone requires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'index.js',
  ...fs.readdirSync(path.join(ROOT, 'core')).filter((f) => f.endsWith('.js')).map((f) => path.join('core', f)),
];

// What core/ may not name, and why.
const FORBIDDEN = [
  [/\brequire\(\s*['"]node:/, "a Node module (require('node:…'))"],
  [/\bBuffer\b/, 'Buffer (bytes are Uint8Array)'],
  [/\bprocess\b/, 'process'],
  [/\bDOMException\b/, 'DOMException (core/abort.js abortError)'],
  [/\.refresh\(/, 'a timer refresh (clear it and set it again)'],
  [/\bStringDecoder\b/, 'StringDecoder (core/utf8.js)'],
  [/\bTextDecoder\b/, 'TextDecoder (core/utf8.js; Hermes has none)'],
  [/\bsetImmediate\b/, 'setImmediate'],
  [/\b__dirname\b|\b__filename\b/, 'a file path of the module'],
];

// code is a file's text without its comments: block comments, and line comments that start a line
// or follow a space (so that "https://" in a string stays).
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('core/ and the root name nothing that only Node or a browser has', () => {
  assert.ok(FILES.length > 10, 'the files of core/ are found');
  for (const f of FILES) {
    const text = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(text, re, `${f} names ${what}`);
  }
});

test('core/ requires only its own files, and the root only core/', () => {
  for (const f of FILES) {
    const text = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const allowed = f === 'index.js' ? /^\.\/core\/[a-z0-9]+$/ : /^\.\/[a-z0-9]+(\.json)?$/;
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.match(m[1], allowed, `${f} requires ${m[1]}`);
    assert.doesNotMatch(text, /^\s*import\s/m, f);
  }
});

test('the check sees what it looks for', () => {
  const caught = (src) => FORBIDDEN.some(([re]) => re.test(code(src)));
  assert.ok(caught("const fs = require('node:fs');"));
  assert.ok(caught('const b = Buffer.from(x);'));
  assert.ok(caught('timer.refresh();'));
  assert.ok(caught('if (process.env.X) f();'));
  assert.ok(!caught('// a Buffer in a comment, and the process of it\nconst a = 1;'));
  assert.ok(!caught("const u = `https://${host}:${port}`; // Buffer"));
});
