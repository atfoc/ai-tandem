// The web's field behind ChipInput. react-native-web draws a TextInput as a <textarea>, which shows no styled
// runs; the chips are therefore drawn in a layer of Text behind it, and the textarea's own text is transparent. The
// layer holds the same string in the same style, so the lines break at the same places and a chip's pill sits where
// its characters are. The layer is in the flow (it gives the box its height, so the box grows with the text), the
// textarea is laid over it. Copy and cut put tags on the clipboard, as the page does.
import React, { forwardRef, useEffect, useRef } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { colors, font, styles } from "./theme";
import type { FieldProps } from "./fieldtypes";

export const ChipField = forwardRef<TextInput, FieldProps>(function ChipField(
  { pieces, text, selection, onText, onSelection, onFocus, onBlur, copyText, onCut, placeholder, maxHeight, plain, testID, editable = true },
  ref,
) {
  const area = useRef<any>(null);
  const copy = useRef(copyText), cut = useRef(onCut);
  copy.current = copyText; cut.current = onCut;
  const set = (r: any) => { area.current = r; if (typeof ref === "function") ref(r); else if (ref) (ref as any).current = r; };

  useEffect(() => {
    const el: HTMLTextAreaElement | null = area.current;
    if (!el?.addEventListener) return;
    const onCopy = (e: ClipboardEvent, cutting: boolean) => {
      const t = copy.current?.();
      if (t == null) return; // no chip: the field's own copy
      e.preventDefault();
      e.clipboardData?.setData("text/plain", t);
      if (cutting) cut.current?.();
    };
    const c = (e: ClipboardEvent) => onCopy(e, false), x = (e: ClipboardEvent) => onCopy(e, true);
    el.addEventListener("copy", c); el.addEventListener("cut", x);
    return () => { el.removeEventListener("copy", c); el.removeEventListener("cut", x); };
  }, []);

  const layer = { ...font, color: colors.text, padding: 0 } as const;
  return (
    <ScrollView style={{ maxHeight }} contentContainerStyle={{ minHeight: font.lineHeight * 2 }} keyboardShouldPersistTaps="always">
      <View style={{ position: "relative" }}>
        <Text style={layer} aria-hidden testID={testID ? `${testID}-layer` : undefined}>
          {pieces.map((p, i) => (p.chip ? <Text key={i} style={[p.chip === "point" ? styles.point : styles.chip, { borderRadius: 6 }]}>{p.text}</Text> : <Text key={i}>{p.text}</Text>))}
          {"​"}
        </Text>
        <TextInput
          ref={set}
          multiline
          value={text}
          selection={selection}
          onChangeText={onText}
          onSelectionChange={(e) => onSelection(e.nativeEvent.selection)}
          onFocus={onFocus}
          onBlur={onBlur}
          editable={editable}
          {...(plain ? { autoCorrect: false, spellCheck: false } : {})}
          placeholder={placeholder}
          placeholderTextColor={colors.line}
          testID={testID}
          style={[layer, { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, height: "100%", color: "transparent", caretColor: colors.text, backgroundColor: "transparent", overflow: "hidden", resize: "none", outlineStyle: "none" } as any]}
        />
      </View>
    </ScrollView>
  );
});
