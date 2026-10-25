// The kit gallery's section "P5 Cells and the bars" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { ContentBar, LargeTitle, PlaceBar } from "../../ui/Bars.tsx";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { BoardIcon, MoreIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";

const LONG_TITLE = "Fix the flaky cart test in the checkout service before Friday";

/** A stand-in for the back control F2 wires: a 44 pt target with words. */
function Back({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable testID="kit-place-back" accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.back}>
      <Text size={TYPE.control} tone="accent">{label}</Text>
    </Pressable>
  );
}

/** A 44 × 44 action with an icon. */
function Action({ label, id, onPress, children }: { label: string; id: string; onPress(): void; children: ReactNode }) {
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.action}>{children}</Pressable>;
}

export function Section() {
  const t = useTokens();
  const [last, setLast] = useState("");
  const press = (what: string) => () => setLast(what);
  return (
    <View style={styles.stack}>
      <View style={[styles.page, { backgroundColor: t.panel }]}>
        <CellGroup title="Servers">
          <Cell label="Servers" sub="3 connected · 1 paused" subTone="warn" onPress={press("servers")} data={{ row: "servers" }} />
          <Cell label="Prompt library" value="9 prompts" onPress={press("library")} data={{ row: "library" }} />
          <Cell label="Archived" value="4" onPress={press("archived")} data={{ row: "archived" }} />
        </CellGroup>
        <CellGroup footer="Removing a server keeps its chats on this phone.">
          <Cell label="Version" value="1.8.2" data={{ row: "version" }} />
          <Cell label="Remove server" tone="danger" onPress={press("remove")} data={{ row: "remove" }} />
        </CellGroup>
      </View>
      <View testID="kit-placebar">
        <PlaceBar back={<Back label="‹ Home" onPress={press("place-back")} />} title="Settings" />
      </View>
      <View testID="kit-contentbar" style={styles.narrow}>
        <ContentBar back={<Back label="‹" onPress={press("content-back")} />} title={LONG_TITLE} sub="Needs your approval" subTone="warn"
          actions={<>
            <Action id="kit-action-board" label="Board" onPress={press("action-board")}><BoardIcon color={t.muted} /></Action>
            <Action id="kit-action-more" label="More" onPress={press("action-more")}><MoreIcon color={t.muted} /></Action>
          </>} />
      </View>
      <View testID="kit-largetitle"><LargeTitle title="Home" sub="Studio Mac · Connected" /></View>
      <Text testID="kit-cells-last" tone="muted">{last}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  narrow: { maxWidth: 360 },
  page: { paddingTop: 16 },
  back: { minWidth: PHONE.target, minHeight: PHONE.target, justifyContent: "center", paddingHorizontal: 8 },
  action: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" },
});
