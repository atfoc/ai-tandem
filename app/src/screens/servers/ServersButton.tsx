// The sidebar foot's button (the old page's Servers.tsx `ServersButton`): the servers' icon, with a dot while an entry is not connected. It
// opens the dialog (the shell's `Overlays` slot draws it). The sidebar's foot (S1) puts it in its place.
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { openServers } from "@aiwb/core/state/serversdialog.ts";
import { anyNotConnected } from "@aiwb/core/logic/servers.ts";

import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";

const ServersIcon = ({ color }: { color: string }) => (
  <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.5}>
    <Rect x={2} y={2.5} width={12} height={4.5} rx={1} /><Rect x={2} y={9} width={12} height={4.5} rx={1} />
    <Path d="M4.5 4.75h.01M4.5 11.25h.01" strokeLinecap="round" />
  </Svg>
);

export function ServersButton() {
  const { tokens: t } = useTheme();
  const dot = useStore((s) => anyNotConnected(s.servers));
  return (
    <IconButton {...tid("servers-btn", { dot })} title={dot ? "Servers: one is not connected" : "Servers"} onPress={() => openServers()}
      style={[styles.btn, { borderColor: t.line, backgroundColor: t.bg }]}>
      {(c) => (
        <>
          <ServersIcon color={c} />
          {dot ? <View {...tid("servers-dot")} style={[styles.dot, { backgroundColor: t.warn }]} /> : null}
        </>
      )}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  btn: { width: 28, height: 26, borderWidth: 1, borderRadius: 7 },
  dot: { position: "absolute", top: -3, right: -3, width: 7, height: 7, borderRadius: 4 },
});
