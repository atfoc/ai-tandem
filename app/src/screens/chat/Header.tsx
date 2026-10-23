// A chat's header (the old page's ChatView.tsx's ChatHeader): the agent's glyph, the chat's name (a tap renames it) and a line under it: [the
// board ·] the agent · the folder · the server's name (a chat of a section) · the status · the branch crumb. The branch alert and the
// Tree button (S8) stand before the ×; the × hides the panel of a board's chat (wide layouts). On the phone this is the one bar of the
// screen (AD-71): the stack's back first, then the same header, so the chat's title is shown once.
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { agentLabel } from "@aiwb/core/logic/agentlist.ts";
import { inSection, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { statusText } from "@aiwb/core/logic/labels.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { sendOff } from "@aiwb/core/logic/chatserver.ts";
import { headStatus } from "@aiwb/core/logic/status.ts";
import { boardNames, chatTitle, isLegacy, setState, shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { useLayout } from "../../ui/useLayout.ts";
import { useEscLayer } from "../../ui/useEscLayer";
import { IconButton } from "../../ui/IconButton.tsx";
import { AgentGlyph, BoardIcon, Pencil } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { BackButton } from "../shell/BackButton.tsx";
import { reportError } from "../shell/nav.ts";
import { agentColours } from "./colour.ts";
import { useNow } from "../subagents/hooks.ts";
import { tildify, useWhere } from "./hooks.ts";
import { useChatParts } from "./parts.tsx";

/** Renames a chat on its server; the same name, or none, asks nothing. The name shows when the chat's server tells it (a `chat`
 *  event): nothing is shown ahead. A section's server that refuses the rename, or does not answer, is said: no event would. */
export function renameChat(chat: ChatView, name: string, title = chatTitle(chat)): void {
  if (!name || name === title) return;
  void api.renameChat(chat.id, name).catch((e) => { console.error(e); if (inSection(chat.id)) reportError("Couldn't rename the chat", e); });
}

/** The field the name is typed in: the name is selected, Enter or leaving the field commits, Esc cancels. */
export function NameInput({ chat, onDone }: { chat: ChatView; onDone: () => void }) {
  const t = useTokens();
  const items = useStore((s) => threadOf(s, chat.id)?.items);
  const [v, setV] = useState(chatTitle(chat, items));
  const done = useRef(false);
  const box = useRef<TextInput>(null);
  // the name is selected when the field opens (the browser's field and the system's both)
  useEffect(() => {
    const el = box.current as (TextInput & { select?: () => void }) | null;
    el?.focus();
    if (el?.select) el.select(); else el?.setSelection?.(0, v.length);
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    renameChat(chat, v.trim(), chatTitle(chat, items));
    onDone();
  };
  const cancel = () => { done.current = true; onDone(); };
  useEscLayer(true, cancel); // (web: in the order of the overlays, so the subagent drawer opened before the box is not closed by its Esc)
  const key = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (e.nativeEvent.key === "Escape") cancel();
  };
  return (
    <TextInput {...tid("chat-name-input")} ref={box} value={v} onChangeText={setV} autoFocus selectTextOnFocus onBlur={commit} onSubmitEditing={commit} onKeyPress={key}
      returnKeyType="done" accessibilityLabel="Chat name" placeholderTextColor={t.faint}
      style={[styles.nameInput, { color: t.text, backgroundColor: t.bg, borderColor: t.accent }, webStyle({ outlineStyle: "none", boxShadow: `0 0 0 3px ${t.accentSoft}` }) as TextStyle | undefined]} />
  );
}

export function ChatHeader({ chatId }: { chatId: string }) {
  const t = useTokens(), parts = useChatParts(), pointer = usePointer(), layout = useLayout();
  const c = useStore((s) => shownView(s, chatId));
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const board = useStore((s) => (c?.board ? s.boards[c.board] : undefined));
  const server = serverOfKey(chatId);
  const on = useStore((s) => (inSection(chatId) ? serverName(s, server) : "")); // a chat of a section names its server
  const where = useWhere(c);
  const gone = useStore((s) => !!s.gone[chatId]); // it is no longer on its server
  const [editing, setEditing] = useState(false);
  const now = useNow(c?.status === "retrying"); // the time to the next attempt counts down
  if (!c) return null;
  // (a chat whose server is not connected, or no longer has it, is shown as it was: it has no status now, and is not renamed)
  const frozen = sendOff(where) || gone;
  const status = headStatus(c, isLegacy(c), statusText(c, boardNames(chatId), now), frozen);
  const named = !c.archived && !isLegacy(c) && !frozen;
  const a = agentColours(t, c.agent);
  return (
    <View {...tid("chat-head", { chat: chatId, status: status || undefined, frozen })} style={[styles.head, { borderBottomColor: t.line }]}>
      {layout === "phone" && <BackButton />}
      <View style={[styles.glyph, { backgroundColor: a.soft }]}><AgentGlyph agent={c.agent} size={14} /></View>
      <View style={styles.main}>
        {editing && named ? <NameInput chat={c} onDone={() => setEditing(false)} /> : (
          <Pressable {...tid("chat-head-name")} accessibilityRole="button" accessibilityLabel={named ? `Rename ${chatTitle(c, items)}` : chatTitle(c, items)} disabled={!named}
            onPress={() => named && setEditing(true)} style={styles.nameRow}>
            {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
              <>
                <Text numberOfLines={1} size={13.5} weight="600" tone={c.name ? "text" : "muted"} style={[styles.name, !c.name && { fontWeight: "400" }]} dataSet={{ unnamed: !c.name }}>{chatTitle(c, items)}</Text>
                {named && <View style={{ opacity: hovered || pointer === "touch" ? 1 : 0 }}><Pencil color={t.faint} /></View>}
              </>
            )}
          </Pressable>
        )}
        <Text {...tid("chat-head-sub")} numberOfLines={1} size={11.5} tone="muted">
          {c.board ? <><BoardIcon size={12} color={t.accent} /> {board?.name ?? "board"} · </> : null}
          {agentLabel(c.agent)}
          {c.cwd ? <> · <Text mono size={11} tone="muted">{tildify(c.cwd, server)}</Text></> : null}
          {on ? <> · <Text {...tid("chat-head-server")} size={11.5} tone="muted">{on}</Text></> : null}
          {status ? <>{" · "}{status}</> : null}
          <parts.HeaderCrumb chat={chatId} />
        </Text>
      </View>
      <parts.HeaderTail chat={chatId} />
      {c.board && layout !== "phone" && <IconButton {...tid("chat-hide")} title="Hide chat (⌘J)" onPress={() => setState({ panel: false })}>{(color) => <Text size={16} style={{ color }}>×</Text>}</IconButton>}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, paddingHorizontal: 14, borderBottomWidth: 1, minHeight: 52 },
  glyph: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", flex: 0 },
  main: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", alignSelf: "flex-start" },
  name: { flexShrink: 1, minWidth: 0 },
  nameInput: { width: "100%", fontSize: 13, fontWeight: "500", borderWidth: 1, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 5 },
});
