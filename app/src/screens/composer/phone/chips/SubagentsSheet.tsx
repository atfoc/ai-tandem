// The Subagents picker of a new chat on the phone (ux-improvements goal 3.6, mockup "03 The pickers" co-03c): a sheet titled "Subagents" with the
// chat's name as its sub-line and Done (it holds two controls); "Depth" as a segmented control (Off · 1 level · 2 · 3) with a line saying what
// the chosen depth means; "Running at once" (5 · 10 · 25 · 50 · 100), greyed while depth is Off, with its line. A pick is sent at once (pickSubs)
// and the sheet stays open, as the wide toolbar's SubagentsChip does. Segments are `sub-opt` with dataSet `section`, `value`, `on`.
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { capOff, capOptions, depthNote, depthOptions, pickSubs, subChange, subSettings } from "@aiwb/core/logic/subsettings.ts";
import { getState, shownBranch, upsertChat } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { PHONE, TYPE } from "../../../../ui/metrics.ts";
import { Sheet } from "../../../../ui/Sheet.tsx";
import { SheetHead } from "../../../../ui/SheetHead.tsx";
import { Text } from "../../../../ui/Text.tsx";
import { tid } from "../../../../ui/tid.ts";
import { C2_IDS } from "./ids.ts";
import { Segmented } from "./Segmented.tsx";

export type SubagentsSheetProps = {
  open: boolean;
  onClose(): void;
  c: ChatView;
  /** The chat's name. */
  sub: string;
  /** The composer sends, or another change is being saved: the controls take no pick. */
  disabled: boolean;
  onBusy(busy: boolean): void;
  onError(msg: string): void;
};

/** The depth chips' short labels: "2" and "3" in the control, "2 levels" for a screen reader. */
const shortDepth = (value: number, label: string) => (value >= 2 ? String(value) : label);

export function SubagentsSheet(p: SubagentsSheetProps) {
  const s = subSettings(p.c);
  const off = capOff(s);

  const pick = (section: "depth" | "cap", value: number) => {
    const change = subChange(s, section, value);
    if (!change || p.disabled) return;
    p.onBusy(true);
    void pickSubs((x) => api.configure(p.c.id, shownBranch(getState(), p.c.id), x), change, upsertChat)
      .then(() => p.onError(""), (e) => p.onError(e.message)).finally(() => p.onBusy(false));
  };

  return (
    <Sheet open={p.open} onClose={p.onClose} label="Subagents" testID={C2_IDS.subSheet} detent="fit"
      head={<SheetHead title="Subagents" sub={p.sub} right={{ label: "Done", strong: true, onPress: p.onClose }} />}>
      <View style={styles.body}>
        <Text size={TYPE.secondary} tone="muted" style={styles.label}>Depth</Text>
        <Segmented label="Depth" testID="sub-depth" segmentTestID="sub-opt" segData={{ section: "depth" }} value={s.depth} disabled={p.disabled}
          options={depthOptions(s).map((o) => ({ value: o.value, label: shortDepth(o.value, o.label), accessibilityLabel: o.value >= 2 ? o.label : undefined }))}
          onChange={(v) => pick("depth", v)} />
        <Text {...tid("sub-depth-line")} size={TYPE.secondary} tone="muted" style={styles.line}>{`How deep subagents may start their own. ${depthNote(s.depth)}.`}</Text>

        <Text size={TYPE.secondary} tone="muted" style={[styles.label, styles.second]}>Running at once</Text>
        <Segmented label="Running at once" testID="sub-cap" segmentTestID="sub-opt" segData={{ section: "cap" }} value={s.cap} disabled={p.disabled || off}
          options={capOptions(s).map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => pick("cap", v)} />
        <Text {...tid("sub-cap-line")} size={TYPE.secondary} tone="muted" style={styles.line}>
          {off ? "With depth Off no subagent runs." : "The most subagents of this chat working at the same time."}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: PHONE.margin, paddingTop: 8, paddingBottom: 16 },
  label: { marginBottom: 6 },
  second: { marginTop: 20 },
  line: { marginTop: 8 },
});
