// A chat message's Markdown: GFM (tables, task lists, strikethrough, autolinks)
// through react-markdown, which never renders raw HTML (it shows as text) and
// drops unsafe link protocols. Fenced code is highlighted (lowlight, a few
// languages) and gets a Copy button; links open in a new tab; images show as
// links (nothing is fetched).
// Reference tags (⌘L, ⌘⇧L) are drawn as chips where they stand, and in a
// user's message @mentions are links to their boards (logic/markdown.ts).
//
// Streaming: the text is cut into top-level blocks and each block is memoized,
// so while the agent writes only the last block is parsed again.
import React, { createContext, useContext, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
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
import { useStore } from "./store.ts";
import { openBoard } from "./Sidebar.tsx";
import { resolveName, cleanName } from "./logic/mentions.ts";
import { parseRef } from "./logic/refs.ts";
import { splitBlocks, stashRefs, rehypeSlots, trimPartialRef } from "./logic/markdown.ts";
import { showRef } from "./board.ts";
import { RefChip } from "./RefInput.tsx";
import type { AgentKind } from "./types.ts";

/** Where a chip shows its reference: the chat's board, drawn in its agent's colour. */
const Where = createContext<{ board?: string; agent?: AgentKind | "" }>({});

type Props = {
  text: string;
  /** A user's message: single line breaks are kept and @mentions link to boards. */
  user?: boolean;
  board?: string;
  agent?: AgentKind | "";
  /** The agent is still writing it: a reference tag cut off at the end is not shown yet. */
  streaming?: boolean;
};

export function Markdown({ text, user = false, board, agent, streaming = false }: Props) {
  const blocks = useMemo(() => splitBlocks(streaming ? trimPartialRef(text ?? "") : text ?? ""), [text, streaming]);
  const where = useMemo(() => ({ board, agent }), [board, agent]);
  return (
    <Where.Provider value={where}>
      <div className="md">{blocks.map((b, i) => <Block key={i} text={b} user={user} />)}</div>
    </Where.Provider>
  );
}

const REMARK: Options["remarkPlugins"] = [remarkGfm];
const REMARK_USER: Options["remarkPlugins"] = [remarkGfm, remarkBreaks];
// Code colours for the languages agents write most (their aliases too: sh, js, ts, py, html,
// yml, …). Only fences that name their language are highlighted: no guessing while streaming.
const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml });

/** A rehype plugin: `pre > code.language-x` gets highlight.js's spans when x is known. */
function rehypeCode() {
  const walk = (n: any) => {
    for (const c of n.children ?? []) {
      const code = c.tagName === "pre" ? c.children?.[0] : undefined;
      if (code?.tagName !== "code") { walk(c); continue; }
      const lang = langOf(c);
      if (!lang || !lowlight.registered(lang)) continue;
      const text = (code.children as any[]).map((t) => (t.type === "text" ? t.value : "")).join("");
      code.children = lowlight.highlight(lang, text).children;
      code.properties = { ...code.properties, className: [...(code.properties?.className ?? []), "hljs"] };
    }
  };
  return (tree: any) => { walk(tree); };
}

const Block = React.memo(function Block({ text, user }: { text: string; user: boolean }) {
  const { md, rehype } = useMemo(() => {
    const s = stashRefs(text);
    return { md: s.text, rehype: [rehypeSlots({ refs: s.refs, mentions: user }), rehypeCode] as Options["rehypePlugins"] };
  }, [text, user]);
  return <ReactMarkdown remarkPlugins={user ? REMARK_USER : REMARK} rehypePlugins={rehype} components={COMPONENTS}>{md}</ReactMarkdown>;
});

function Chip({ tag, after }: { tag: string; after?: React.ReactNode }) {
  const { board, agent } = useContext(Where);
  const r = parseRef(tag);
  const chip = <RefChip tag={tag} onClick={board && r ? () => showRef(board, r, agent || "unknown") : undefined} />;
  return after ? <span className="nowrap">{chip}{after}</span> : chip;
}

function Mention({ raw }: { raw: string }) {
  const boards = useStore((s) => s.boards);
  const name = cleanName(raw.slice(1));
  const b = resolveName(name, boards)[0];
  if (!b) return <>{raw}</>;
  const rest = raw.slice(1).startsWith(name) ? raw.slice(1 + name.length) : "";
  const link = <button className="mention" onClick={() => openBoard(b.id)}>@{b.name}</button>;
  return rest ? <span className="nowrap">{link}{rest}</span> : link;
}

function CodeBlock({ lang, children }: { lang: string; children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const t = ref.current?.textContent ?? "";
    void navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, (e) => console.error(e));
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang}</span>
        <button type="button" className="md-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const langOf = (node: any): string => {
  const cls = node?.children?.[0]?.properties?.className;
  const l = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith("language-"));
  return l ? l.slice("language-".length) : "";
};

const COMPONENTS: Components = {
  pre: ({ node, children }) => <CodeBlock lang={langOf(node)}>{children}</CodeBlock>,
  a: ({ node, href, children, ...p }) => href
    ? <a {...p} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => (typeof src === "string" && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>
    : <>{alt}</>),
  table: ({ node, ...p }) => <div className="md-table"><table {...p} /></div>,
  span: ({ node, ...p }) => {
    const d = p as Record<string, unknown>;
    if (typeof d["data-ref"] === "string") return <Chip tag={d["data-ref"]} after={p.children} />;
    if (typeof d["data-mention"] === "string") return <Mention raw={d["data-mention"]} />;
    return <span {...p} />;
  },
};
