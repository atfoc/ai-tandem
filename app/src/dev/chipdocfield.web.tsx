// The field the chipdoc gallery draws its box with in a browser (the composer spike's ChipField.web.tsx). DEV ONLY: the web
// build's chip input is ChipInput.web.tsx (a contenteditable, AD-61); this field exists so that the native box's logic
// (chipdoc.ts, ChipDocInput.tsx) is checked in Chromium too (web/dev/checks/L4b-chipdoc.mjs), without a simulator.
//
// react-native-web draws a TextInput as a <textarea>, which shows no styled runs: the chips are drawn in a layer of Text
// behind it, and the textarea's own text is transparent. The layer holds the same string in the same style, so the lines
// break at the same places and a chip's pill sits where its characters are. The layer is in the flow (it gives the box its
// height, so the box grows with the text), the textarea is laid over it. Copy and cut put tags on the clipboard.
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";

import type { FieldHandle, FieldProps } from "../platform/chipinput/ChipDocInput.tsx";
import { SANS } from "../ui/fonts.ts";
import { BASE_SIZE } from "../ui/Text.tsx";
import { useTokens } from "../ui/theme.tsx";

const LINE = Math.round(BASE_SIZE * 1.45);

export const DevField = forwardRef<FieldHandle, FieldProps>(function DevField(
  { runs, text, selection, rev, onText, onSelection, onKeyPress, copyText, onCut, placeholder, editable, plain, testID },
  ref,
) {
  const t = useTokens();
  const area = useRef<any>(null);
  const copy = useRef(copyText), cut = useRef(onCut);
  copy.current = copyText; cut.current = onCut;
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), blur: () => area.current?.blur() }), []);

  // A refused edit (FieldProps.rev): the textarea is told the document's text and selection again, which a value prop equal
  // to the last one does not do.
  useEffect(() => {
    const el: HTMLTextAreaElement | null = area.current;
    if (!rev || !el || el.value === text) return;
    el.value = text;
    el.setSelectionRange?.(selection.start, selection.end);
  }, [rev]);

  useEffect(() => {
    const el: HTMLTextAreaElement | null = area.current;
    if (!el?.addEventListener) return;
    const onCopy = (e: ClipboardEvent, cutting: boolean) => {
      const c = copy.current();
      if (c == null) return; // nothing selected: the field's own copy
      e.preventDefault();
      e.clipboardData?.setData("text/plain", c);
      if (cutting) cut.current();
    };
    const c = (e: ClipboardEvent) => onCopy(e, false), x = (e: ClipboardEvent) => onCopy(e, true);
    el.addEventListener("copy", c); el.addEventListener("cut", x);
    return () => { el.removeEventListener("copy", c); el.removeEventListener("cut", x); };
  }, []);

  const font = { fontSize: BASE_SIZE, lineHeight: LINE, fontFamily: SANS, color: t.text, padding: 0 } as const;
  return (
    <ScrollView style={{ maxHeight: 6 * LINE + 6 }} contentContainerStyle={{ minHeight: 3 * LINE }} keyboardShouldPersistTaps="always">
      <View style={{ position: "relative" }}>
        <Text style={font} aria-hidden testID={`${testID}-layer`}>
          {runs.map((r, i) => (r.chip
            ? <Text key={i} testID="ref-chip" dataSet={{ kind: r.chip }} style={{ backgroundColor: t.accentSoft, color: t.accent, fontWeight: "600", borderRadius: 4 }}>{r.text}</Text>
            : <Text key={i}>{r.text}</Text>))}
          {"​"}
        </Text>
        <TextInput
          ref={area}
          multiline
          value={text}
          selection={selection}
          onChangeText={onText}
          onSelectionChange={(e) => onSelection(e.nativeEvent.selection)}
          onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
          editable={editable}
          {...(plain ? { autoCorrect: false, spellCheck: false } : {})}
          placeholder={placeholder}
          placeholderTextColor={t.faint}
          testID={testID}
          style={[font, { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, height: "100%", color: "transparent", caretColor: t.text, backgroundColor: "transparent", overflow: "hidden", resize: "none", outlineStyle: "none" } as any]}
        />
      </View>
    </ScrollView>
  );
});
