// What a hidden sidebar leaves at the window's left edge: a narrow rail with the one control that shows it again, and the control
// in the sidebar's head that hides it (today's `.side-rail`, `.side-show` and `.side-hide` of App.tsx and Sidebar.tsx).
import { StyleSheet, View } from "react-native";

import { sideKeyName, sideNotice } from "@aiwb/core/logic/layout.ts";
import { pageVersion } from "@aiwb/core/state/version.ts";

import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { SideIcon } from "../../ui/icons.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { keyPlatform } from "./keyplatform.ts";
import { SIDE_IDS, setSideHidden } from "./nav.ts";
import { RAIL } from "./widths.ts";

/** The rail: it has a dot (and its label reads "Show sidebar: it has a notice") while this computer's section has something to
 *  say that shows nowhere else: its server is not connected, or runs another build than the app, or a restart runs or failed. */
export function SideRail() {
  const { tokens: t } = useTheme();
  const notice = useStore((s) => sideNotice(s, pageVersion()));
  return (
    <View {...tid(SIDE_IDS.rail)} style={[styles.rail, { backgroundColor: t.panel, borderRightColor: t.line }]}>
      <View>
        <IconButton {...tid(SIDE_IDS.show, { notice })} title={`Show sidebar (${sideKeyName(keyPlatform())})`}
          accessibilityLabel={notice ? "Show sidebar: it has a notice" : "Show sidebar"} onPress={() => setSideHidden(false, true)}>
          {(color) => <SideIcon color={color} />}
        </IconButton>
        {notice && <View {...tid("side-rail-dot")} pointerEvents="none" style={[styles.dot, { backgroundColor: t.warn, borderColor: t.panel }]} />}
      </View>
    </View>
  );
}

/** The sidebar's own control that hides it, for its head (S1 draws the head; this is the control, with its title and its testID). */
export function SideHideButton() {
  return (
    <IconButton {...tid(SIDE_IDS.hide)} keepFocus title={`Hide sidebar (${sideKeyName(keyPlatform())})`} onPress={() => setSideHidden(true, true)}>
      {(color) => <SideIcon color={color} />}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  rail: { width: RAIL, alignItems: "center", paddingTop: 10, borderRightWidth: 1 },
  dot: { position: "absolute", top: 1, right: 1, width: 7, height: 7, borderRadius: 4, borderWidth: 2 },
});
