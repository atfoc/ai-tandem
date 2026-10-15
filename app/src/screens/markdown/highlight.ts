// The code highlighter (AD-75): lowlight (highlight.js's grammars, as a tree) with the languages agents write most (and
// their aliases: sh, js, ts, py, html, yml, …), as the old page's highlight.ts has it. A fence that names a known language is
// coloured, an unknown or no language is plain, and nothing is guessed (no language detection while streaming).
// The tree is flattened to runs of text with the token colour the page's .hljs-* rules (styles.css) give; the colours
// are tokens of the theme, picked by the drawing. No React and no react-native here, so Node loads it.
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

export const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml });

/** The tokens of the theme a run of code takes its colour from; none is the code block's own text colour. */
export type SyntaxTone = "faint" | "synKeyword" | "synString" | "synNumber" | "synTitle" | "synType" | "synAttr" | "muted" | "danger";

export type Run = { v: string; tone?: SyntaxTone; italic?: boolean; bold?: boolean };

/** Code longer than this is shown plain: a run per token is a Text per token, and the thread must stay light (goal 4.8). */
export const MAX_HIGHLIGHTED = 20_000;

// styles.css `.hljs-*`, in its order; a later rule of the same weight wins.
const RULES: [string[], SyntaxTone][] = [
  [["comment", "quote"], "faint"],
  [["keyword", "selector-tag", "doctag"], "synKeyword"],
  [["string", "regexp", "addition"], "synString"],
  [["number", "literal", "symbol", "bullet"], "synNumber"],
  [["title", "section", "selector-id", "selector-class"], "synTitle"],
  [["built_in", "type"], "synType"],
  [["attr", "attribute", "name", "tag", "property"], "synAttr"],
  [["meta", "subst", "template-variable"], "muted"],
  [["deletion"], "danger"],
];

/** The tone of an element with these classes (without the "hljs-"), inside a `.hljs-class` or not: the rules with two
 *  classes (`.hljs-title.class_`, `.hljs-class .hljs-title`, `.hljs-variable.constant_`) weigh more than the others. */
function toneOf(cls: Set<string>, inClass: boolean): SyntaxTone | undefined {
  if (cls.has("title") && (cls.has("class_") || inClass)) return "synType";
  if (cls.has("variable") && cls.has("constant_")) return "synNumber";
  let tone: SyntaxTone | undefined;
  for (const [names, t] of RULES) if (names.some((n) => cls.has(n))) tone = t;
  return tone;
}

type HNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HNode[] };
type Style = { tone?: SyntaxTone; italic?: boolean; bold?: boolean };

/** The runs of `code` highlighted as `lang`, or null when the language is not one lowlight has (or the code is too long). */
export function highlightRuns(lang: string, code: string): Run[] | null {
  if (!lang || !lowlight.registered(lang) || code.length > MAX_HIGHLIGHTED) return null;
  const runs: Run[] = [];
  const walk = (n: HNode, style: Style, inClass: boolean) => {
    if (n.type === "text") {
      const v = n.value ?? "";
      if (!v) return;
      const last = runs[runs.length - 1];
      if (last && last.tone === style.tone && !last.italic === !style.italic && !last.bold === !style.bold) last.v += v;
      else runs.push({ v, ...(style.tone ? { tone: style.tone } : {}), ...(style.italic ? { italic: true } : {}), ...(style.bold ? { bold: true } : {}) });
      return;
    }
    let next = style, ctx = inClass;
    if (n.type === "element") {
      const cls = new Set((Array.isArray(n.properties?.className) ? n.properties.className : []).map((c) => String(c).replace(/^hljs-/, "")));
      const tone = toneOf(cls, inClass);
      next = { tone: tone ?? style.tone, italic: style.italic || cls.has("emphasis") || tone === "faint", bold: style.bold || cls.has("strong") };
      ctx = inClass || cls.has("class");
    }
    for (const c of n.children ?? []) walk(c, next, ctx);
  };
  walk(lowlight.highlight(lang, code) as unknown as HNode, {}, false);
  return runs;
}
