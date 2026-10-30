// The key row over the soft keyboard (iOS and Android): Outdent and Indent for a composer box that edits like code (Settings > Composer,
// core logic/indent.ts), since the soft keyboard has no Tab. Composer.tsx shows it right under the box while the box has the focus and the
// soft keyboard is up, so that with KeyboardLift lifting the composer it is the row just above the keys; a hardware keyboard keeps the soft
// one down (Android) and has its own Tab (ChipInput.native.tsx, the keys port). A press neither takes the focus nor moves the selection:
// a Pressable does not take the focus on native, and the thread lists keep taps for their children (StickyList's keyboardShouldPersistTaps).
import { StyleSheet, View } from "react-native";

import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { tid } from "../../ui/tid.ts";
import { IndentIcon, OutdentIcon } from "./phone/icons.tsx";

export const EDIT_KEYS_IDS = { row: "composer-editkeys", outdent: "composer-outdent", indent: "composer-indent" } as const;

/** `onIndent(false)`: Tab at the box's caret or over its selection; `onIndent(true)`: Shift+Tab. */
export function EditKeys({ onIndent }: { onIndent(outdent: boolean): void }) {
  return (
    <View {...tid(EDIT_KEYS_IDS.row)} style={styles.row}>
      <IconButton {...tid(EDIT_KEYS_IDS.outdent)} size="touch" title="Outdent" keepFocus onPress={() => onIndent(true)}>
        {(color: string) => <OutdentIcon color={color} />}
      </IconButton>
      <IconButton {...tid(EDIT_KEYS_IDS.indent)} size="touch" title="Indent" keepFocus onPress={() => onIndent(false)}>
        {(color: string) => <IndentIcon color={color} />}
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 4, height: PHONE.target, marginTop: 4 },
});
