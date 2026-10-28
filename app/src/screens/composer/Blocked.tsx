// What blocks sending, on the phone (ux-improvements goal 3.7.1, mockups "07 Notices" and "10 Another server"; the V1 design §1). `useBlock` is the
// composer part PhoneComposer calls on every render: it reads the chat, its server and the model notice, asks blocked.ts which states hold and
// draws them, each said once, in one place: the box's own (archived, the old board connection, no agent: a bar in the box's shape), the toolbar's
// (offline, gone: inside the read-only box, the draft visible) or right above the box (a model too small, a refused send).
// The wide layouts keep their bars: ArchivedBar and LegacyBar (the old page's) live here, unchanged, for Composer.tsx's early returns.
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { api } from "@aiwb/core/api.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { moveChoice, pickerMode, type Choice } from "@aiwb/core/logic/models.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { heldReason, pickOn } from "@aiwb/core/logic/waits.ts";
import { pickOnFork, setMoveChoice } from "@aiwb/core/state/actions.ts";
import { chatTitle, getState, isLegacy, shownBranch, shownView, threadOf } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { WarnIcon, agentName, type IconProps } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { openServer } from "../servers/open.ts";
import { newChat } from "../shell/nav.ts";
import { blockOf, type BlockWords } from "./blocked.ts";
import { subline } from "./model.ts";
import { useModelNotice } from "./Notices.tsx";
import { ModelSheet } from "./phone/chips/ModelSheet.tsx";
import { CloseIcon } from "./phone/icons.tsx";
import type { BlockInput, BlockOut } from "./parts.tsx";

/** The block of the phone's composer, or null when nothing blocks sending. */
export function useBlock(o: BlockInput): BlockOut | null {
  const c = useStore((s) => shownView(s, o.chatId));
  const since = useStore((s) => s.serverSince[o.where.server]);
  const notice = useModelNotice(o.chatId);
  if (!c) return null;
  const b = blockOf({
    archived: !!c.archived, legacy: isLegacy(c), board: !!c.board, where: o.where, gone: o.gone, usable: o.usable, agent: c.agent || "",
    since, now: Date.now(), tooSmall: notice?.warn ? notice.text : "", refused: o.refused,
  });
  if (!b.main && !b.above.length) return null;
  const out: BlockOut = {};
  if (b.main) {
    const part = <MainBlock words={b.main} chatId={o.chatId} board={c.board} server={o.where.server} />;
    if (b.main.place === "box") out.box = part; else out.toolbar = part;
  }
  if (b.above.length) {
    out.above = <View style={styles.above}>{b.above.map((w) => <AboveCard key={w.kind} words={w} chatId={o.chatId} onDismiss={o.onDismissRefused} />)}</View>;
    if (b.sendOff) out.sendOff = b.sendOff;
  }
  return out;
}

// ---- the box's and the toolbar's places

function MainBlock({ words, chatId, board, server }: { words: BlockWords; chatId: string; board?: string; server: string }) {
  const { tokens: t } = useTheme();
  const tidFor = tid("composer-block", { kind: words.kind, place: words.place });
  if (words.place === "toolbar") {
    return (
      <View {...tidFor} style={[styles.toolbar, { borderTopColor: t.line }]}>
        {words.kind === "offline" ? <View style={styles.glyph}><CloudGlyph color={t.faint} /></View> : null}
        <View style={styles.words}><Words words={words} /></View>
        {words.action === "servers" ? <Button {...tid("block-servers")} size="touch" label="Servers" onPress={() => openServer(server)} /> : null}
      </View>
    );
  }
  return (
    <View {...tidFor}>
      <View {...(words.kind === "archived" || words.kind === "legacy" ? tid("archived-bar", words.kind === "legacy" ? { legacy: true } : undefined) : {})}
        style={[styles.bar, { backgroundColor: t.panel, borderColor: t.line }]}>
        <View style={styles.barHead}>
          {words.kind === "archived" ? <View style={styles.glyph}><ArchiveGlyph color={t.faint} /></View> : words.kind === "noagent" ? <View style={styles.glyph}><WarnIcon size={18} color={t.warn} /></View> : null}
          <View style={styles.words}><Words words={words} /></View>
        </View>
        {words.action === "unarchive" ? <Unarchive chatId={chatId} /> : null}
        {words.action === "newchat" && board ? (
          <Button {...tid("block-newchat")} tone="primary" size="touch" label="New chat on this board" style={styles.full} onPress={() => { void newChat({ board }); }} />
        ) : null}
      </View>
    </View>
  );
}

const Words = ({ words }: { words: BlockWords }) => (
  <>
    <Text size={TYPE.control}>{words.title}</Text>
    {words.sub ? <Text size={TYPE.secondary} tone="muted">{words.sub}</Text> : null}
  </>
);

/** Unarchive: full width; a refusal is said inside the bar. */
function Unarchive({ chatId }: { chatId: string }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button {...tid("unarchive")} tone="primary" size="touch" label="Unarchive" disabled={busy} style={styles.full}
        onPress={() => { setBusy(true); setErr(""); api.unarchive("chats", chatId).catch((e) => setErr(e.message)).finally(() => setBusy(false)); }} />
      {err ? <Text {...tid("composer-err")} size={TYPE.secondary} tone="danger">{err}</Text> : null}
    </>
  );
}

// ---- above the box

function AboveCard({ words, chatId, onDismiss }: { words: BlockWords; chatId: string; onDismiss(): void }) {
  const { tokens: t } = useTheme();
  const small = words.kind === "toosmall";
  return (
    <View {...tid("composer-block", { kind: words.kind, place: "above" })}
      style={[styles.card, small ? { backgroundColor: t.warnSoft, borderColor: t.warn } : { backgroundColor: t.dangerSoft, borderColor: t.danger }]}>
      {small ? <View style={styles.cardGlyph}><WarnIcon size={16} color={t.warn} /></View> : null}
      <Text {...(small ? tid("model-notice", { warn: true }) : tid("composer-err"))} size={TYPE.secondary} style={[styles.words, { color: small ? t.warnText : t.danger }]}>
        {words.title}
      </Text>
      {small ? <PickModel chatId={chatId} /> : (
        <IconButton {...tid("block-dismiss")} size="touch" title="Dismiss" onPress={onDismiss}>{(colour) => <CloseIcon size={14} color={colour} />}</IconButton>
      )}
    </View>
  );
}

/** "Pick a model": C2's Model and effort sheet, writing where the chip row's does (a pending move's choice, else the session). */
function PickModel({ chatId }: { chatId: string }) {
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => (c ? catalogFor(s, serverOf(c), c.agent) : undefined));
  const waits = useStore((s) => s.waits[chatId]);
  const fork = useStore((s) => pickOn(s.waits[chatId], shownBranch(s, chatId)));
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const held = heldReason(waits, "choice") || "";
  const mode = fork ? "fixed" : pickerMode(c, !!move);
  const shown: Choice = mode === "move" ? moveChoice(move, c) : fork ? { model: fork.model, effort: fork.effort } : c;
  const configure = (body: { model?: string; effort?: string }, ch: Choice) => {
    setBusy(true);
    const call: Promise<unknown> = c.fresh ? pickOnFork(chatId, body, ch, subline({ ...c, model: ch.model, effort: ch.effort }, cat)) : api.configure(chatId, shownBranch(getState(), chatId), body);
    return call.catch(() => {}).finally(() => setBusy(false));
  };
  // the model and effort menu's draft, applied in one write (only the fields that differ)
  const apply = (patch: { model?: string; effort?: string }, ch: Choice) => { if (mode === "move") setMoveChoice(chatId, ch); else void configure(patch, ch); };
  const name = chatTitle(c, items);
  return (
    <>
      <Button {...tid("block-pick-model")} size="touch" label="Pick a model" disabled={!cat || busy || !!held || !!fork} onPress={() => setOpen(true)} />
      {cat ? (
        <ModelSheet open={open} onClose={() => setOpen(false)} c={c} sub={c.agent ? `${name} · ${agentName(c.agent)}` : name} cat={cat} value={shown}
          held={busy ? "Saving your choice…" : held} focusSearch={false} onApply={apply} />
      ) : null}
    </>
  );
}

// ---- glyphs

const CloudGlyph = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill={color} stroke="none">
    <Path d="M4.6 12.5a3.1 3.1 0 0 1-.5-6.2 4 4 0 0 1 7.7.8 2.7 2.7 0 0 1-.4 5.4z" />
  </Svg>
);

const ArchiveGlyph = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round">
    <Path d="M2 3.5h12v3H2zM3 6.5V13h10V6.5M6.3 9h3.4" />
  </Svg>
);

// ---- the bars of the wide layouts (the old page's, unchanged)

/** The bar that stands for the box of an archived chat: "Archived — unarchive to continue" with an Unarchive button, or, while its server is
 *  not connected, "Archived." and the reason with no button. */
export function ArchivedBar({ off, why, onUnarchive }: { off: boolean; why: string; onUnarchive(): void }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("archived-bar")} style={[styles.wideBar, { backgroundColor: t.panel, borderColor: t.line }]}>
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
    <View {...tid("archived-bar", { legacy: true })} style={[styles.wideBar, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Text size={12.5} tone="muted" style={styles.barText}>This chat used the old board connection — start a new chat to continue</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6, paddingTop: 8, paddingBottom: 2, paddingHorizontal: 8, borderTopWidth: 1 },
  glyph: { width: 24, alignItems: "center", justifyContent: "center", alignSelf: "flex-start", paddingTop: 2 },
  words: { flex: 1, flexShrink: 1, minWidth: 0 },
  bar: { gap: 12, padding: 14, borderWidth: 1, borderRadius: 18 },
  barHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  full: { alignSelf: "stretch", alignItems: "center", minHeight: PHONE.target },
  above: { gap: 6, marginBottom: 6 },
  card: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 12, paddingRight: 6, borderWidth: 1, borderRadius: 14 },
  cardGlyph: { alignSelf: "flex-start", paddingTop: 11 },
  wideBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  barText: { flexShrink: 1 },
});
