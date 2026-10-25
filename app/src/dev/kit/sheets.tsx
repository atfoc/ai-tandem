// The kit gallery's section "Sheets (detents, head, P1 ActionSheet, menus in a sheet)" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// `kit-open-<case>` opens a case; `kit-sheets-last` says the id of the action pressed last, or "closed".
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { ActionSheet, type ActionItem } from "../../ui/ActionSheet.tsx";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon, ChatIcon, GroupIcon, MoreIcon, Pencil, SpeakerIcon, StopIcon } from "../../ui/icons.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";

type Case = "action" | "action-quick" | "action-tag" | "fit-long" | "fit-short" | "large" | "head-start";
const CASES: Case[] = ["action", "action-quick", "action-tag", "fit-long", "fit-short", "large", "head-start"];
const ICON = 20;

export function Section() {
  const { tokens: t } = useTheme();
  const [shown, setShown] = useState<Case | null>(null);
  const [last, setLast] = useState("closed");
  const close = () => setShown(null);
  const show = (c: Case) => { setLast("closed"); setShown(c); };
  const act = (id: string) => () => setLast(id);
  const item = (id: string, label: string, icon: ReactNode, extra?: Partial<ActionItem>): ActionItem => ({ id, label, icon, onPress: act(id), ...extra });
  const rows = (n: number) => (
    <Menu>{Array.from({ length: n }, (_, i) => <MenuItem key={i} testID="kit-row" label={`Row ${i + 1}`} onPress={() => { setLast(`row-${i + 1}`); close(); }} />)}</Menu>
  );
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        {CASES.map((c) => <Button key={c} size="touch" label={c} testID={`kit-open-${c}`} style={styles.open} onPress={() => show(c)} />)}
      </View>
      <Text testID="kit-sheets-last" tone="muted">{last}</Text>

      <ActionSheet open={shown === "action"} onClose={close}
        head={{ title: "Checkout service", sub: "Group · 3 boards · 6 chats", icon: <GroupIcon size={ICON} color={t.accent} /> }}
        items={[
          item("new-chat", "New chat in this group", <ChatIcon size={ICON} />),
          item("new-board", "New board in this group", <BoardIcon size={ICON} />, { note: "Opens on the board" }),
          item("rename", "Rename…", <Pencil size={ICON} />),
          item("archive", "Archive", <MoreIcon size={ICON} />, { waitReason: "Waits for the agent to stop" }),
        ]}
        destructive={item("delete", "Delete group…", <StopIcon size={ICON} />)} />

      <ActionSheet open={shown === "action-quick"} onClose={close}
        head={{ title: "Message", sub: "Claude · Checkout service", icon: <ChatIcon size={ICON} color={t.accent} /> }}
        quick={[
          item("copy", "Copy", <BoardIcon size={ICON} />),
          item("quote", "Quote", <ChatIcon size={ICON} />),
          item("read", "Read aloud", <SpeakerIcon size={ICON} />),
          item("select", "Select", <Pencil size={ICON} />),
        ]}
        items={[
          item("retry", "Retry", <MoreIcon size={ICON} />),
          item("branch", "Branch from here", <GroupIcon size={ICON} />, { note: "Starts a new chat" }),
          item("share", "Share", <StopIcon size={ICON} />),
        ]} />

      <ActionSheet open={shown === "action-tag"} onClose={close}
        head={{ title: "Add a server", sub: "Run setup-remote.sh on the server first", icon: <GroupIcon size={ICON} color={t.accent} /> }}
        items={[
          item("scan", "Scan QR code", <BoardIcon size={ICON} />, { note: "Point the camera at the code the server shows" }),
          item("paste", "Paste setup text", <ChatIcon size={ICON} />, { note: "What setup-remote.sh printed", tag: "In clipboard" }),
          item("manual", "Enter address manually", <Pencil size={ICON} />, { note: "Name, address and secret, typed" }),
        ]}
        after={[item("help", "How do I set up a server?", <MoreIcon size={ICON} />)]} />

      <Sheet open={shown === "fit-long"} onClose={close} label="Fit, long" detent="fit">{rows(30)}</Sheet>
      <Sheet open={shown === "fit-short"} onClose={close} label="Fit, short" detent="fit">{rows(2)}</Sheet>
      <Sheet open={shown === "large"} onClose={close} label="Large" detent="large"
        head={<SheetHead title="Large sheet" sub="The head stays" left={{ label: "Cancel", onPress: close }} right={{ label: "Save", strong: true, onPress: close }} />}>
        {rows(40)}
      </Sheet>
      <Sheet open={shown === "head-start"} onClose={close} label="Head with a tile" detent="fit"
        head={<SheetHead title="Studio Mac" sub="This computer · connected" right={{ label: "Done", onPress: close }}
          leading={<View testID="kit-head-tile" style={[styles.tile, { borderColor: t.line }]}><GroupIcon size={ICON} /></View>} />}>
        {rows(3)}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  open: { minHeight: PHONE.target, minWidth: PHONE.target },
  tile: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
