// A pane with its width and a resize handle on its right edge (the old page's App.tsx `Pane`, Resizer.tsx): the sidebar, or a board's chat
// panel. The widths themselves are the store's, saved when a drag ends ("aiwb.widths").
import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import type { Pane as PaneKind } from "@aiwb/core/logic/layout.ts";
import { getState, safeSet, setState } from "@aiwb/core/state/store.ts";

import { Resizer } from "../../ui/Resizer.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";

/** Sets a pane's width in the store; `save` (the end of a drag) keeps the widths. */
export function setWidth(pane: PaneKind, w: number, save: boolean): void {
  const widths = { ...getState().widths, [pane]: w };
  if (widths[pane] !== getState().widths[pane]) setState({ widths });
  if (save) safeSet("aiwb.widths", JSON.stringify(widths));
}

export type PaneProps = {
  pane: PaneKind;
  testID: string;
  width: number;
  /** The most the pane may be wide now (the stage keeps its least). */
  room: number;
  /** Not drawn (display none) but kept mounted: a hidden sidebar. */
  hidden?: boolean;
  /** The pane lies over what is beside it (the tablet's sidebar below the width that holds the three). */
  over?: boolean;
  style?: ViewStyle;
  children: ReactNode;
};

export function Pane({ pane, testID, width, room, hidden, over, style, children }: PaneProps) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid(testID, { pane })} style={[styles.pane, { width, backgroundColor: pane === "panel" ? t.bg : t.panel, borderRightColor: t.line }, over && styles.over, over && { boxShadow: t.shadowMd } as ViewStyle, hidden && styles.hidden, style]}>
      {children}
      <Resizer pane={pane} width={width} room={room} onResize={(w, final) => setWidth(pane, w, final)} />
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { flexShrink: 0, flexGrow: 0, minHeight: 0, borderRightWidth: 1 },
  over: { position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 20 },
  hidden: { display: "none" },
});
