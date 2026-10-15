// A message's blocks drawn (AD-75): paragraphs, headings, lists, quotes, code, tables, rules. The tree is doc.ts's; the
// "\n" nodes in it are no drawing. The space between blocks is styles.css `.md`'s, collapsed (layout.ts).
import { memo, useEffect, useState } from "react";
import { Text as RNText, View } from "react-native";

import { SANS } from "../../ui/fonts.ts";
import { useTokens } from "../../ui/theme.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import type { Block } from "./doc.ts";
import { Inlines } from "./Inline.tsx";
import { spaced } from "./layout.ts";
import { HEADING, type Look } from "./look.ts";
import { LookContext, useLook } from "./look.tsx";
import { TableBlock } from "./Table.tsx";

type Inside = "root" | "li" | "quote" | "group";

/** The blocks of a list of children, one after the other; `caret` puts the streaming caret after the last text. */
export function Blocks({ kids, inside, caret = false }: { kids: Block[]; inside: Inside; caret?: boolean }) {
  const look = useLook();
  const items = spaced(kids, inside);
  return (
    <>
      {items.map(({ block, gap }, i) => <BlockView key={i} block={block} mt={gap * look.size} inside={inside} caret={caret && i === items.length - 1} />)}
    </>
  );
}

function BlockView({ block, mt, inside, caret }: { block: Block; mt: number; inside: Inside; caret: boolean }) {
  const t = useTokens();
  const look = useLook();
  switch (block.k) {
    case "p":
      return (
        <RNText testID="md-p" style={{ marginTop: mt, color: look.color, fontFamily: SANS, fontSize: look.size, lineHeight: Math.round(look.size * 1.45 * 100) / 100 }}>
          <Inlines kids={block.kids} />{caret ? <Caret /> : null}
        </RNText>
      );
    case "h": {
      const size = look.size * HEADING[block.depth - 1];
      return (
        <RNText testID="md-h" dataSet={{ depth: block.depth }} role="heading" aria-level={block.depth}
          style={{ marginTop: mt, color: block.depth === 6 ? t.muted : look.color, fontFamily: SANS, fontSize: size, lineHeight: size * 1.3, fontWeight: "600" }}>
          <Inlines kids={block.kids} />{caret ? <Caret /> : null}
        </RNText>
      );
    }
    case "hr": return <View testID="md-hr" style={{ marginTop: mt, borderTopWidth: 1, borderTopColor: t.line2 }} />;
    case "quote": {
      const inner: Look = { ...look, color: t.muted };
      return (
        <View testID="md-quote" style={{ marginTop: mt, paddingVertical: 1, paddingLeft: 11, borderLeftWidth: 3, borderLeftColor: t.line2 }}>
          <LookContext.Provider value={inner}><Blocks kids={block.kids} inside="quote" caret={caret} /></LookContext.Provider>
        </View>
      );
    }
    case "list": return <ListView block={block} mt={mt} caret={caret} />;
    case "code": return <CodeBlock lang={block.lang} text={block.text} mt={mt} />;
    case "table": return <TableBlock block={block} mt={mt} />;
    case "group":
      return <View testID="md-footnotes" style={{ marginTop: mt }}><Blocks kids={block.kids} inside="group" caret={caret} /></View>;
    case "li": case "nl": return null;
  }
}

function ListView({ block, mt, caret }: { block: Extract<Block, { k: "list" }>; mt: number; caret: boolean }) {
  const t = useTokens();
  const look = useLook();
  const items = block.kids.filter((b): b is Extract<Block, { k: "li" }> => b.k === "li");
  return (
    <View testID="md-list" dataSet={{ ordered: block.ordered, task: block.task }} role="list" style={{ marginTop: mt }}>
      {items.map((li, i) => (
        <View key={i} testID="md-li" role="listitem" style={{ flexDirection: "row", marginTop: i ? 0.15 * look.size : 0, paddingLeft: li.task ? 4 : 0 }}>
          {li.task ? null : (
            <RNText testID="md-marker" selectable={false} style={{ width: 20, paddingRight: 5, textAlign: "right", color: t.muted, fontFamily: block.ordered ? SANS : undefined, fontSize: look.size, lineHeight: Math.round(look.size * 1.45 * 100) / 100 }}>
              {block.ordered ? `${block.start + i}.` : "•"}
            </RNText>
          )}
          <View style={{ flex: 1, minWidth: 0 }}><Blocks kids={li.kids} inside="li" caret={caret && i === items.length - 1} /></View>
        </View>
      ))}
    </View>
  );
}

/** The streaming caret, after the last text of the message (styles.css `.msg.streaming … ::after`): a 7 × 14 block that pulses. */
function Caret() {
  const t = useTokens();
  const [dim, setDim] = useState(false);
  useEffect(() => { const id = setInterval(() => setDim((d) => !d), 450); return () => clearInterval(id); }, []);
  return (
    <View testID="md-caret" style={[{ width: 7, height: 14, marginLeft: 2, backgroundColor: t.text, opacity: dim ? 0.55 : 1 }, webStyle({ display: "inline-flex", verticalAlign: "-2px" })]} />
  );
}

