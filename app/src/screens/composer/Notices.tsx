// The lines and bars around the composer's box (the old page's Composer.tsx): the context row of a board chat (its board, the boards its text
// mentions, the count of quotes, the note, the reference buttons), the note about a model that is not the conversation's, and the bars
// that stand for the box when a chat is archived or uses the old board connection.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { ownId } from "@aiwb/core/logic/keys.ts";
import { moveChoice, modelNotice } from "@aiwb/core/logic/models.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { branchState, shownView } from "@aiwb/core/state/store.ts";
import type { Board } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";

/** The key names the buttons and the titles carry, per platform (⌘L on a Mac and an iPad, Ctrl+L elsewhere). */
export type KeyNames = { ref: string; point: string; insert: string };

export type ContextRowProps = {
  /** The chat's own board, and the boards its text mentions. */
  own?: Board;
  board: string;
  refs: Board[];
  count: ReactNode;
  note: string;
  /** The reference buttons show (a board chat whose board is on screen and that takes a change). */
  canRef: boolean;
  selected: number;
  picking: boolean;
  keys: KeyNames;
  onAddSelection(): void;
  onPoint(): void;
};

const Chip = ({ title, mention: isRef, children }: { title: string; mention?: boolean; children: ReactNode }) => {
  const { tokens: t } = useTheme();
  const tip = useControlRef(title);
  return (
    <View ref={tip} {...tid("ctx-chip", { ref: isRef || undefined })} accessibilityLabel={title}
      style={[styles.chip, isRef ? { backgroundColor: t.accentSoft, borderColor: "transparent" } : { backgroundColor: t.panel, borderColor: t.line }]}>
      {children}
    </View>
  );
};

/** The row above the box of a board chat: its board, the boards the text mentions, the count of quotes, then (right) the note or the buttons
 *  that put the board's selection or a clicked point into the message. On touch the buttons say "Add selection" and "Point at". */
export function ContextRow({ own, board, refs, count, note, canRef, selected, picking, keys, onAddSelection, onPoint }: ContextRowProps) {
  const { tokens: t } = useTheme();
  const touch = usePointer() === "touch";
  return (
    <View {...tid("context-row")} style={styles.row}>
      <Chip title={`Every message names this board to the agent (${ownId(board)})`}>
        <BoardIcon color={t.muted} /><Text size={11.5} tone="muted" style={styles.chipText}>{own?.name ?? "board"}</Text>
      </Chip>
      {refs.map((r) => <Chip key={r.id} mention title={`Referenced board (${ownId(r.id)})`}><Text size={11.5} weight="600" tone="accent" style={styles.chipText}>@{r.name}</Text></Chip>)}
      {count}
      <View style={styles.grow} />
      {note ? <Text {...tid("ctx-note")} size={11.5} tone="warn" style={styles.note}>{note}</Text> : canRef ? <>
        <Act kind="selection" disabled={!selected} on={false} onPress={onAddSelection}
          title={`Put the selected elements into the message (${keys.ref})`} hint={touch ? "" : keys.ref}>
          {touch ? (selected ? `Add ${selected} selected` : "Add selection") : `+ ${selected ? `${selected} selected` : "Selection"}`}
        </Act>
        <Act kind="point" disabled={false} on={picking} onPress={onPoint}
          title={`Click a point on the board to put it into the message (${keys.point})`} hint={touch ? "" : keys.point}>
          {touch ? "Point at" : "+ Point"}
        </Act>
      </> : null}
    </View>
  );
}

/** One of the two buttons of the context row. A press leaves the focus where it is: in the box, the caret says where the text goes. */
function Act({ kind, disabled, on, onPress, title, hint, children }: { kind: string; disabled: boolean; on: boolean; onPress(): void; title: string; hint: string; children: ReactNode }) {
  const { tokens: t } = useTheme();
  const tip = useControlRef(title, false, true);
  return (
    <Pressable ref={tip} {...tid("ctx-act", { kind, on })} role="button" disabled={disabled} accessibilityLabel={title} accessibilityState={{ disabled, selected: on }}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.act, (on || (hovered && !disabled)) && { backgroundColor: t.accentSoft }, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      <Text size={11.5} tone={disabled ? "faint" : on ? "accent" : "muted"} style={on || undefined ? { color: t.accent } : undefined}>{children}</Text>
      {hint ? <Text size={10} tone="faint" style={styles.kbd}>{hint}</Text> : null}
    </Pressable>
  );
}

/** The note above the composer's box when the model chosen is not the one the conversation so far ran on: for a pending move against its
 *  source, for a fork without a message of its own against the branch it was forked from. What it says is modelNotice's. */
export function ModelNotice({ chatId }: { chatId: string }) {
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => (c ? catalogFor(s, serverOf(c), c.agent) : undefined));
  const parent = useStore((s) => (c?.fresh && c.forkedFrom ? branchState(s, c.forkedFrom, c.forkedBranch) : undefined));
  if (!c || !c.agent) return null;
  const n = move
    ? modelNotice({ agent: c.agent, choice: moveChoice(move, c), parent: c, at: move.at, ctxIn: c.usage?.ctxIn, cat })
    // A fork is fresh only with a prefix: the server leaves forkedAt out when it does not know the count.
    : c.fresh ? modelNotice({ agent: c.agent, choice: c, parent, at: c.forkedAt || 1, ctxIn: c.usage?.ctxIn, cat }) : null;
  return n ? <Text {...tid("model-notice", { warn: !!n.warn })} size={11.5} tone={n.warn ? "warn" : "muted"} style={styles.notice}>{n.text}</Text> : null;
}

/** The bar that stands for the box of an archived chat: "Archived — unarchive to continue" with an Unarchive button, or, while its server is
 *  not connected, "Archived." and the reason with no button. */
export function ArchivedBar({ off, why, onUnarchive }: { off: boolean; why: string; onUnarchive(): void }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("archived-bar")} style={[styles.bar, { backgroundColor: t.panel, borderColor: t.line }]}>
      {off ? <Text size={12.5} tone="muted" style={styles.barText}>Archived. {why}</Text> : <>
        <Text size={12.5} tone="muted" style={styles.barText}>Archived — unarchive to continue</Text>
        <Button {...tid("unarchive")} size="sm" label="Unarchive" onPress={onUnarchive} />
      </>}
    </View>
  );
}

/** The bar of a chat that used the old board connection. */
export function LegacyBar() {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("archived-bar", { legacy: true })} style={[styles.bar, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Text size={12.5} tone="muted" style={styles.barText}>This chat used the old board connection — start a new chat to continue</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 },
  grow: { flexGrow: 1, flexBasis: 0 },
  // (a long name wraps inside its chip, which is never wider than the row)
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 7, flexShrink: 1, maxWidth: "100%" },
  chipText: { flexShrink: 1, minWidth: 0 },
  note: { paddingVertical: 1, paddingHorizontal: 5 },
  act: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 1, paddingHorizontal: 5, borderRadius: 5 },
  kbd: { opacity: 0.9 },
  notice: { marginBottom: 6, paddingHorizontal: 2 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  barText: { flexShrink: 1 },
});
