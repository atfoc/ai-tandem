// The code highlighter: lowlight (highlight.js's grammars, as a tree) with the languages agents
// write most (their aliases too: sh, js, ts, py, html, yml, …). A message's fenced code is coloured
// by it (Markdown.tsx), and a tool card's command (ToolCard.tsx). The colours are the .hljs-*
// rules of styles.css.
import { createLowlight } from "lowlight";
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

export const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml });
