// The Subagents picker of a new chat on the phone (ux-improvements goal 3.6, mockup "03 The pickers" co-03c): a sheet titled "Subagents" with the
// chat's name as its sub-line and Done (it holds two controls); "Depth" as a segmented control (Off · 1 level · 2 · 3) with a line saying what
// the chosen depth means; "Running at once" as a slider from 1 to 100 (`sub-cap`, ui/Slider.tsx), greyed while depth is Off, with its line.
// A pick is sent at once (pickSubs) and the sheet stays open, as the wide toolbar's SubagentsChip does; the slider sends one call per commit
// (subagents/useCapSave.ts). The depth segments are `sub-opt` with dataSet `section`, `value`, `on`.
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { SUB_CAP_MAX, SUB_CAP_MIN, capOff, depthNote, depthOptions, pickSubs, subChange, subSettings } from "@aiwb/core/logic/subsettings.ts";
import { getState, shownBranch, upsertChat } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { PHONE, TYPE } from "../../../../ui/metrics.ts";
import { Sheet } from "../../../../ui/Sheet.tsx";
import { SheetHead } from "../../../../ui/SheetHead.tsx";
import { Slider } from "../../../../ui/Slider.tsx";
import { Text } from "../../../../ui/Text.tsx";
import { tid } from "../../../../ui/tid.ts";
import { useCapSave } from "../../../subagents/useCapSave.ts";
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
  const cap = useCapSave(p);

  const pickDepth = (value: number) => {
    const change = subChange(s, "depth", value);
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
          onChange={pickDepth} />
        <Text {...tid("sub-depth-line")} size={TYPE.secondary} tone="muted" style={styles.line}>{`How deep subagents may start their own. ${depthNote(s.depth)}.`}</Text>

        <Text size={TYPE.secondary} tone="muted" style={[styles.label, styles.second]}>Running at once</Text>
        <Slider size="touch" testID="sub-cap" label="Running at once" min={SUB_CAP_MIN} max={SUB_CAP_MAX} step={1} value={cap.value} format={String}
          disabled={off} onCommit={cap.commit} />
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
