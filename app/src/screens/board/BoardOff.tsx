// A board of a section (a remote server of the server list): what shows in place of its canvas while that server is not
// connected and no scene of it is kept here, or once the board is gone there; and the banner over a canvas whose edit could not
// be saved there yet (the old page's BoardOff.tsx).
import { StyleSheet, View } from "react-native";

import { bannerText, offText, serverNameOf } from "@aiwb/core/logic/boardsave.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import { setState } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { FILL } from "./fill.ts";

/** board: the board's key. */
export function BoardOff({ board, view }: { board: string; view: "unreachable" | "gone" }) {
  const name = useStore((s) => serverNameOf(board, s.servers));
  const t = offText(view, name);
  return (
    <View {...tid("board-off", { view })} style={styles.off}>
      <Text size={18} weight="600" accessibilityRole="header" style={styles.title}>{t.title}</Text>
      <Text tone="muted" style={styles.body}>{t.body}</Text>
      {view === "unreachable" && <Button {...tid("board-off-servers")} label="Servers…" onPress={() => setState({ serversDialog: {} })} />}
    </View>
  );
}

/** Over the canvas, while an edit of the board waits for its server; the canvas stays in use. */
export function SaveBanner({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const on = useStore((s) => !!s.outage[board]);
  const name = useStore((s) => serverNameOf(board, s.servers));
  const connected = useStore((s) => serverConnected(s, serverOfKey(board))); // the edit waits though the server is connected: the board is being taken again there
  const said = useStore((s) => s.saveSaid[board] ?? ""); // a save the server does not take as it is (a drawing over its limit)
  const text = said || (on ? bannerText(name, connected) : "");
  if (!text) return null;
  return (
    <View {...tid("save-banner")} role="status" pointerEvents="none" style={styles.bannerRow}>
      <View style={[styles.banner, { backgroundColor: t.bg, borderColor: t.line }]}>
        <Text size={12} weight="600" tone="warn" numberOfLines={2}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  off: { ...FILL, alignItems: "center", justifyContent: "center", gap: 10, padding: 40 },
  title: { marginTop: 4, textAlign: "center" },
  body: { maxWidth: 380, textAlign: "center", marginBottom: 6 },
  bannerRow: { position: "absolute", top: 58, left: 0, right: 0, alignItems: "center", zIndex: 4 },
  banner: { maxWidth: "92%", paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
});
