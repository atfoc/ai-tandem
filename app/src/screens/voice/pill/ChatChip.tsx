// The chat chip of the pill (VC-28, goal 3.6): it names the chat the orb talks to and, opened, lists this board's chats, the ones the
// sidebar shows (`boardChats` with the sidebar's own `showArchived`, from the same store), with a way to show all of them. A pick makes the
// chat the board's last one, the same value the sidebar's selection writes (`lastChat`), so the two never disagree.
import { useReducer, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { dotState } from "@aiwb/core/logic/labels.ts";
import { chatTitle, threadOf } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../../state/useStore.ts";
import { AgentGlyph, agentClass } from "../../../ui/icons.tsx";
import { Menu, MenuEmpty, MenuHead, MenuItem, MenuSep } from "../../../ui/Menu.tsx";
import { Overlay } from "../../../ui/Overlay.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useControlRef } from "../../../ui/useControlRef";
import { webStyle } from "../../../ui/webstyle.ts";
import { PILL_ARCHIVED, PILL_CHATS, PILL_CHIP, PILL_NO_CHAT, PILL_NO_CHATS, PILL_SHOW_ALL, PILL_SHOW_FEWER } from "../../../voice/words.ts";
import { StatusDot } from "../../sidebar/parts.tsx";
import { pickChat, targetNow } from "./control.ts";
import { chipChats, hiddenCount } from "./logic.ts";

/** A chat's title as the sidebar shows it (its name, or its first words). */
export function useTitle(c: ChatView | undefined): string {
  return useStore((s) => (c ? chatTitle(c, threadOf(s, c.id)?.items) : ""));
}

function Glyph({ c }: { c: ChatView }) {
  const t = useTokens();
  const soft = (t as Record<string, string>)[agentClass(c.agent) + "Soft"] ?? "transparent";
  return (
    <View style={[styles.glyph, { backgroundColor: soft }]}>
      <AgentGlyph agent={c.agent} size={11} />
      <StatusDot state={dotState(c)} />
    </View>
  );
}

function ChatItem({ c, picked, onPick }: { c: ChatView; picked: boolean; onPick(): void }) {
  const title = useTitle(c);
  return (
    <MenuItem {...tid("pill-chat", { chat: c.id, archived: c.archived || undefined })} choice selected={picked} disabled={!!c.archived || !!c.instructionsSent}
      label={title} icon={<Glyph c={c} />} trailing={c.archived ? <Text size={10.5} tone="muted">{PILL_ARCHIVED}</Text> : undefined} onPress={onPick} />
  );
}

export function ChatChip({ board }: { board: string }) {
  const t = useTokens();
  const chats = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  useStore((s) => s.sel); // (opening a chat in the sidebar makes it the board's last: the chip follows)
  const [, bump] = useReducer((n: number) => n + 1, 0); // (a pick writes the kv, which the store does not tell)
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const anchor = useRef<View>(null);
  const targetId = targetNow(board);
  const target = targetId ? chats[targetId] : undefined;
  const name = useTitle(target);
  const list = chipChats(chats, board, showArchived, all);
  const more = hiddenCount(chats, board, showArchived);
  const label = target ? name : PILL_NO_CHAT;
  const tip = useControlRef(target ? PILL_CHIP(name) : PILL_NO_CHAT);
  const close = () => { setOpen(false); setAll(false); };
  return (
    <View ref={anchor} collapsable={false} style={styles.wrap}>
      <Pressable {...tid("pill-chip", { chat: targetId ?? "", open })} ref={tip} accessibilityRole="button" accessibilityLabel={target ? PILL_CHIP(name) : PILL_NO_CHAT}
        aria-haspopup="menu" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.chip, { borderColor: t.line2, backgroundColor: hovered ? t.accentSoft : t.bg }, webStyle({ cursor: "pointer" })]}>
        {target ? <Glyph c={target} /> : null}
        <Text {...tid("pill-chip-name")} size={12.5} numberOfLines={1} tone={target ? "text" : "muted"} style={styles.name}>{label}</Text>
        <Text size={9} tone="muted">▾</Text>
      </Pressable>
      {open && (
        <Overlay open onClose={close} label={PILL_CHATS} kind="popover" anchor={anchor} up>
          <Menu label={PILL_CHATS} minWidth={240}>
            <MenuHead>{PILL_CHATS}</MenuHead>
            {list.length === 0 ? <MenuEmpty>{PILL_NO_CHATS}</MenuEmpty> : list.map((c) => (
              <ChatItem key={c.id} c={c} picked={c.id === targetId} onPick={() => { pickChat(board, c.id); bump(); close(); }} />
            ))}
            {(more > 0 || all) && !showArchived && (
              <>
                <MenuSep />
                <MenuItem {...tid("pill-chip-all", { all })} label={all ? PILL_SHOW_FEWER : PILL_SHOW_ALL(more)} onPress={() => setAll(!all)} />
              </>
            )}
          </Menu>
        </Overlay>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexShrink: 1, minWidth: 0 },
  chip: { flexDirection: "row", alignItems: "center", gap: 7, height: 32, paddingLeft: 7, paddingRight: 10, borderRadius: 16, borderWidth: 1, maxWidth: 190 },
  name: { flexShrink: 1, minWidth: 0 },
  glyph: { width: 18, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center", flexShrink: 0 },
});
