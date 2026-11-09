// The native sides of the aiwb-indent module, read as text (they cannot be compiled here without a build of the app): the names the
// config, the contract and the JS side rely on, the rules shared with src/AiwbIndent.ts (the max share of an indent), and the few
// lines whose absence the prototype showed to break the indent (README.md of the module says why each matters).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_INDENT_SHARE } from "../modules/aiwb-indent/src/AiwbIndent.ts";

const read = (file: string) => fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const swift = read("../modules/aiwb-indent/ios/AiwbIndentModule.swift");
const kotlin = read("../modules/aiwb-indent/android/src/main/java/expo/modules/aiwbindent/AiwbIndentModule.kt");
const config = JSON.parse(read("../modules/aiwb-indent/expo-module.config.json")) as { apple: { modules: string[] }; android: { modules: string[] } };

test("the Swift and the Kotlin cap an indent at the share of the contract", () => {
  const s = swift.match(/let maxIndentShare: CGFloat = ([\d.]+)/);
  assert.ok(s, "Swift defines maxIndentShare");
  assert.equal(Number(s[1]), MAX_INDENT_SHARE);
  const k = kotlin.match(/const val MAX_INDENT_SHARE = ([\d.]+)f?/);
  assert.ok(k, "Kotlin defines MAX_INDENT_SHARE");
  assert.equal(Number(k[1]), MAX_INDENT_SHARE);
  // ... and use it in their hangWidth.
  assert.match(swift, /textWidth \* maxIndentShare/);
  assert.match(kotlin, /textWidth \* MAX_INDENT_SHARE/);
});

test("expo-module.config.json names the classes the sources define", () => {
  assert.deepEqual(config.apple.modules, ["AiwbIndentModule"]);
  assert.match(swift, /public class AiwbIndentModule: Module/);
  const [android] = config.android.modules;
  const pkg = android.slice(0, android.lastIndexOf("."));
  const cls = android.slice(android.lastIndexOf(".") + 1);
  assert.match(kotlin, new RegExp(`^package ${pkg.replace(/\./g, "\\.")}$`, "m"));
  assert.match(kotlin, new RegExp(`^class ${cls} : Module\\(\\)`, "m"));
});

test("both sides are the module of the contract: its name, setIndent and the onDrawnHeight event with tag and height", () => {
  for (const [name, src] of [["swift", swift], ["kotlin", kotlin]] as const) {
    assert.match(src, /Name\("AiwbIndent"\)/, name);
    assert.match(src, /Events\("onDrawnHeight"\)/, name);
    assert.match(src, /AsyncFunction\("setIndent"\)/, name);
    assert.match(src, /sendEvent\("onDrawnHeight"/, name);
  }
  assert.match(swift, /\.runOnQueue\(\.main\)/);
  assert.match(kotlin, /\.runOnQueue\(Queues\.MAIN\)/);
  assert.match(swift, /\["tag": tag, "height": /);
  assert.match(kotlin, /mapOf\("tag" to tag, "height" to /);
});

test("the Swift never asks for the text view's layoutManager (that switches it to TextKit 1 for good)", () => {
  const code = swift.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\.layoutManager\b/);
  assert.match(code, /textContentStorage\(_ textContentStorage: NSTextContentStorage, textParagraphWith range: NSRange\)/);
});

test("the Kotlin spans make the layout reflow (UpdateLayout) and its watcher comes before TextView's (priority above 100)", () => {
  assert.match(kotlin, /class HangSpan\(val px: Int\) : LeadingMarginSpan, UpdateLayout/);
  assert.match(kotlin, /class TabStop\(val at: Int\) : TabStopSpan, UpdateLayout/);
  const p = kotlin.match(/const val WATCHER_PRIORITY = (\d+)/);
  assert.ok(p, "Kotlin defines WATCHER_PRIORITY");
  assert.ok(Number(p[1]) > 100, "above TextView's ChangeWatcher");
  assert.match(kotlin, /Spanned\.SPAN_INCLUSIVE_INCLUSIVE or \(WATCHER_PRIORITY shl Spanned\.SPAN_PRIORITY_SHIFT\)/);
});
