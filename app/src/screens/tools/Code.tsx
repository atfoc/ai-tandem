// A text of a card drawn as code: coloured as the language says (the same runs and the same tokens as a code block of a message), or as
// it is with no language or when it is too long to colour (B-TC-29). The text wraps where it must: nothing of a card scrolls sideways.
import { useMemo } from "react";
import { Text as RNText } from "react-native";

import { MONO } from "../../ui/fonts.ts";
import { useTokens } from "../../ui/theme.tsx";
import { tabs } from "./webtext.ts";
import { highlightRuns } from "../markdown/index.ts";

export const CODE_SIZE = 11;
export const CODE_LINE = 1.4;
export const codeStyle = { fontFamily: MONO, fontSize: CODE_SIZE, lineHeight: CODE_SIZE * CODE_LINE, ...tabs };

/** `testID` goes on the text: `dataSet.tokens` is how many of its runs are coloured. */
export function Code({ text, lang, color }: { text: string; lang?: string; color?: string }) {
  const t = useTokens();
  const runs = useMemo(() => (lang ? highlightRuns(lang, text) : null), [text, lang]);
  const tokens = runs?.filter((r) => r.tone).length ?? 0;
  return (
    <RNText testID="tool-pre" dataSet={{ tokens }} style={[codeStyle, { color: color ?? t.text }]}>
      {runs
        ? runs.map((r, i) => (r.tone || r.italic || r.bold
          ? <RNText key={i} style={{ color: r.tone ? t[r.tone] : undefined, fontStyle: r.italic ? "italic" : undefined, fontWeight: r.bold ? "700" : undefined }}>{r.v}</RNText>
          : r.v))
        : text}
    </RNText>
  );
}
