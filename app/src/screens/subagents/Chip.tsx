// The Subagents chip of the composer's toolbar and its list (the old page's SubSettings.tsx): a chat's two subagent settings, how many levels of
// subagents it may have (Depth) and how many may run at the same time (Running at once). Both can be changed until the first message, in a
// chat that is neither a fork nor a branch; after that the chip shows them fixed (logic/subsettings.ts subChip). The composer's toolbar
// draws it where `parts.SubagentsChip` is (screens/composer/parts.tsx) and keeps the one open list, which it measures.
//
// A pick is sent at once and the list stays open, so both settings are set in one visit; the answer is the chat with the new values. A press
// outside, Esc (the overlay stack) and the back button close it; it is a popover over the chip on the wide layouts and a sheet on the phone.
import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { capOff, capOptions, depthNote, depthOptions, pickSubs, subChange, subChipLabel, subChipTitle, subSettings, type SubOption } from "@aiwb/core/logic/subsettings.ts";
import { getState, shownBranch, upsertChat } from "@aiwb/core/state/store.ts";

import { Menu, MenuHead, MenuItem, MenuSep } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { Caret, ChipName, TChip, UNTIL_FIRST_MESSAGE, type SubagentsProps } from "../composer/index.ts";

/** fixed: why the settings cannot be changed ("" while they can): the chip is then a static one and opens nothing. disabled: the composer
 *  sends, or another of the toolbar's changes is being saved: the chip opens nothing and the list takes no pick meanwhile. onBusy: a pick is
 *  being saved. */
export function SubagentsChip({ c, fixed, disabled, open, onOpenChange, onBusy, onError }: SubagentsProps) {
  const s = subSettings(c);
  const chip = useRef<View>(null);
  const shown = open && !fixed;


  const label = (
    <>
      <Text size={12} tone="faint" style={styles.pre}>Subagents</Text>
      <ChipName muted={!!fixed}>{subChipLabel(s)}</ChipName>
    </>
  );
  if (fixed) return <TChip kind="subagents" title={subChipTitle(s, fixed)}>{label}</TChip>;

  const pick = (section: "depth" | "cap", value: number) => {
    const change = subChange(s, section, value);
    if (!change || disabled) return;
    onBusy(true);
    void pickSubs((p) => api.configure(c.id, shownBranch(getState(), c.id), p), change, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  const off = capOff(s);
  const row = (section: "depth" | "cap", o: SubOption) => (
    <MenuItem key={o.value} {...tid("sub-opt", { section, value: o.value, on: o.on })} choice selected={o.on} label={o.label} disabled={section === "cap" && off}
      title={section === "depth" ? depthNote(o.value) : undefined} autoFocus={section === "depth" && o.on}
      trailing={o.on ? <Text>✓</Text> : undefined} onPress={() => pick(section, o.value)} />
  );
  return (
    <>
      <TChip kind="subagents" title={subChipTitle(s, UNTIL_FIRST_MESSAGE)} chipRef={chip} disabled={disabled} expanded={open} popup="dialog" onPress={() => { if (!disabled) onOpenChange(!open); }}>
        {label}<Caret />
      </TChip>
      <Overlay open={open} onClose={() => onOpenChange(false)} label="Subagents" kind="popover" anchor={chip} up testID="sub-pop">
        <Menu label="Subagents" minWidth={180} testID="sub-menu">
          <MenuHead>Depth</MenuHead>
          <View {...tid("sub-depth")} role="radiogroup" aria-label="Depth">{depthOptions(s).map((o) => row("depth", o))}</View>
          <MenuSep />
          <CapSection off={off}>
            <MenuHead>Running at once</MenuHead>
            <View {...tid("sub-cap")} role="radiogroup" aria-label="Running at once" aria-disabled={off || undefined}>{capOptions(s).map((o) => row("cap", o))}</View>
          </CapSection>
        </Menu>
      </Overlay>
    </>
  );
}

/** The "Running at once" section; with depth Off it is greyed and says why on hover. */
function CapSection({ off, children }: { off: boolean; children: ReactNode }) {
  const tip = useControlRef(off ? "With depth Off no subagent runs" : undefined);
  return <View ref={tip} {...tid("sub-pop-cap", { off })} style={off ? styles.off : undefined}>{children}</View>;
}

const styles = StyleSheet.create({
  pre: { marginRight: 2 },
  off: { opacity: 0.5 },
});
