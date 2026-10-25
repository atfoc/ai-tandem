// A chat message's Markdown (AD-75): GFM (tables, task lists, strikethrough, autolinks) through remark to mdast, and our own
// mdast → React Native renderer, so the same text is shown as the page shows today. Raw HTML is shown as text and never
// run; a link with an unsafe protocol is dropped; links open outside the app; an image is a link (nothing is fetched).
// Fenced code is coloured when its language is a known one and has a header with a Copy button. Reference tags are chips
// where they stand, and in a user's message @mentions link to their boards (screens/markdown/env.tsx gives what a press does).
//
// Long chats (goal 4.8): the text is cut into top-level blocks, each is parsed once (parse.ts keeps the trees) and drawn by a
// memoized component, so while an answer streams only its last block is parsed and rendered again.
import { memo, useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import type { AgentKind } from "@aiwb/core/types.ts";

import { useTokens } from "../../ui/theme.tsx";
import { Blocks } from "./Blocks.tsx";
import type { Doc } from "./doc.ts";
import { WhereContext, type Where } from "./env.tsx";
import { marginsOf } from "./layout.ts";
import type { Look } from "./look.ts";
import { LookContext } from "./look.tsx";
import { blocksOf, prepare, stats } from "./parse.ts";

type Props = {
  text: string;
  /** A user's message: single line breaks are kept and @mentions link to boards. */
  user?: boolean;
  /** The board whose chat this is: a chip shows its reference on it, drawn in the agent's colour. */
  board?: string;
  agent?: AgentKind | "";
  /** The chat the text is of (its key): it names the server whose boards an @mention links to. Without it, the board's. */
  of?: string;
  /** The agent is still writing it: a reference tag cut off at the end is not shown yet, and a caret follows the text. */
  streaming?: boolean;
  /** The size of the body text (default 13, the thread's) and its colour (default the theme's text). */
  size?: number;
  color?: string;
  /** A chat's thread on the phone layout: the phone's look (look.ts `phone`). */
  phone?: boolean;
};

export const Markdown = memo(function Markdown({ text, user = false, board, agent, of, streaming = false, size = 13, color, phone = false }: Props) {
  const t = useTokens();
  const blocks = useMemo(() => blocksOf(text, streaming), [text, streaming]);
  const server = serverOfKey(of ?? board);
  const where = useMemo<Where>(() => ({ board, agent, server, chat: of }), [board, agent, server, of]);
  const look = useMemo<Look>(() => ({ size, color: color ?? t.text, user, phone }), [size, color, t.text, user, phone]);
  // the tree of each block: the same object for a block whose text did not change, so its component is not rendered again
  const docs = blocks.map((b) => prepare(b, user));
  const last = docs.length - 1;
  return (
    <WhereContext.Provider value={where}>
      <LookContext.Provider value={look}>
        <View testID="md" dataSet={{ user, streaming }} style={{ minWidth: 0 }}>
          {docs.map((doc, i) => (
            <Block key={i} doc={doc} gap={i ? gapBetween(docs[i - 1], doc) * size : 0} caret={streaming && i === last} />
          ))}
        </View>
      </LookContext.Provider>
    </WhereContext.Provider>
  );
});

/** The em between two blocks of a message: the larger of the margins of the last block above and the first block under. */
function gapBetween(above: Doc, below: Doc): number {
  const a = above.kids.filter((b) => b.k !== "nl"), b = below.kids.filter((x) => x.k !== "nl");
  return Math.max(a.length ? marginsOf(a[a.length - 1])[1] : 0, b.length ? marginsOf(b[0])[0] : 0);
}

const Block = memo(function Block({ doc, gap, caret }: { doc: Doc; gap: number; caret: boolean }): ReactNode {
  stats.renders++;
  return <View testID="md-block" style={gap ? { marginTop: gap } : undefined}><Blocks kids={doc.kids} inside="root" caret={caret} /></View>;
});
