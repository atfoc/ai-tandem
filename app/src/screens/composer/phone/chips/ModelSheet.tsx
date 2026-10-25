// The Model and effort picker of a new chat on the phone (ux-improvements goal 3.6, mockup "03 The pickers" co-03a, caption co-03e): one P2 sheet
// (ui/PickerSheet.tsx) titled "Model and effort", sub-line "<chat's name> · <agent>", Done at the right (it holds two controls); 50-pt rows with
// the model's name and a second line of its note and its context size ("Most capable · 200k context"); with several providers (pi) the rows fall
// under headings, with one there are none; under the list "Effort" as a segmented control (Segmented.tsx) and one line on what effort costs. A
// model with no efforts has no effort control. A pick is the caller's (ChipRow: a session's PATCH, a fork's restart or a pending move's choice).
import { StyleSheet, View } from "react-native";

import type { Catalog, ChatView } from "@aiwb/core/types.ts";
import type { Choice } from "@aiwb/core/logic/models.ts";

import { TYPE } from "../../../../ui/metrics.ts";
import { PickerSheet } from "../../../../ui/PickerSheet.tsx";
import { Text } from "../../../../ui/Text.tsx";
import { tid } from "../../../../ui/tid.ts";
import { effortLabel, modelOf } from "../../model.ts";
import { C2_IDS } from "./ids.ts";
import { modelRows } from "./modelrows.ts";
import { Segmented } from "./Segmented.tsx";

export type ModelSheetProps = {
  open: boolean;
  onClose(): void;
  c: ChatView;
  /** "<chat's name> · <agent's name>". */
  sub: string;
  cat: Catalog;
  /** The model and effort shown (a pending move's choice, or the chat's). */
  value: Choice;
  onPickModel(id: string): void;
  onPickEffort(id: string): void;
  /** Why no pick is taken now ("" when one is): a change is being saved, the message is on its way. Rows and segments are off. */
  held: string;
};

export function ModelSheet(p: ModelSheetProps) {
  const m = modelOf(p.value, p.cat);
  const held = !!p.held;
  const extra = m?.efforts?.length ? (
    <View style={styles.extra}>
      {held ? <Text size={TYPE.secondary} tone="muted" style={styles.held}>{p.held}</Text> : null}
      <Text size={TYPE.secondary} tone="muted" style={styles.label}>Effort</Text>
      <Segmented label="Effort" testID={C2_IDS.effort} disabled={held} value={p.value.effort ?? null} onChange={p.onPickEffort}
        options={m.efforts.map((e) => ({ value: e, label: effortLabel(e, m) }))} />
      <Text {...tid(C2_IDS.effortLine)} size={TYPE.secondary} tone="muted" style={styles.line}>More effort thinks longer and uses more of your plan.</Text>
    </View>
  ) : p.cat.models.some((x) => x.efforts?.length) ? (
    // (another model of the list has efforts: the sheet keeps its Done, so a pick of this one does not leave it with no way to close)
    <View style={styles.extra}>
      <Text {...tid(C2_IDS.effortLine)} size={TYPE.secondary} tone="muted" style={styles.line}>This model has no effort setting.</Text>
    </View>
  ) : undefined;
  return (
    <PickerSheet open={p.open} onClose={p.onClose} title="Model and effort" sub={p.sub} options={modelRows(p.cat.models)} value={p.value.model}
      onPick={(id) => { if (!held && id !== p.value.model) p.onPickModel(id); }} extra={extra} searchPlaceholder="Search models" testID={C2_IDS.modelSheet} />
  );
}

const styles = StyleSheet.create({
  extra: { gap: 0 },
  held: { marginBottom: 8 },
  label: { marginBottom: 8 },
  line: { marginTop: 10 },
});
