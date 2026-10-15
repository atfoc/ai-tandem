import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// No LayoutAnimation in the app's code. A LayoutAnimation is applied to every view that the next commit changes, whatever the
// code that configured it meant, and on iOS it put back the starting transform of a view that a native-driven animation was moving:
// the Sheet (its rise is `useNativeDriver`) was not drawn when its text box had the focus as it opened, because the keyboard's
// LayoutAnimation of `useKeyboardAvoid` was in flight (see that file; flow `sheets`, section 6). The sources are read, as in
// `noplainhttp.test.ts`.

const app = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The app's own JS under app/src, not the dev screens (`dev/`: the device self-tests). */
function sources(dir = "src"): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(app, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "dev" && e.name !== "node_modules") out.push(...sources(p));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const LAYOUT_ANIMATION_USES = new Set(["configureNext", "create", "Presets", "easeInEaseOut", "linear", "spring"]);

/** What in one JS file uses the `LayoutAnimation` of React Native: `LayoutAnimation.configureNext`, `.create`, `.Presets`, `.easeInEaseOut`,
 *  `.linear`, `.spring` and `LayoutAnimation[...]` (comments and strings are not looked at). */
export function layoutAnimationFindings(text: string, name = "x.ts"): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "LayoutAnimation" && LAYOUT_ANIMATION_USES.has(n.name.text)) {
      found.push(`line ${at(n)}: LayoutAnimation.${n.name.text}`);
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "LayoutAnimation") found.push(`line ${at(n)}: LayoutAnimation[...]`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("no LayoutAnimation: the app's JS runs none (it reset a native-driven transform on iOS: the Sheet was not drawn)", () => {
  const files = sources();
  assert.ok(files.length > 10, "the scan found the app's sources");
  const bad: string[] = [];
  for (const f of files) for (const finding of layoutAnimationFindings(readFileSync(join(app, f), "utf8"), f)) bad.push(`${f} ${finding}`);
  assert.deepEqual(bad, [], "a LayoutAnimation is applied to every view the next commit changes; on iOS it reset a native-driven transform (the Sheet was not drawn when its box had the focus as it opened): move the view with an Animated value or set the state at once; see useKeyboardAvoid.ts");
});

test("no LayoutAnimation: the scan sees what it is meant to see", () => {
  assert.deepEqual(layoutAnimationFindings("LayoutAnimation.configureNext(LayoutAnimation.create(200, 'keyboard', 'opacity'));\nLayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);\nLayoutAnimation.spring();"), [
    "line 1: LayoutAnimation.configureNext", "line 1: LayoutAnimation.create", "line 2: LayoutAnimation.configureNext", "line 2: LayoutAnimation.Presets", "line 3: LayoutAnimation.spring",
  ]);
  // A comment, a string, an Animated value and another object's `create` are not findings.
  assert.deepEqual(layoutAnimationFindings("// LayoutAnimation.configureNext(x)\nconst s = 'LayoutAnimation.create'; Animated.timing(v, {}); store.create(1); Foo.Presets;"), []);
});
