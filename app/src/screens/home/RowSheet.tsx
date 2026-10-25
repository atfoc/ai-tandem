// A row's action sheet (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §3): the P1 sheet a long press on a row
// of Home or a group's screen opens (and the group screen's "…"): the row's tile, name and "Chat · Checkout service · Studio Mac", then Open,
// Rename…, Move to… (its note is the group the row is in; it opens the P2 of the places), Archive, and Delete … last, red, after a separator.
// RowSheetHost is mounted once through the shell's Overlays slot (home/index.ts).
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { groupsOn } from "@aiwb/core/state/store.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";

import { useStore } from "../../state/useStore.ts";
import { ActionSheet, type ActionItem } from "../../ui/ActionSheet.tsx";
import { AgentGlyph, BoardIcon, Folder, GroupIcon, Pencil } from "../../ui/icons.tsx";
import { PickerSheet } from "../../ui/PickerSheet.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { moveGroup, moveTo } from "../sidebar/actions.ts";
import { archiveItem, itemName } from "./archive.ts";
import { askDelete } from "./deletes.ts";
import { H2_TID } from "./h2ids.ts";
import { pathOf, type RowKind } from "./model.ts";
import { openItem } from "./open.ts";
import { openRename } from "./RenameSheet.tsx";
import { currentPlace, deleteNoun, headSub, moveNote, moveSub, placesFor, placesForGroup, TOP_LEVEL } from "./rowsheetmodel.ts";

export type RowRef = { kind: RowKind; key: string };

let open: RowRef | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openRowSheet(item: RowRef): void {
  open = { kind: item.kind, key: item.key };
  emit();
}

export function closeRowSheet(): void {
  if (open === null) return;
  open = null;
  emit();
}

export const useRowSheet = (): RowRef | null =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => null);

/** Runs `run` once the sheet that is closing is gone: a second modal can't rise while the first goes on iOS (the web has no such wait). */
const CLOSE_WAIT_MS = 250;
const afterClose = (run: () => void): void => { if (Platform.OS === "web") run(); else setTimeout(run, CLOSE_WAIT_MS); };

const ICON = 20;

export function RowSheetHost() {
  const item = useRowSheet();
  const [moving, setMoving] = useState<RowRef | null>(null);
  return (
    <>
      {item ? <RowSheet item={item} onMove={() => afterClose(() => setMoving(item))} /> : null}
      {moving ? <MoveSheet item={moving} onClose={() => setMoving(null)} /> : null}
    </>
  );
}

/** Everything the sheets say of a row, read from the store: its name, where it is, its server. */
function useRowFacts(item: RowRef) {
  const s = useStore((st) => st);
  const name = itemName(item);
  const path = pathOf(s, item.kind, item.key);
  const names = (keys: string[]) => keys.map((k) => groupsOn(s, path.server).find((g) => g.id === k)?.name ?? "");
  const place = names(item.kind === "group" ? path.groups.slice(0, -1) : path.groups);
  const board = path.board ? s.boards[path.board]?.name ?? null : null;
  const server = s.servers.find((v) => v.id === path.server)?.name || serverName(s, path.server);
  return { s, name, path, place, board, server };
}

function RowSheet({ item, onMove }: { item: RowRef; onMove(): void }) {
  const t = useTokens();
  const { s, name, place, board, server } = useRowFacts(item);
  const gone = name === undefined;
  useEffect(() => { if (gone) closeRowSheet(); }, [gone]);
  if (gone) return null;
  const chatOnBoard = item.kind === "chat" && !!s.chats[item.key]?.board;
  const noun = deleteNoun(item.kind);
  const items: ActionItem[] = [
    { id: "open", label: "Open", icon: <OpenIcon color={t.text} />, onPress: () => afterClose(() => openItem(item)) },
    { id: "rename", label: "Rename…", icon: <Pencil size={ICON} color={t.text} />, onPress: () => afterClose(() => openRename(item)) },
    ...(chatOnBoard ? [] : [{ id: "move", label: "Move to…", icon: <Folder size={ICON} color={t.text} />, note: `${moveNote(item.kind, place)} ›`, onPress: onMove }]),
    { id: "archive", label: "Archive", icon: <ArchiveIcon color={t.text} />, onPress: () => archiveItem(item) },
  ];
  const glyph = item.kind === "group" ? <GroupIcon size={ICON} color={t.muted} />
    : item.kind === "board" ? <BoardIcon size={ICON} color={t.accent} />
    : <AgentGlyph agent={s.chats[item.key]?.agent ?? ""} size={ICON} />;
  return (
    <ActionSheet open onClose={closeRowSheet} testID={H2_TID.rowSheet} dataSet={{ kind: item.kind, key: item.key }} head={{ title: name, sub: headSub(item.kind, place, board, server), icon: glyph }} items={items}
      destructive={{ id: "delete", label: `Delete ${noun}…`, icon: <BinIcon color={t.danger} />, onPress: () => afterClose(() => askDelete(item)) }} />
  );
}

/** The P2 of "Move to…": the places the row may go (not, for a group, itself or what is inside it); a tap moves it and closes. */
function MoveSheet({ item, onClose }: { item: RowRef; onClose(): void }) {
  const { s, name, path, place } = useRowFacts(item);
  const gone = name === undefined;
  useEffect(() => { if (gone) onClose(); }, [gone, onClose]);
  if (gone) return null;
  const groups = groupsOn(s, path.server);
  const current = item.kind === "group" ? groups.find((g) => g.id === item.key)?.parent : item.kind === "board" ? s.boards[item.key]?.group : s.chats[item.key]?.group;
  const places = item.kind === "group" ? placesForGroup(groups, item.key) : placesFor(groups, path.server, current ?? "");
  return (
    <PickerSheet<string> open onClose={onClose} testID={H2_TID.moveSheet} title="Move to" sub={moveSub(item.kind, name, place)}
      options={places.map((p) => ({ value: p.value, label: p.label }))} value={currentPlace(item.kind, path.server, current)}
      onPick={(v) => {
        if (item.kind === "group") moveGroup(item.key, v === TOP_LEVEL ? "" : v);
        else moveTo(`${item.kind}:${item.key}`, v);
      }} />
  );
}

// The icons of the sheet's rows that ui/icons.tsx has none of (20 pt, the kit's 1.5 line).
function Glyph({ color, children }: { color: string; children: ReactNode }) {
  return <Svg width={ICON} height={ICON} viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">{children}</Svg>;
}
const OpenIcon = ({ color }: { color: string }) => <Glyph color={color}><Rect x="2.5" y="4" width="15" height="12" rx="1.5" /></Glyph>;
const ArchiveIcon = ({ color }: { color: string }) => <Glyph color={color}><Rect x="2.5" y="3.5" width="15" height="4" rx="1" /><Path d="M4 7.5V16h12V7.5M8 11h4" /></Glyph>;
const BinIcon = ({ color }: { color: string }) => <Glyph color={color}><Path d="M3.5 5.5h13M8 5.5V3.5h4v2M5 5.5l.8 11h8.4l.8-11M8.5 9v5M11.5 9v5" /></Glyph>;
