// The composer on the phone (ux-improvements goal 3.6; mockups "01", "04", "05", "07" of the composer row). Composer.tsx holds the state and the
// calls, as for every layout, and hands the phone's composer what it draws, top to bottom:
//   the @ dock (AtDock), the context row (ContextChips), the chip row of a new chat (ChipRow, package C2's), the lines of today (a pending move's
//   banner, the model notice, voice's notice), then the box: the images, the text (17 pt, up to 6 lines, then it scrolls) and, in the toolbar's
//   place, either what blocks sending (the composer part `useBlock`, package V1's: Blocked.tsx) or the toolbar (PhoneToolbar); under the box the
//   speech bar. "+" opens the Add to message sheet (PlusSheet). What blocks sending is said once (goal 3.7.1): a block that replaces the box (an
//   archived chat, the old board connection, no agent) stands alone with the lines; the others add a card above the box or take the toolbar's
//   place, and with any of them the box has no placeholder and nothing is said under it (a refused send is the red card above the box).
// The toast stands above the composer (ui/Toast.tsx useToastLift). The wide layouts keep Composer.tsx's own tree.
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useToastLift } from "../../../ui/Toast.tsx";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { useKeyboardUp } from "../../../platform/keyboard";
import { ChipRow, type ChipRowProps } from "../ChipRow.tsx";
import { DictateGuess, DictateLine } from "../../voice/DictateLine.tsx";
import { useComposerParts, type BlockInput } from "../parts.tsx";
import { AtDock, type AtDockProps } from "./AtDock.tsx";
import { ContextChips, type ContextChipsProps } from "./ContextChips.tsx";
import { PhoneToolbar, type PhoneToolbarProps } from "./PhoneToolbar.tsx";
import { PlusSheet, type PlusSheetProps } from "./PlusSheet.tsx";

export type PhoneComposerProps = {
  chatId: string;
  branch: string;
  /** The box is read-only (its server is not connected, or no longer has the chat). */
  readOnly: boolean;
  /** Speech mode stands in the box's place: the box and its toolbar are hidden, not unmounted. */
  speech: boolean;
  focused: boolean;
  /** The box's focus handlers (Composer.tsx's). */
  boxHandlers: object;
  /** The @ dock (null: closed, or no match). */
  mention: AtDockProps | null;
  /** The context row (null: none). */
  context: ContextChipsProps | null;
  chips: Omit<ChipRowProps, "chatId" | "branch">;
  /** The lines above the box: a pending move's banner, the model notice, voice's notice. */
  lines: ReactNode;
  /** The images' strip and the text box (`blocked`: a block is shown, the box has no placeholder). */
  strip: ReactNode;
  input(blocked: boolean): ReactNode;
  /** What `useBlock` needs of the composer besides the chat. */
  block: Omit<BlockInput, "chatId" | "branch">;
  /** The toolbar; `send` is given the reason a block greys Send with ("" none). */
  toolbar: Omit<PhoneToolbarProps, "chatId" | "branch" | "onPlus" | "send"> & { send(off: string): ReactNode };
  plus: Omit<PlusSheetProps, "open" | "onClose">;
  /** "+" was pressed: the sheet is about to take the focus (the composer notes the box's caret for Insert a prompt). */
  onPlusOpen?: () => void;
  /** The speech bar while speech mode is on. */
  speechBar: ReactNode;
  /** The quote float, if one is open. */
  float: ReactNode;
};

export function PhoneComposer(p: PhoneComposerProps) {
  const { tokens: t } = useTheme();
  const parts = useComposerParts();
  const block = parts.useBlock({ chatId: p.chatId, branch: p.branch, ...p.block });
  const [plusOpen, setPlusOpen] = useState(false);
  const typing = useKeyboardUp() && p.focused; // (the chips hide while the keyboard is up for the box; a picker's own field keeps them)
  const [height, setHeight] = useState<number | null>(null);
  useToastLift(height);
  const measure = (e: { nativeEvent: { layout: { height: number } } }) => setHeight(Math.round(e.nativeEvent.layout.height));
  // (a block in the box's place: the lines and the block alone; no chips, no box, no sheets)
  if (block?.box) return <View onLayout={measure}>{p.lines}{block.box}</View>;
  return (
    <View onLayout={measure}>
      {p.mention ? <AtDock {...p.mention} /> : null}
      {p.context ? <ContextChips {...p.context} /> : null}
      {typing ? null : <ChipRow chatId={p.chatId} branch={p.branch} {...p.chips} />}
      {p.lines}
      {block?.above}
      {/* (the wrapper is always there, so that the box is the same element while speech mode comes and goes) */}
      <View {...tid("composer-away", { away: p.speech })} aria-hidden={p.speech} style={p.speech ? styles.away : undefined}>
        <View {...tid("composer-box", { readonly: p.readOnly })} {...p.boxHandlers}
          style={[styles.box, { borderColor: p.focused && !p.readOnly ? t.accent : t.line2, backgroundColor: p.readOnly ? t.panel : t.bg }]}>
          <DictateLine chatId={p.chatId} branch={p.branch} />
          {p.strip}
          {p.input(!!block)}
          <DictateGuess chatId={p.chatId} branch={p.branch} />
          {block?.toolbar ?? (
            <PhoneToolbar chatId={p.chatId} branch={p.branch} {...p.toolbar} voiceOff={p.toolbar.voiceOff || block?.sendOff || ""} send={p.toolbar.send(block?.sendOff ?? "")}
              onPlus={() => { p.onPlusOpen?.(); setPlusOpen(true); }} />
          )}
        </View>
      </View>
      {p.speechBar}
      {p.float}
      <PlusSheet open={plusOpen} onClose={() => setPlusOpen(false)} {...p.plus} />
    </View>
  );
}

const styles = StyleSheet.create({
  away: { height: 0, overflow: "hidden", opacity: 0, ...webStyle({ visibility: "hidden" }) },
  box: { position: "relative", borderWidth: 1, borderRadius: 18, paddingTop: 10, paddingRight: 6, paddingBottom: 4, paddingLeft: 6 },
});
