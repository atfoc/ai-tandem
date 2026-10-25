// A state word drawn (ux-improvements goal 3.1.3): a dot and the word in its tone, from the one list of
// @aiwb/core/logic/statewords.ts. A screen never writes a state word of its own.
//
// Contract of package F3 (plans/ux-improvements/PLAN.md). The colours are the theme's tokens (green `ok`, grey `muted`, amber
// `warn`, red `danger`), so a word is right in the light and dark themes and in every Catppuccin flavour; the text is 13 pt
// (`TYPE.secondary`) or more, never less.
import { StyleSheet, View } from "react-native";

import { serverWord, type StateWord as Word, type ServerWordContext, type WordTone } from "@aiwb/core/logic/statewords.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import type { Tokens } from "./tokens.ts";

import { useStore } from "../state/useStore.ts";
import { TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";
import { usePhone } from "./useLayout.ts";

export const toneOf = (t: Tokens, tone: WordTone): string => (tone === "ok" ? t.ok : tone === "warn" ? t.warn : tone === "bad" ? t.danger : t.muted);

/** The colour of a word's text: `warn` is a mark's amber and `ok` a mark's green, too weak for 13 pt text on white, so the text of a warning is `warnText` and of an ok `okText`. */
export const wordColour = (t: Tokens, tone: WordTone): string => (tone === "ok" ? t.okText : tone === "warn" ? t.warnText : tone === "bad" ? t.danger : t.muted);

/** The word of a server on this phone: its state, and iOS's refusal of the local network (the store's `localNetworkDenied`). */
export function useServerWord(v: Pick<ServerView, "state">): ReturnType<typeof serverWord> {
  const localNetworkDenied = useStore((s) => s.localNetworkDenied);
  return serverWord(v, { localNetworkDenied } satisfies ServerWordContext);
}

/** `colour` replaces the tone's colour of the dot and the text (an agent's colour on a board's "Claude is working…"). */
export function StateWord({ word, dot = true, size = TYPE.secondary, colour }: { word: Word; dot?: boolean; size?: number; colour?: string }) {
  const t = useTokens(), phone = usePhone(), c = colour ?? toneOf(t, word.tone);
  // (the wide layouts keep the mark's green for the text of an ok: `okText` is the phone's, goal 4.2)
  const ink = colour ?? (word.tone === "ok" && !phone ? t.ok : wordColour(t, word.tone));
  return (
    <View {...tid(TID.stateWord, { word: word.key, tone: word.tone })} accessible accessibilityLabel={word.text} style={styles.row}>
      {dot ? <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: c }]} /> : null}
      <Text size={Math.max(size, TYPE.secondary)} style={{ color: ink }}>{word.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
