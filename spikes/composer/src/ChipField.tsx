// The platform's field behind ChipInput (native: iOS, Android): a controlled multiline TextInput whose children
// are nested <Text> spans, a chip being a span with a background. The web has its own (ChipField.web.tsx).
import React, { forwardRef } from "react";
import { Text, TextInput, type NativeSyntheticEvent, type TextInputSelectionChangeEventData, type TextInputProps } from "react-native";
import { colors, font, styles } from "./theme";
import type { FieldProps } from "./fieldtypes";

export const ChipField = forwardRef<TextInput, FieldProps>(function ChipField(
  { pieces, selection, onText, onSelection, onFocus, onBlur, placeholder, maxHeight, plain, testID, editable = true },
  ref,
) {
  const props: TextInputProps = {
    multiline: true,
    placeholder,
    placeholderTextColor: colors.line,
    selection,
    onChangeText: onText,
    onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => onSelection(e.nativeEvent.selection),
    onFocus,
    onBlur,
    editable,
    ...(plain ? { autoCorrect: false, spellCheck: false, autoCapitalize: "none" as const } : {}),
    testID,
    accessibilityLabel: testID,
    style: { ...font, color: colors.text, maxHeight, minHeight: font.lineHeight * 2, padding: 0, textAlignVertical: "top" },
  };
  return (
    <TextInput ref={ref} {...props}>
      {pieces.map((p, i) => (p.chip ? <Text key={i} style={p.chip === "point" ? styles.point : styles.chip}>{p.text}</Text> : <Text key={i}>{p.text}</Text>))}
    </TextInput>
  );
});
