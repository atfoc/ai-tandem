// A chat's context row on the phone (ux-improvements goal 3.6, mockup "05" co-05a): a 44-point row of 34-point chips that scrolls sideways: the
// board chip first (a tap opens the board), the message's references (a point, a selection: board/RefChips.tsx, each with ×), the @ boards the
// text mentions (each with ×) and the quotes' chip ("2 quotes", which opens "Quoted in this message": quotes/QuoteCount.tsx draws it).
// The selection rule (goal 3.4): nothing here puts the board's selection into the message, and nothing offers to ("+ Add 2 selected" is gone);
// the "+" sheet's Add selection and Point at do (B2). A chat with no board shows the row only for its quotes; the note a reference action left
// stands under the row. No keyboard hints, no hover titles.
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { Board } from "@aiwb/core/types.ts";

import { BoardIcon } from "../../../ui/icons.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useControlRef } from "../../../ui/useControlRef";
import { webStyle } from "../../../ui/webstyle.ts";
import { CloseIcon } from "./icons.tsx";
import { PHONE_IDS } from "./ids.ts";

export type ContextChipsProps = {
  /** The chat's board (undefined: a chat with no board) and the board itself when known. */
  board?: string;
  own?: Board;
  /** The boards the text mentions, other than its own. */
  refs: Board[];
  /** The quotes' chip (null: no quotes). */
  count: ReactNode;
  /** The sentence the last reference action left ("" none). */
  note: string;
  /** The message's references as chips (board/RefChips.tsx), drawn right after the board chip (undefined: none). */
  refChips?: ReactNode;
  /** Takes a mentioned board out of the message (its "@name" leaves the text). */
  onRemoveRef(b: Board): void;
  /** Opens the chat's board. */
  onOpenBoard(): void;
};

/** The composer's side padding (Composer.tsx `styles.composer`): the row bleeds to the screen's edges through it. */
const SIDE = 12;
const CHIP = 34;

export function ContextChips(p: ContextChipsProps) {
  const { tokens: t } = useTheme();
  if (!p.board && !p.count && !p.note && !p.refChips) return null;
  return (
    <View>
      {p.board || p.count || p.refChips ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" {...tid(PHONE_IDS.contextRow)}
          style={styles.scroll} contentContainerStyle={styles.row}>
          {p.board ? <BoardChip name={p.own?.name ?? "board"} onPress={p.onOpenBoard} /> : null}
          {p.refChips}
          {p.board ? p.refs.map((r) => <RefChip key={r.id} board={r} onRemove={() => p.onRemoveRef(r)} />) : null}
          {p.count}
        </ScrollView>
      ) : null}
      {p.note ? <Text {...tid("ctx-note")} size={TYPE.secondary} style={[styles.note, { color: t.warnText }]}>{p.note}</Text> : null}
    </View>
  );
}

function BoardChip({ name, onPress }: { name: string; onPress(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined, false, true);
  return (
    <Pressable ref={ref} {...tid("ctx-chip", { kind: "board" })} role="button" accessibilityLabel={`Open the board ${name}`} onPress={onPress}
      hitSlop={{ top: 5, bottom: 5 }}
      style={[styles.chip, { backgroundColor: t.panel, borderColor: t.line }, webStyle({ cursor: "pointer" })]}>
      <BoardIcon size={16} color={t.muted} />
      <Text size={15} tone="muted" numberOfLines={1} style={styles.name}>{name}</Text>
    </Pressable>
  );
}

/** A board the text mentions: its name on accent-soft and a × (a 44-point target) that takes it out of the message. */
function RefChip({ board, onRemove }: { board: Board; onRemove(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined, false, true);
  return (
    <View {...tid("ctx-chip", { kind: "ref", board: board.id })} style={[styles.chip, styles.ref, { backgroundColor: t.accentSoft, borderColor: "transparent" }]}>
      <Text size={15} weight="600" tone="accent" numberOfLines={1} style={styles.name}>{board.name}</Text>
      <Pressable ref={ref} {...tid("ctx-chip-remove")} role="button" accessibilityLabel={`Remove ${board.name} from the message`} onPress={onRemove}
        hitSlop={{ top: 5, bottom: 5, left: 10, right: 10 }} style={[styles.remove, webStyle({ cursor: "pointer" })]}>
        <CloseIcon size={12} color={t.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // (the row bleeds to the screen's edges: the composer's side padding is taken back, and given again as the content's)
  scroll: { flexGrow: 0, marginHorizontal: -SIDE },
  row: { height: PHONE.target, alignItems: "center", gap: 8, paddingHorizontal: SIDE },
  chip: { height: CHIP, flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, flexShrink: 0, maxWidth: 260 },
  name: { flexShrink: 1 },
  ref: { paddingRight: 4 },
  remove: { width: 24, height: CHIP, alignItems: "center", justifyContent: "center" },
  note: { paddingHorizontal: 4, paddingBottom: 4 },
});
