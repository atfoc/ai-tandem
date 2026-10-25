// The phone's row of chips above the box (ux-improvements goal 3.6, mockup "02 The chat's setup" co-02a, co-02s; package C2): agent, folder,
// model · effort and subagents as 36-point chips in a row that scrolls sideways, each opening its picker sheet (phone/chips/*: mockup "03 The
// pickers"). Only the choices the chat still has (core's chipKinds: a new chat all; a fork with no message of its own and a pending move the
// model alone, with "Only the model can change" beside it); a started chat, and one whose server is not connected or no longer has it, none
// (what blocks it is said once, elsewhere). An agent the server lacks turns its chip red with the warning sign, and the reason stands under the
// row. The chips hide while the keyboard is up (PhoneComposer.tsx). The wide layouts keep the toolbar's chips (Toolbar.tsx).
//
// Where model and effort write is pickerMode's, as in the toolbar: a pending move's choice, else the session (PATCH; a fork's pick starts its
// agent again, pickOnFork, and until that ends the model chip names the choice and takes no press). While the composer sends, or a change is
// being saved, or the chat's message is on its way (State.waits), the chips take no press.
import { useState, type ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { catalogFor, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { agentChoiceOn, sendOff, toolbarLine } from "@aiwb/core/logic/chatserver.ts";
import { ONLY_MODEL, chipKinds, type ChipKind } from "@aiwb/core/logic/chiprow.ts";
import { moveChoice, pickerMode, withEffort, withModel, type Choice } from "@aiwb/core/logic/models.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { subChipLabel, subSettings } from "@aiwb/core/logic/subsettings.ts";
import { SENDING, heldReason, pickOn, startingOn } from "@aiwb/core/logic/waits.ts";
import { pickOnFork, setMoveChoice } from "@aiwb/core/state/actions.ts";
import { chatTitle, getState, shownBranch, shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { AgentKind, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, Folder, WarnIcon, agentName } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { base, useWhere } from "../chat/hooks.ts";
import { effortLabel, modelLabel, modelOf, subline } from "./model.ts";
import { AgentSheet } from "./phone/chips/AgentSheet.tsx";
import { FolderSheet } from "./phone/chips/FolderSheet.tsx";
import { C2_IDS } from "./phone/chips/ids.ts";
import { ModelSheet } from "./phone/chips/ModelSheet.tsx";
import { SubagentsSheet } from "./phone/chips/SubagentsSheet.tsx";

export type ChipRowProps = {
  chatId: string;
  branch: string;
  /** The composer sends a message: the chips take no pick. */
  sending: boolean;
  onError(msg: string): void;
};

export function ChipRow({ chatId, ...p }: ChipRowProps) {
  const c = useStore((s) => shownView(s, chatId));
  return c ? <Row c={c} chatId={chatId} {...p} /> : null;
}

function Row({ c, chatId, sending, onError }: ChipRowProps & { c: ChatView }) {
  const { tokens: t } = useTheme();
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => catalogFor(s, serverOf(c), c.agent));
  const waits = useStore((s) => s.waits[chatId]);
  const pick = useStore((s) => pickOn(s.waits[chatId], shownBranch(s, chatId))); // the choice a fork's agent is being started on
  const gone = useStore((s) => !!s.gone[chatId]);
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const where = useWhere(c);
  const usable = useStore((s) => usableAgents(s, where.server));
  const [open, setOpen] = useState<ChipKind | null>(null);
  const [patching, setPatching] = useState(false);

  const frozen = sendOff(where) || gone;
  // (while a fork's pick starts its agent again the chat reads as busy, which fixes its model: the chip stays, naming the choice, and takes no press)
  const asked = chipKinds(c, { frozen, move: !!move });
  const kinds: ChipKind[] = pick && !frozen && !!c.agent && !asked.includes("model") ? [...asked.filter((k) => k !== "subagents"), "model", ...asked.filter((k) => k === "subagents")] : asked;
  if (!kinds.length) return null;

  const held = heldReason(waits, "choice") || ""; // why the model and the effort take no pick now
  const busy = patching || sending;
  // why the chips that take no press now take none (the wide toolbar says it in a hover title: goal 3.1.3, a visible line and the chip's accessible name)
  const why = held || (pick ? startingOn(pick.label) : sending ? SENDING : patching ? "Saving your choice…" : "");
  const said = (label: string) => (why ? `${label}. ${why}` : label);
  const mode = pick ? "fixed" : pickerMode(c, !!move);
  const shown: Choice = mode === "move" ? moveChoice(move, c) : pick ? { model: pick.model, effort: pick.effort } : c;
  const name = chatTitle(c, items);
  const choice = agentChoiceOn(where, usable, c.agent);
  const reason = kinds.includes("agent") ? toolbarLine(where, usable, c, gone) : { text: "", tone: "" };

  // a session's PATCH (a fork's starts its agent again), or a pending move's choice
  const configure = (body: { model?: string; effort?: string }, ch: Choice) => {
    setPatching(true);
    const call: Promise<unknown> = c.fresh ? pickOnFork(chatId, body, ch, subline({ ...c, model: ch.model, effort: ch.effort }, cat)) : api.configure(chatId, shownBranch(getState(), chatId), body);
    return call.then(() => onError(""), (e) => onError(e.message)).finally(() => setPatching(false));
  };
  const setChoice = (ch: Choice) => { onError(""); setMoveChoice(chatId, ch); };
  const pickModel = (id: string) => { const ch = withModel(shown, id, cat); if (mode === "move") setChoice(ch); else void configure({ model: id }, ch); };
  const pickEffort = (id: string) => { const ch = withEffort(shown, id); if (mode === "move") setChoice(ch); else void configure({ effort: id }, ch); };
  const opens = (k: ChipKind) => () => setOpen(k);
  const close = () => setOpen(null);

  const m = modelOf(shown, cat);
  const modelText = !cat ? "Loading models…" : m?.efforts?.length && shown.effort ? `${modelLabel(shown, cat)} · ${effortLabel(shown.effort, m)}` : modelLabel(shown, cat);
  const chips: Record<ChipKind, () => ReactElement> = {
    agent: () => {
      const none = !choice.options.length;
      return (
        <PhoneChip key="agent" kind="agent" label={none ? "No agent" : c.agent ? `Agent: ${agentName(c.agent)}` : "Choose an agent"} missing={choice.missing || none}
          disabled={busy || none} onPress={opens("agent")}
          icon={choice.missing || none ? <WarnIcon size={16} color={t.danger} /> : c.agent ? <AgentGlyph agent={c.agent} size={16} /> : undefined}>
          {none ? "No agent" : c.agent ? agentName(c.agent as AgentKind) : "Choose an agent"}
        </PhoneChip>
      );
    },
    folder: () => (
      <PhoneChip key="folder" kind="folder" label={`Folder: ${base(c.cwd) || "/"}`} missing={!!c.folderMissing} disabled={busy} onPress={opens("folder")}
        icon={<Folder size={16} color={c.folderMissing ? t.danger : t.muted} />}>
        {base(c.cwd) || "/"}
      </PhoneChip>
    ),
    model: () => (
      <PhoneChip key="model" kind="model" label={cat ? said(`Model and effort: ${modelText}`) : `Model and effort: ${modelText}`} disabled={busy || !!held || !!pick || !cat} onPress={opens("model")}>
        {modelText}
      </PhoneChip>
    ),
    subagents: () => (
      <PhoneChip key="subagents" kind="subagents" label={said(`Subagents: ${subChipLabel(subSettings(c))}`)} disabled={busy || !!held} onPress={opens("subagents")}>
        {`Subagents · ${subChipLabel(subSettings(c))}`}
      </PhoneChip>
    ),
  };

  return (
    <View>
      <ScrollView {...tid(C2_IDS.row)} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
        style={styles.scroll} contentContainerStyle={styles.row}>
        {kinds.map((k) => chips[k]())}
        {kinds.length === 1 && kinds[0] === "model" ? <Text {...tid(C2_IDS.note)} size={TYPE.secondary} tone="muted" style={styles.note}>{ONLY_MODEL}</Text> : null}
      </ScrollView>
      {reason.text ? (
        <Text {...tid("agent-reason", { tone: reason.tone || undefined })} size={TYPE.secondary} tone={reason.tone === "missing" ? "danger" : "muted"} style={styles.reason}>
          {reason.text}
        </Text>
      ) : null}
      {why && kinds.some((k) => k === "model" || k === "subagents") ? (
        <Text {...tid(C2_IDS.held)} size={TYPE.secondary} tone="muted" style={styles.reason}>{why}</Text>
      ) : null}
      {kinds.includes("agent") ? <AgentSheet open={open === "agent"} onClose={close} c={c} sub={name} onBusy={setPatching} onError={onError} /> : null}
      {kinds.includes("folder") ? (
        <FolderSheet open={open === "folder"} onClose={close} cwd={c.cwd} server={where.server}
          onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })} />
      ) : null}
      {kinds.includes("model") && cat ? (
        <ModelSheet open={open === "model"} onClose={close} c={c} sub={c.agent ? `${name} · ${agentName(c.agent as AgentKind)}` : name} cat={cat} value={shown}
          onPickModel={pickModel} onPickEffort={pickEffort} held={busy ? "Saving your choice…" : held} />
      ) : null}
      {kinds.includes("subagents") ? (
        <SubagentsSheet open={open === "subagents"} onClose={close} c={c} sub={name} disabled={busy || !!held} onBusy={setPatching} onError={onError} />
      ) : null}
    </View>
  );
}

/** A 36-point chip: an icon, the value at 15 pt and a caret; red with the warning sign when what it names is missing; while it takes no press,
 *  muted on the panel's ground (no fading: its text keeps its contrast in every flavour). */
function PhoneChip({ kind, label, icon, children, missing, disabled, onPress }: {
  kind: ChipKind; label: string; icon?: ReactElement; children: string; missing?: boolean; disabled?: boolean; onPress(): void;
}) {
  const { tokens: t } = useTheme();
  return (
    <Pressable {...tid("tchip", { kind, missing: !!missing, fixed: false })} role="button" accessibilityLabel={label} aria-haspopup="dialog"
      disabled={disabled} aria-disabled={disabled || undefined} accessibilityState={{ disabled: !!disabled }} onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={[styles.chip, { backgroundColor: disabled ? t.panel : t.bg, borderColor: missing ? t.danger : t.line2 }, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      {icon}
      <Text {...tid("chip-name")} size={15} tone={missing ? "danger" : disabled ? "muted" : undefined} numberOfLines={1} style={styles.name}>{children}</Text>
      <Text size={13} tone={missing ? "danger" : "muted"} accessibilityElementsHidden importantForAccessibility="no">⌄</Text>
    </Pressable>
  );
}

/** The composer's side padding (Composer.tsx): the row bleeds to the screen's edges through it, as the context row does. */
const SIDE = 12;

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, marginHorizontal: -SIDE },
  row: { height: PHONE.target, alignItems: "center", gap: 8, paddingHorizontal: SIDE },
  chip: { height: PHONE.chip, flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, flexShrink: 0, maxWidth: 260 },
  name: { flexShrink: 1 },
  note: { flexShrink: 0 },
  reason: { paddingHorizontal: 4, paddingBottom: 4 },
});
