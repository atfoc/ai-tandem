// The board's Chats sheet on the phone (package B1, plans/ux-improvements/b1-design.md §4, goal 3.4): the board's only chooser of a chat.
// The bar's Chats button and the voice card's "To:" open it (chatssheet.ts); it lists "New chat on this board" first, then the chats of the
// board with the one voice talks to marked "Voice"; a press closes the sheet and opens that chat (or the new one) full screen over the board.
// No Cancel row: the grabber, a tap outside, a swipe down and Android's back close it. It draws nothing on the wide layouts, which keep
// their sidebar and panel. It is in the shell's `Overlays` slot (index.ts).
import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { lastChat, threadOf } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, DisclosureChevron } from "../../ui/icons.tsx";
import { Menu, MenuItem, MenuSep } from "../../ui/Menu.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { newChat, select } from "../shell/nav.ts";
import { canStartChat, chatsCount, chatsRows, chatsTitle, NEW_CHAT_LABEL, NEW_CHAT_NOTE } from "./chatsrows.ts";
import { closeChatsSheet, openChatsSheet, useChatsSheet } from "./chatssheet.ts";
import { B1_TID } from "./ids.ts";

const TILE = 28; // the accent tile of "New chat on this board"
const GLYPH = 20;

// A development seam of the browser checks (version "uicheck" only, like BoardCanvas's `__aiwbView`): opens the sheet where the bar's button is not.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") (window as unknown as { __aiwbChatsSheet?: (b: string) => void }).__aiwbChatsSheet = openChatsSheet;

export function ChatsSheet() {
  const board = useChatsSheet();
  const phone = usePhone();
  const exists = useStore((s) => (board ? !!s.boards[board] : false));
  const shown = useStore((s) => s.sel.board);
  const leaves = !!board && (!exists || shown !== board);
  useEffect(() => { if (leaves) closeChatsSheet(); }, [leaves]);
  if (!board || !phone || !exists || leaves) return null;
  return <Body board={board} />;
}

function Body({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const s = useStore((x) => x);
  const name = s.boards[board]?.name ?? "";
  const rows = useMemo(() => chatsRows(s, board, {
    last: lastChat.read()[board], open: s.sel.chat,
    title: (c) => chatTitle(c, threadOf(s, c.id)?.items),
    model: (c) => catalogFor(s, serverOf(c), c.agent)?.models.find((m) => m.id === c.model)?.label ?? c.model,
  }), [s, board]);
  const fresh = canStartChat(s, board);
  const start = () => { closeChatsSheet(); void newChat({ board }); };
  const label = chatsTitle(name);
  return (
    <Sheet open onClose={closeChatsSheet} label={label} testID={B1_TID.sheet} detent="fit"
      head={<SheetHead title={label} sub={chatsCount(rows.length)} />}>
      <Menu label={label}>
        {fresh ? (
          <>
            <MenuItem testID={B1_TID.sheetNew} label={NEW_CHAT_LABEL} accessibilityLabel={`${NEW_CHAT_LABEL}. ${NEW_CHAT_NOTE}`} onPress={start}
              icon={<View style={[styles.tile, { backgroundColor: t.accentSoft }]}><Text size={TYPE.h2} weight="500" tone="accent" style={styles.plus} accessibilityElementsHidden>+</Text></View>}>
              <Text size={TYPE.control} tone="accent" numberOfLines={2}>{NEW_CHAT_LABEL}</Text>
              <Text size={TYPE.secondary} tone="muted" style={styles.note}>{NEW_CHAT_NOTE}</Text>
            </MenuItem>
            {rows.length ? <MenuSep /> : null}
          </>
        ) : null}
        {rows.map((r) => (
          <MenuItem key={r.id} {...tid(B1_TID.sheetRow, { chat: r.id, voice: r.voice ? "1" : "0" })} accessibilityLabel={r.label}
            selected={r.open} accessibilityState={{ selected: r.open }}
            icon={<AgentGlyph agent={r.chat.agent} size={GLYPH} />}
            trailing={<View style={styles.trail}>
              {r.voice ? <View style={[styles.badge, { backgroundColor: t.accentFill }]}><Text size={TYPE.secondary} weight="600" tone="onAccent" numberOfLines={1}>Voice</Text></View> : null}
              <DisclosureChevron color={t.muted} />
            </View>}
            onPress={() => { closeChatsSheet(); select({ board, chat: r.id }); }}>
            <Text size={TYPE.control} numberOfLines={2}>{r.title}</Text>
            <Text size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.note}>{r.line}</Text>
          </MenuItem>
        ))}
      </Menu>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tile: { width: TILE, height: TILE, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  plus: { textAlign: "center" },
  note: { marginTop: 1 },
  trail: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: PHONE.sheetRow - 16 },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
});
