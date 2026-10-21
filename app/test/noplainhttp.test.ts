import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// "No plain HTTP" is kept by the app's code, not by the system (AD-36, point 2): ATS is off on iOS, so these tests
// read the sources and fail on any other way out than `aiwb-net`, whose native code builds every address with the
// literal scheme `https` in one function (`httpsURL`). Voice (architecture VC-7) has one named second way out: `fetch(` and
// `new WebSocket` are allowed in exactly `src/voice/platform/net.native.ts` and `net.web.ts`, which make every address with
// `origin.ts` (the voice service's one place for addresses); the servers' rule is unchanged.

const app = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files under `dir` (relative to app/) whose name ends in one of `exts`, skipping `skip` directories. */
function files(dir: string, exts: string[], skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(app, d), { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "build" || skip.includes(e.name)) continue;
        walk(p);
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The app's own JS: app/src and app/modules/<m>/src, not the dev screens (`dev/`: the device self-tests). */
function jsSources(): string[] {
  const modules = readdirSync(join(app, "modules"), { withFileTypes: true }).filter((e) => e.isDirectory());
  return [
    ...files("src", [".ts", ".tsx", ".js", ".jsx", ".mjs"], ["dev"]),
    ...modules.flatMap((m) => files(join("modules", m.name, "src"), [".ts", ".tsx", ".js", ".jsx", ".mjs"])),
  ];
}

/** The files of the voice net, the only ones outside `aiwb-net` that may call `fetch(` or make a `WebSocket` (relative to app/). */
export const VOICE_NET_FILES = ["src/voice/platform/net.native.ts", "src/voice/platform/net.web.ts"];

const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
const NETWORK_CLASSES = new Set(["XMLHttpRequest", "WebSocket", "EventSource"]);

/** A name used as `x` or as `globalThis.x` / `window.x` / `self.x`, or either of them in parentheses or cast (`(WebSocket as T)`). */
function globalName(e: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(e)) return globalName(e.expression);
  if (ts.isAsExpression(e)) return globalName(e.expression);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && GLOBALS.has(e.expression.text)) return e.name.text;
  return null;
}

/** What in one JS file is a way to the network that is not `aiwb-net`: a call of the global `fetch`, `new XMLHttpRequest`,
 *  `new WebSocket`, `new EventSource`, and any string with `http://` (comments are not looked at). */
export function plainHttpFindings(text: string, name = "x.ts"): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && globalName(n.expression) === "fetch") found.push(`line ${at(n)}: a call of fetch(`);
    if (ts.isNewExpression(n)) {
      const g = globalName(n.expression);
      if (g && NETWORK_CLASSES.has(g)) found.push(`line ${at(n)}: new ${g}`);
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isJsxText(n)) && /http:\/\//i.test(n.text)) {
      found.push(`line ${at(n)}: the text http://`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("no plain http: the app's JS reaches the network only through aiwb-net, and voice's two net files", () => {
  const sources = jsSources();
  assert.ok(sources.length > 10, "the scan found the app's sources");
  for (const f of VOICE_NET_FILES) assert.ok(sources.includes(f), `${f} is scanned`);
  const bad: string[] = [];
  for (const f of sources) {
    if (VOICE_NET_FILES.includes(f)) continue;
    for (const finding of plainHttpFindings(readFileSync(join(app, f), "utf8"), f)) bad.push(`${f} ${finding}`);
  }
  assert.deepEqual(bad, []);
});

/** The first argument of each `fetch(` call and `new WebSocket` (also cast or in parentheses) in a file, as the kind of expression it is. */
function addressArguments(text: string, name: string): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    const callee = ts.isCallExpression(n) || ts.isNewExpression(n) ? globalName(n.expression) : null;
    if (callee && (callee === "fetch" || callee === "WebSocket") && (ts.isNewExpression(n) || ts.isCallExpression(n))) {
      const first = n.arguments?.[0];
      found.push(first && ts.isIdentifier(first) ? first.text : first ? ts.SyntaxKind[first.kind] : "none");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("no plain http: voice's net files make their addresses with origin.ts and hold no http:// text", () => {
  for (const f of VOICE_NET_FILES) {
    const text = readFileSync(join(app, f), "utf8");
    assert.deepEqual(plainHttpFindings(text, f).filter((x) => /http:\/\//.test(x)), [], `${f} has no http:// text`);
    // Whatever they open is an address that was made elsewhere (a variable), never one written in the call.
    assert.ok(addressArguments(text, f).every((a) => a === "url"), `${f}: every address is a variable named url (${addressArguments(text, f)})`);
  }
  const native = readFileSync(join(app, VOICE_NET_FILES[0]), "utf8"), web = readFileSync(join(app, VOICE_NET_FILES[1]), "utf8");
  assert.deepEqual(addressArguments(native, "n.ts"), ["url"], "the phone's net opens one socket (its fetch is expo/fetch's, under another name)");
  assert.deepEqual(addressArguments(web, "w.ts"), ["url", "url"], "the web net calls fetch once and opens one socket");
  assert.match(native, /import \{ voiceURL \} from "\.\/origin\.ts";/);
  assert.match(native, /address: voiceURL,/);
  assert.match(web, /import \{ pageVoiceBase, pageVoiceURL \} from "\.\/origin\.ts";/);
  assert.match(web, /address: \(kind, path, query\) => pageVoiceURL\(origin, kind, path, query\),/);
  // The service's own addresses are written in origin.ts and nowhere else.
  const elsewhere = jsSources().filter((f) => f !== "src/voice/platform/origin.ts" && /api\.elevenlabs\.io|wss:\/\//.test(readFileSync(join(app, f), "utf8")));
  assert.deepEqual(elsewhere, []);
  assert.match(readFileSync(join(app, "src/voice/platform/origin.ts"), "utf8"), /export const VOICE_HTTP = "https:\/\/api\.elevenlabs\.io";/);
});

test("no plain http: the scan sees what it is meant to see", () => {
  assert.deepEqual(plainHttpFindings("await fetch(url); const x = globalThis.fetch('/a'); new WebSocket(u); new window.EventSource(u); new XMLHttpRequest();"), [
    "line 1: a call of fetch(", "line 1: a call of fetch(", "line 1: new WebSocket", "line 1: new EventSource", "line 1: new XMLHttpRequest",
  ]);
  assert.deepEqual(plainHttpFindings("const u = 'http://x'; const v = `http://${y}`;"), ["line 1: the text http://", "line 1: the text http://"]);
  // A method called fetch, a comment, https and the name in a type are not findings.
  assert.deepEqual(plainHttpFindings("// http://x and fetch(\ns.fetch(r); mod.fetch({}); const v = 'https://x'; interface I { fetch(o: A): B }"), []);
  // A global in parentheses or cast is still the global.
  assert.deepEqual(plainHttpFindings("new (WebSocket as unknown as T)(u, [], {}); new (globalThis.WebSocket)(u); (fetch as F)(u);"), ["line 1: new WebSocket", "line 1: new WebSocket", "line 1: a call of fetch("]);
  assert.deepEqual(addressArguments("fetch(url, i); new WebSocket(`x${y}`); new (WebSocket as T)(u, [], {});", "x.ts"), ["url", "TemplateExpression", "u"]);
});

/** The native sources of every module under app/modules. */
function nativeSources(ext: string): string[] {
  return files("modules", [ext]).filter((f) => !f.includes(`${join("", "build")}/`));
}

/** The text of the function whose declaration line contains `signature` (its braces matched), or null. */
function functionBody(text: string, signature: string): { from: number; to: number } | null {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return { from: start, to: i };
  }
  return null;
}

test("no plain http: the Swift of the modules builds an address in one function, with the scheme https", () => {
  const swift = nativeSources(".swift");
  assert.ok(swift.length > 0, "there is Swift to scan");
  const bad: string[] = [];
  let built = 0;
  for (const f of swift) {
    const text = readFileSync(join(app, f), "utf8");
    if (/http:\/\//i.test(text)) bad.push(`${f}: the text http://`);
    const one = functionBody(text, "func httpsURL(");
    // `URL(` as a call (not the end of httpsURL( or NSURL(), and `URL(string:` in particular.
    for (const m of text.matchAll(/(?<![A-Za-z0-9_])URL\(/g)) {
      const i = m.index ?? 0;
      if (one && i > one.from && i < one.to && text.startsWith("URL(string:", i)) built++;
      else bad.push(`${relative(app, join(app, f))}: URL( at offset ${i} outside httpsURL`);
    }
    if (one) assert.match(text.slice(one.from, one.to), /"https:\/\//, "httpsURL builds an https address");
  }
  assert.equal(built, 1, "exactly one URL(string:) in the Swift of the modules, in httpsURL");
  assert.deepEqual(bad, []);
});

test("no plain http: the Kotlin of the modules holds no http:// and builds no URL by hand", () => {
  const bad: string[] = [];
  for (const f of nativeSources(".kt")) {
    const text = readFileSync(join(app, f), "utf8");
    if (/http:\/\//i.test(text)) bad.push(`${f}: the text http://`);
    if (/(?<![A-Za-z0-9_])(URL|URI)\(/.test(text)) bad.push(`${f}: URL( or URI(`);
    if (/scheme\(\s*"http"\s*\)|"http"/.test(text)) bad.push(`${f}: the scheme http`);
  }
  assert.deepEqual(bad, []);
});
