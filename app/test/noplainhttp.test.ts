import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// "No plain HTTP" is kept by the app's code, not by the system (AD-36, point 2): ATS is off on iOS, so these tests
// read the sources and fail on any other way out than `aiwb-net`, whose native code builds every address with the
// literal scheme `https` in one function (`httpsURL`).

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

const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
const NETWORK_CLASSES = new Set(["XMLHttpRequest", "WebSocket", "EventSource"]);

/** A name used as `x` or as `globalThis.x` / `window.x` / `self.x`. */
function globalName(e: ts.Expression): string | null {
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

test("no plain http: the app's JS reaches the network only through aiwb-net", () => {
  const sources = jsSources();
  assert.ok(sources.length > 10, "the scan found the app's sources");
  const bad: string[] = [];
  for (const f of sources) {
    for (const finding of plainHttpFindings(readFileSync(join(app, f), "utf8"), f)) bad.push(`${f} ${finding}`);
  }
  assert.deepEqual(bad, []);
});

test("no plain http: the scan sees what it is meant to see", () => {
  assert.deepEqual(plainHttpFindings("await fetch(url); const x = globalThis.fetch('/a'); new WebSocket(u); new window.EventSource(u); new XMLHttpRequest();"), [
    "line 1: a call of fetch(", "line 1: a call of fetch(", "line 1: new WebSocket", "line 1: new EventSource", "line 1: new XMLHttpRequest",
  ]);
  assert.deepEqual(plainHttpFindings("const u = 'http://x'; const v = `http://${y}`;"), ["line 1: the text http://", "line 1: the text http://"]);
  // A method called fetch, a comment, https and the name in a type are not findings.
  assert.deepEqual(plainHttpFindings("// http://x and fetch(\ns.fetch(r); mod.fetch({}); const v = 'https://x'; interface I { fetch(o: A): B }"), []);
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
