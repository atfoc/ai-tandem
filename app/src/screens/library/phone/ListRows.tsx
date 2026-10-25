// The rows of the library's phone lists (package S4, goal 3.8.6): a 60 pt row (`PHONE.listRow`) in a card, the look of the kit's `Cell`
// (the same card, the hairline separator inset to where the words begin and left out after the last row, the chevron, `hover2` while
// pressed) but taller, with a tile, a 17 pt name and a 13 pt line under it. A tap opens, a long press (500 ms) answers with a haptic and
// opens the row's sheet. `RowGroup` is the card with its caps title (a server's name); `NoticeRow` is a server's one notice.
import { Children, createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { libraryApi } from "@aiwb/core/libraryapi.ts";
import type { GroupNode } from "@aiwb/core/logic/libraryview.ts";
import { textLine } from "@aiwb/core/logic/libraryview.ts";
import type { LibraryPrompt } from "@aiwb/core/logic/library.ts";

import { haptic } from "../../../platform/haptics";
import { ActionSheet, type ActionItem, type ActionSheetProps } from "../../../ui/ActionSheet.tsx";
import { ConfirmSheet } from "../../../ui/ConfirmSheet.tsx";
import { DisclosureChevron } from "../../../ui/icons.tsx";
import { LONG_PRESS_MS, PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { TID, tid } from "../../../ui/tid.ts";
import { SwipeRow, type SwipeAction } from "../../../ui/SwipeRow.tsx";
import { pushScreen } from "../../shell/screens.ts";
import { useLibraries } from "../useLibraries.ts";
import { BinGlyph, DocGlyph, FolderGlyph, FolderHeadIcon, FolderTile, MoveGlyph, PencilGlyph, PromptHeadIcon, PromptTile } from "./icons.tsx";
import { S4_TID } from "./ids.ts";
import { countLine, deleteGroupSheet, deletePromptSheet, groupSub, heldBy, offReason, promptLineText, promptSub } from "./listlogic.ts";
import { openEditor, openGroupForm, openMove } from "./sheets.ts";

/** Whether the row being drawn is followed by another in its card: the card tells each row, so the last has no separator. */
const Followed = createContext(false);

/** A card of rows with an optional caps title above it: the kit's CellGroup, with a dataSet for the checks. */
export function RowGroup({ title, notice, children, testID, data }: { title?: string; notice?: ReactNode; children: ReactNode; testID: string; data?: Record<string, string> }) {
  const t = useTokens(), rows = Children.toArray(children);
  return (
    <View {...tid(testID, data)} style={styles.group}>
      {title ? <Text size={TYPE.secondary} tone="muted" style={styles.caps} accessibilityRole="header">{title}</Text> : null}
      {notice}
      <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
        {rows.map((r, i) => <Followed.Provider key={i} value={i < rows.length - 1}>{r}</Followed.Provider>)}
      </View>
    </View>
  );
}

export type ListRowProps = {
  tile: ReactNode;
  name: string;
  /** The line under the name, 13 pt muted. */
  sub: string;
  /** The line's testID (a hit's path). */
  subTestID?: string;
  /** Spoken in place of "name, sub" (a row says what its long press and swipe do). */
  label?: string;
  chevron?: boolean;
  onPress(): void;
  onLongPress?(): void;
  testID: string;
  data?: Record<string, string>;
};

export function ListRow({ tile, name, sub, subTestID, label, chevron = true, onPress, onLongPress, testID, data }: ListRowProps) {
  const t = useTokens(), followed = useContext(Followed);
  const [wordsX, setWordsX] = useState<number>(PHONE.margin);
  return (
    <Pressable {...tid(testID, data)} onPress={onPress} accessibilityRole="button" accessibilityLabel={label ?? `${name}, ${sub}`}
      delayLongPress={LONG_PRESS_MS} onLongPress={onLongPress ? () => { haptic("select"); onLongPress(); } : undefined}
      style={({ pressed }: { pressed: boolean }) => [styles.row, { backgroundColor: pressed ? t.hover2 : t.bg }]}>
      {tile}
      <View onLayout={(e) => setWordsX(e.nativeEvent.layout.x)} style={styles.words}>
        <Text size={TYPE.control} numberOfLines={1}>{name}</Text>
        <Text {...(subTestID ? { testID: subTestID } : {})} size={TYPE.secondary} tone="muted" numberOfLines={1}>{sub}</Text>
      </View>
      {chevron ? <DisclosureChevron color={t.faint} /> : null}
      {followed ? <View {...tid(TID.cellSeparator)} pointerEvents="none" style={[styles.separator, { left: wordsX, backgroundColor: t.line }]} /> : null}
    </Pressable>
  );
}

/** The one notice of a server that is not connected, at the top of its section (the rows below still open, read-only). */
export function NoticeRow({ text, testID, data }: { text: string; testID: string; data?: Record<string, string> }) {
  const t = useTokens();
  return (
    <View {...tid(testID, data)} accessibilityRole="alert" style={[styles.notice, { backgroundColor: t.warnSoft, borderColor: t.warn }]}>
      <Text size={TYPE.secondary} style={{ color: t.warnText }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6, marginHorizontal: PHONE.margin, marginBottom: 20 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  row: { minHeight: PHONE.listRow, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  words: { flex: 1, minWidth: 0 },
  empty: { minHeight: PHONE.listRow, justifyContent: "center", paddingHorizontal: PHONE.margin },
  separator: { position: "absolute", right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  notice: { padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
});

/** A row of a card that says a fact and does nothing ("Empty", "No prompts here yet"). */
export function EmptyRow({ text, testID, data }: { text: string; testID?: string; data?: Record<string, string> }) {
  return (
    <View {...(testID ? tid(testID, data) : {})} style={styles.empty}>
      <Text size={TYPE.control} tone="muted">{text}</Text>
    </View>
  );
}

// ---- what a row does: its swipe, its P1 and the delete question (shared by the Library screen, a group's screen and the bar's "…")

/** A prompt or a group of one library. */
export type ItemRef = { kind: "prompt" | "group"; server: string; id: string };

type Delete = { ref: ItemRef; title: string; body: string; confirmLabel: string };

/** The sheets a row opens, and the way to open them: `node` is drawn once by the screen (or the bar's button) that calls this. A prompt's
 *  P1 (Edit prompt, Move prompt…, Delete prompt…) or a group's (New prompt here, New group here, Rename group…, Move group…, Delete group…); both
 *  have the change rows wait with "<server> is not connected" when the library is away. The delete is a P4 whose button calls the library's API;
 *  a throw is shown inside it. */
export function useRowSheets(): { node: ReactNode; openSheet(ref: ItemRef): void; askDelete(ref: ItemRef): void; swipeFor(ref: ItemRef): SwipeAction[] | undefined } {
  const libs = useLibraries();
  const [sheet, setSheet] = useState<{ ref: ItemRef; open: boolean } | null>(null);
  const [del, setDel] = useState<{ d: Delete; open: boolean } | null>(null);
  const libOf = (server: string) => libs.find((l) => l.server === server);

  const askDelete = (ref: ItemRef) => {
    const v = libOf(ref.server), p = v?.prompts.find((x) => x.id === ref.id), g = v?.groups.find((x) => x.id === ref.id);
    if (!v || !(ref.kind === "prompt" ? p : g) || !v.connected) return;
    setDel({ d: { ref, ...(ref.kind === "prompt" ? deletePromptSheet(p!.name, v.name) : deleteGroupSheet(v, ref.id)) }, open: true });
  };
  const openSheet = (ref: ItemRef) => setSheet({ ref, open: true });
  const swipeFor = (ref: ItemRef): SwipeAction[] | undefined => {
    if (!libOf(ref.server)?.connected) return undefined;
    return [
      { id: "move", label: "Move", tone: "grey", onPress: () => openMove(ref) },
      { id: "delete", label: "Delete", tone: "danger", onPress: () => askDelete(ref) },
    ];
  };

  const items = (): { head: ActionSheetProps["head"]; items: ActionItem[]; destructive: ActionItem } | null => {
    if (!sheet) return null;
    const { ref } = sheet, v = libOf(ref.server);
    if (!v) return null;
    const wait = offReason(v) || undefined;
    const row = (id: string, label: string, icon: ReactNode, onPress: () => void): ActionItem => ({ id, label, icon, waitReason: wait, onPress });
    if (ref.kind === "prompt") {
      const p = v.prompts.find((x) => x.id === ref.id);
      return {
        head: { title: p?.name ?? "Prompt", sub: promptSub(libs, ref.server, p?.parent ?? ""), icon: <PromptHeadIcon /> },
        items: [row("edit", "Edit prompt", <PencilGlyph />, () => openEditor({ mode: "edit", server: ref.server, id: ref.id })), row("move", "Move prompt…", <MoveGlyph />, () => openMove(ref))],
        destructive: row("delete", "Delete prompt…", <BinGlyph />, () => askDelete(ref)),
      };
    }
    const g = v.groups.find((x) => x.id === ref.id), at = { server: ref.server, group: ref.id };
    return {
      head: { title: g?.name ?? "Group", sub: groupSub(libs, ref.server, ref.id, heldBy(v, ref.id)), icon: <FolderHeadIcon /> },
      items: [
        row("new-prompt", "New prompt here", <DocGlyph />, () => openEditor({ mode: "new", at })),
        row("new-group", "New group here", <FolderGlyph />, () => openGroupForm({ mode: "new", at })),
        row("rename", "Rename group…", <PencilGlyph />, () => openGroupForm({ mode: "rename", server: ref.server, id: ref.id })),
        row("move", "Move group…", <MoveGlyph />, () => openMove(ref)),
      ],
      destructive: row("delete", "Delete group…", <BinGlyph />, () => askDelete(ref)),
    };
  };
  const shown = items();
  const node = (
    <>
      {shown ? <ActionSheet open={sheet!.open} onClose={() => setSheet((s) => s && { ...s, open: false })} head={shown.head} items={shown.items} destructive={shown.destructive} /> : null}
      {del ? (
        <ConfirmSheet open={del.open} onClose={() => setDel((s) => s && { ...s, open: false })} title={del.d.title} body={del.d.body} confirmLabel={del.d.confirmLabel}
          onConfirm={async () => { await (del.d.ref.kind === "prompt" ? libraryApi.deletePrompt(del.d.ref.server, del.d.ref.id) : libraryApi.deleteGroup(del.d.ref.server, del.d.ref.id)); }} />
      ) : null}
    </>
  );
  return { node, openSheet, askDelete, swipeFor };
}

type Sheets = ReturnType<typeof useRowSheets>;

/** A group's row (60 pt): the folder tile, its name, what it holds, a chevron; a tap pushes its screen, a left swipe gives Move and Delete, a long press its P1. */
export function GroupItemRow({ server, g, sheets }: { server: string; g: GroupNode; sheets: Sheets }) {
  const ref: ItemRef = { kind: "group", server, id: g.id };
  return (
    <SwipeRow right={sheets.swipeFor(ref)} data={{ server, id: ref.id }}>
      <ListRow tile={<FolderTile />} name={g.name} sub={countLine(g)} testID={S4_TID.groupRow} data={{ server, id: g.id }}
        onPress={() => { pushScreen("library-group", { server, group: g.id }); }} onLongPress={() => sheets.openSheet(ref)} />
    </SwipeRow>
  );
}

/** A prompt's row: the outlined tile, its name, the first line of its text; a tap opens the editor, a swipe and a long press as a group's. */
export function PromptItemRow({ server, p, sheets }: { server: string; p: LibraryPrompt; sheets: Sheets }) {
  const ref: ItemRef = { kind: "prompt", server, id: p.id };
  return (
    <SwipeRow right={sheets.swipeFor(ref)} data={{ server, id: ref.id }}>
      <ListRow tile={<PromptTile />} name={p.name} sub={promptLineText(textLine(p.text))} testID={S4_TID.promptRow} data={{ server, id: p.id }}
        onPress={() => openEditor({ mode: "edit", server, id: p.id })} onLongPress={() => sheets.openSheet(ref)} />
    </SwipeRow>
  );
}
