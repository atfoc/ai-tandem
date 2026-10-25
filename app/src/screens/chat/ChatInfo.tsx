// Chat info (ux-improvements goal 3.5, package T3): the phone's one sheet of a chat's facts and actions, opened from the header's title and
// its ⋯. A SheetHead (the agent's tile, the chat's name, "Chat info · started today at 09:12") over three groups of cells: the chat's own
// settings (name, agent · model · effort, folder or board, server), the Context and the Chat tree, and Archive and Delete. A row that opens
// something else closes this sheet first (one sheet at a time, goal 3.1.4). The rows that call the chat's server are faded, with the reason
// and what to do, while that server cannot be asked (infomodel.ts). The host is mounted once in the shell's `Overlays` slot and shows itself
// while a chat is set; the wide layouts never open it.
import { type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { agentLabel, catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { serverWord } from "@aiwb/core/logic/statewords.ts";
import { openTree } from "@aiwb/core/state/actions.ts";
import { branchCount, chatTitle, isLegacy, shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { copyText } from "../../platform/clipboard";
import { useStore } from "../../state/useStore.ts";
import { CellGroup, Cell } from "../../ui/Cells.tsx";
import { AgentGlyph, BranchIcon, DisclosureChevron, Pencil } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { StateWord, toneOf, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/toaststore.ts";
import { archiveChat, deleteChat, unarchiveChat } from "../sidebar/actions.ts";
import { subline } from "../composer/model.ts";
import { contextOf, ringOf } from "../usage/meter.ts";
import { openUsage } from "../usage/open.ts";
import { agentColours } from "./colour.ts";
import { closeChatInfo, useChatInfoOpen } from "./chatinfo.ts";
import { useWhere } from "./hooks.ts";
import { T3_INFO_TID } from "./infoids.ts";
import { branchesWord, contextValue, infoRules, infoSub, LOCK_NOTE } from "./infomodel.ts";
import { renameFromInfo, serverFromInfo } from "./infoseams.ts";

/** The host: nothing until Chat info is opened for a chat that is in the store. */
export function ChatInfoHost() {
  const chat = useChatInfoOpen();
  const present = useStore((s) => !!chat && !!s.chats[chat]);
  if (!chat || !present) return null;
  return <Info key={chat} chat={chat} />;
}

function Info({ chat }: { chat: string }) {
  const t = useTokens();
  const real = useStore((s) => s.chats[chat]) as ChatView;
  const c = useStore((s) => shownView(s, chat)) ?? real;
  const items = useStore((s) => threadOf(s, chat)?.items);
  const where = useWhere({ id: chat });
  const gone = useStore((s) => !!s.gone[chat]);
  const server = serverOfKey(chat);
  const cat = useStore((s) => catalogFor(s, server, c.agent));
  const board = useStore((s) => (c.board ? s.boards[c.board]?.name : undefined));
  const entry = useStore((s) => s.servers.find((v) => v.id === server));
  const word = useServerWord(entry ?? { state: "unreachable" });
  const rules = infoRules({ archived: !!real.archived, legacy: isLegacy(real), gone, connected: where.connected, server: where.name });
  const title = chatTitle(c, items);
  const a = agentColours(t, c.agent);
  const used = contextOf(c, cat);
  const ring = ringOf(used.used, used.win);
  const locked = c.locked;
  const then = (run: () => void) => () => { closeChatInfo(); run(); };

  const copy = () => {
    // the toast says what happened: a browser may refuse the clipboard (no permission), and then nothing was copied
    copyText(c.cwd).then(() => showToast({ text: "Folder path copied", kind: "copied" }), (e) => { console.error(e); showToast({ text: "Couldn't copy", kind: "copy-failed" }); });
  };

  return (
    <Sheet open onClose={closeChatInfo} label="Chat info" testID={T3_INFO_TID.sheet}
      head={(
        <SheetHead title={title} sub={infoSub(real.created)}
          leading={<View style={[styles.tile, { backgroundColor: a.soft }]}><AgentGlyph agent={c.agent} size={14} /></View>} />
      )}>
      <View {...tid(T3_INFO_TID.sheet + "-body", { chat })} style={styles.body}>
        <CellGroup footer={locked ? LOCK_NOTE : undefined}>
          <InfoRow label="Name" row="name" disabled={rules.rename.disabled} why={rules.rename.why}
            trailing={(
              <Pressable {...tid(T3_INFO_TID.rename)} accessibilityRole="button" accessibilityLabel="Rename chat" disabled={rules.rename.disabled}
                accessibilityState={{ disabled: rules.rename.disabled }} onPress={() => renameFromInfo(real)} style={[styles.end, rules.rename.disabled && styles.off]}>
                <Pencil size={14} color={t.accent} />
                <Text size={TYPE.control} tone="accent">Rename</Text>
              </Pressable>
            )}>
            <Text size={TYPE.control}>{title}</Text>
          </InfoRow>
          <InfoRow label="Agent · model · effort" row="agent"
            trailing={locked ? <Text size={TYPE.secondary} tone="muted">Locked</Text> : undefined}>
            <Text size={TYPE.control}>{[agentLabel(c.agent), subline(c, cat).trim()].filter(Boolean).join(" · ")}</Text>
          </InfoRow>
          {c.board ? (
            <InfoRow label="Board" row="folder"><Text size={TYPE.control}>{board ?? c.board}</Text></InfoRow>
          ) : (
            <InfoRow label="Folder" row="folder"
              trailing={(
                <Pressable {...tid(T3_INFO_TID.copy)} accessibilityRole="button" accessibilityLabel="Copy folder path" onPress={copy} style={styles.end}>
                  <Text size={TYPE.control} tone="accent">Copy</Text>
                </Pressable>
              )}>
              <Text size={TYPE.secondary + 1} mono>{breakAtSlashes(c.cwd)}</Text>
            </InfoRow>
          )}
          <InfoRow label="Server" row="server" last onPress={() => serverFromInfo(server)}>
            <View style={styles.serverLine}>
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: toneOf(t, word.tone) }]} />
              <Text size={TYPE.control} numberOfLines={1} style={styles.serverName}>{where.name}</Text>
              <Text size={TYPE.control} tone="muted"> · </Text>
              <StateWord word={word} dot={false} size={TYPE.control} />
            </View>
          </InfoRow>
        </CellGroup>

        <CellGroup>
          <Cell testID={T3_INFO_TID.row} data={{ row: "context" }} label="Context" value={contextValue(used)} onPress={then(() => openUsage(chat))}
            leading={(
              <Svg width={18} height={18} viewBox="0 0 18 18">
                <Circle cx={9} cy={9} r={7} fill="none" stroke={t.line2} strokeWidth={2} />
                <Circle cx={9} cy={9} r={7} fill="none" stroke={ring.tone === "danger" ? t.danger : ring.tone === "warn" ? t.warn : t.accent} strokeWidth={2} strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 7 * ring.pct} ${2 * Math.PI * 7}`} rotation={-90} origin="9, 9" />
              </Svg>
            )} />
          <Cell testID={T3_INFO_TID.row} data={{ row: "tree" }} label="Chat tree" value={branchesWord(branchCount(real))} onPress={then(() => openTree(chat))}
            leading={<BranchIcon size={18} color={t.muted} />} />
        </CellGroup>

        <CellGroup>
          <Cell testID={T3_INFO_TID.row} data={{ row: real.archived ? "unarchive" : "archive", ...(rules.archive.disabled ? { disabled: "true" } : {}) }}
            label={real.archived ? "Unarchive" : "Archive"} sub={rules.archive.why || undefined} disabled={rules.archive.disabled} chevron={false}
            onPress={then(() => (real.archived ? unarchiveChat(real) : archiveChat(real)))}
            leading={<Text size={TYPE.control} tone="muted" style={styles.glyph}>▤</Text>} />
          <Cell testID={T3_INFO_TID.row} data={{ row: "delete", ...(rules.delete.disabled ? { disabled: "true" } : {}) }} tone="danger" label="Delete chat…"
            sub={rules.delete.why || undefined} disabled={rules.delete.disabled} chevron={false} onPress={then(() => deleteChat(real))}
            leading={<Text size={TYPE.control} tone="danger" style={styles.glyph}>✕</Text>} />
        </CellGroup>
      </View>
    </Sheet>
  );
}

/** A cell with its label over its value (the settings' look: "Name" over the chat's name), where the kit's Cell has the label over a
 *  second line. `trailing` is a live control at the end (Rename, Copy); `onPress` makes the whole row push, with a chevron. */
function InfoRow({ label, row, children, trailing, onPress, last, disabled, why }: {
  label: string; row: string; children: ReactNode; trailing?: ReactNode; onPress?: () => void; last?: boolean; disabled?: boolean; why?: string;
}) {
  const t = useTokens();
  const data = { row, ...(disabled ? { disabled: "true" } : {}) };
  const body = (
    <>
      <View style={styles.words}>
        <Text size={TYPE.secondary} tone="muted">{label}</Text>
        <View style={disabled && styles.off}>{children}</View>
        {why ? <Text size={TYPE.secondary} tone="muted">{why}</Text> : null}
      </View>
      {trailing}
      {onPress ? <DisclosureChevron color={t.faint} /> : null}
      {last ? null : <View pointerEvents="none" style={[styles.separator, { backgroundColor: t.line }]} />}
    </>
  );
  if (!onPress) return <View {...tid(T3_INFO_TID.row, data)} style={styles.row}>{body}</View>;
  return (
    <Pressable {...tid(T3_INFO_TID.row, data)} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.row, pressed && { backgroundColor: t.hover2 }]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // the sheet's own side padding is 8 and the groups bring 16: the cards sit 16 from the screen's edge, as the head's words do
  body: { marginHorizontal: -8, paddingTop: 12 },
  tile: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  row: { minHeight: PHONE.cell + 4, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  words: { flex: 1, minWidth: 0 },
  end: { minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 6 },
  off: { opacity: 0.5 },
  separator: { position: "absolute", left: PHONE.margin, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  serverLine: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  serverName: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  glyph: { width: 22, textAlign: "center" },
});

/** A path that wraps after its separators rather than inside a name: a zero-width space after each "/" or "\\" (only drawn; Copy copies the path as it is). */
const breakAtSlashes = (path: string): string => path.replace(/([\\/])/g, "$1\u200b");
