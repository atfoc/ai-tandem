// A fenced code block (AD-75): a header with the fence's language and a Copy button, and the code under it, coloured when the
// language is a known one, in a box that scrolls sideways on its own for a long line. The header is no part of the message's
// text for a quote (displayed.ts), and it is not selectable. On the phone (ux-improvements goal 3.5) the header is 40 pt with the
// language at the left and Wrap and Copy at the right, each with a 44 pt target; Wrap, on, wraps the lines instead of scrolling.
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View } from "react-native";

import { copyText } from "../../platform/clipboard";
import { MONO } from "../../ui/fonts.ts";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { showToast } from "../../ui/Toast.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { alpha } from "./look.ts";
import { highlightRuns } from "./highlight.ts";
import { useLook } from "./look.tsx";
import { T1_TID } from "../chat/ids.ts";

/** How long the button says "Copied" (Markdown.tsx today: 1400 ms). */
export const COPIED_MS = 1400;
/** The phone's head, and the size of its buttons' words (the mockup's code head). */
const HEAD = 40;
const PHONE_BUTTON = 15;

export function CodeBlock({ lang, text, mt }: { lang: string; text: string; mt: number }) {
  const t = useTokens();
  const look = useLook();
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // (the page's <pre> ends its text with a line break that draws nothing; a tab is four columns there)
  const runs = useMemo(() => {
    const r = highlightRuns(lang, text);
    const last = r?.[r.length - 1];
    if (r && last?.v.endsWith("\n")) r[r.length - 1] = { ...last, v: last.v.slice(0, -1) };
    return r;
  }, [lang, text]);
  const shown = text.replace(/\n$/, "").replace(/\t/g, "    ");
  const phone = !!look.phone;
  const size = phone ? 14 : (look.size * 12) / 13;

  const copy = () => {
    copyText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      // (the phone also toasts: its button's word is small and under the thumb)
      if (phone) showToast({ text: "Code copied" });
    }, (e) => console.error(e));
  };

  const body = (
    <RNText testID="md-code-body" style={{ fontFamily: MONO, fontSize: size, lineHeight: size * 1.5, color: t.text }}>
      {runs
        ? runs.map((r, i) => (r.tone || r.italic || r.bold
          ? <RNText key={i} dataSet={{ tone: r.tone }} style={{ color: r.tone ? t[r.tone] : undefined, fontStyle: r.italic ? "italic" : undefined, fontWeight: r.bold ? "700" : undefined }}>{r.v.replace(/\t/g, "    ")}</RNText>
          : r.v.replace(/\t/g, "    ")))
        : shown}
    </RNText>
  );

  if (phone) {
    // (the buttons are 44 pt tall in a 40 pt head: they hang 4 pt over its foot, into the code's padding, and the head is drawn over the code)
    const button = (testID: string, label: string, name: string, onPress: () => void, on?: boolean) => (
      <Pressable testID={testID} dataSet={on === undefined ? undefined : { on }} role="button" aria-pressed={on} accessibilityLabel={name} onPress={onPress}
        style={{ height: PHONE.target, minWidth: PHONE.target, alignItems: "center", justifyContent: "center", paddingBottom: PHONE.target - HEAD }}>
        <View style={{ paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: on ? alpha(t.accent, 0.14) : undefined }}>
          <RNText selectable={false} style={{ fontSize: PHONE_BUTTON, color: t.accent, fontWeight: "500" }}>{label}</RNText>
        </View>
      </Pressable>
    );
    return (
      <View testID="md-code" dataSet={{ lang }} style={{ marginTop: mt, borderWidth: 1, borderColor: t.line, borderRadius: 7, backgroundColor: t.panel, overflow: "hidden" }}>
        <View testID="md-code-head" style={{ zIndex: 1, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", height: HEAD, paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <RNText testID="md-code-lang" selectable={false} style={{ alignSelf: "center", fontFamily: MONO, fontSize: TYPE.secondary, color: t.muted }}>{lang}</RNText>
          <View style={{ flexDirection: "row" }}>
            {button(T1_TID.codeWrap, "Wrap", wrap ? "Wrap lines, on" : "Wrap lines", () => setWrap((w) => !w), wrap)}
            {button("md-copy", copied ? "Copied" : "Copy", "Copy code", copy)}
          </View>
        </View>
        {wrap
          ? <View style={{ padding: 12 }}>{body}</View>
          : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>{body}</ScrollView>}
      </View>
    );
  }

  return (
    <View testID="md-code" dataSet={{ lang }} style={{ marginTop: mt, borderWidth: 1, borderColor: t.line, borderRadius: 7, backgroundColor: t.panel, overflow: "hidden" }}>
      <View testID="md-code-head" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 24, paddingVertical: 2, paddingLeft: 10, paddingRight: 4, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <RNText testID="md-code-lang" selectable={false} style={{ fontFamily: MONO, fontSize: 11, color: t.faint }}>{lang}</RNText>
        <Pressable testID="md-copy" role="button" onPress={copy} style={{ paddingVertical: 2, paddingHorizontal: 6, borderRadius: 5 }}>
          <RNText selectable={false} style={{ fontSize: 11, color: t.muted }}>{copied ? "Copied" : "Copy"}</RNText>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}>
        {body}
      </ScrollView>
    </View>
  );
}
