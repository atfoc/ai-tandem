// The composer's toolbar (the old page's Composer.tsx Toolbar / Tools): the name of the server of a chat of a section (showsServer; it is no choice),
// the agent while it can be changed (agentOpen; ChatChoices.tsx), then folder, model, effort, the Subagents chip (S7: open on a new chat alone,
// else fixed) and the context meter (S9's `ContextMeter`) of the branch shown; after the row's spacer the insert button, the attach button (K4), Stop and Send.
// Where the model and effort controls write is pickerMode's: with a pending move they show and set the move's choice, which goes with its
// message; on a new chat and on a fork without a message of its own they change the session (PATCH); else they are fixed. While the composer
// sends a message (sending) they take no pick: a move's choice has gone with the message, and the server refuses a fork's PATCH. The same holds
// while the chat's message is on its way and this composer was opened since (State.waits): they are disabled and say why. A pick on a fork
// starts its agent again, which the chat is told of (pickOnFork): until that call ends the model is a fixed chip that names the choice the
// agent is starting on, whatever the agent kind tells meanwhile.
//
// The row never holds more than fits it (logic/composerfit.ts): as room runs out the controls leave for the popup of a "more" chip, where each
// is the chip it was, with its own list. Each control is drawn once, in the row or in the open popup; one that changes place is made anew
// there, so it has no open list, and while the popup is open nothing leaves it for the row (a pick made there keeps its chip, with the
// focus). The widths are measured with onLayout (measure.tsx): a control whose width is not kept is drawn in the measuring layer, and the
// fit is made again with it when it reports; the row's width is its own onLayout. The fit rules are core's, unchanged. Voice's two controls, Dictate
// and Speech mode (the composer part VoiceButtons), are one child after the spacer, before the attach button, where core's fitWithTail puts them; where the
// row has no room they are two entries of the popup, after the insert entry (fitWithTail brings the "more" chip if the row had none).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { agentOpen, catalogFor, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { notConnectedLine, sendOff, showsServer, toolbarLine } from "@aiwb/core/logic/chatserver.ts";
import { CONTROLS, fitWithInsert, fitWithTail, widthKey, type Control, type Fit, type InsertPlace, type VoicePlace } from "@aiwb/core/logic/composerfit.ts";
import { moveChoice, pickerMode, withEffort, withModel, type Choice } from "@aiwb/core/logic/models.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { DEFAULT_SUB_CAP, DEFAULT_SUB_DEPTH, subChip, subChipLabel, subSettings } from "@aiwb/core/logic/subsettings.ts";
import { heldReason, pickOn } from "@aiwb/core/logic/waits.ts";
import { pickOnFork, setMoveChoice } from "@aiwb/core/state/actions.ts";
import { getState, shownBranch, shownView } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { Sized } from "../../platform/sized";
import { useZoom } from "../../platform/zoom";
import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { InsertIcon, Lock, MoreIcon } from "../../ui/icons.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useVoiceSession } from "../../voice/index.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { Pressable } from "react-native";
import { base, useWhere } from "../chat/hooks.ts";
import { AgentPick, AgentReason, ServerChip, useAgentChip, useServerChip } from "./ChatChoices.tsx";
import { ChipName, LockMark, MODEL_CAP, TChip } from "./Chip.tsx";
import { DirPicker } from "./Folder.tsx";
import { Measure, MeasureEpoch, MeasuringLayer, widths } from "./measure.tsx";
import { effortLabel, modelLabel, modelOf, subline } from "./model.ts";
import { Picker } from "./Picker.tsx";
import { useComposerParts } from "./parts.tsx";
import { ContextMeter } from "../usage/ContextMeter.tsx";
import { CtxError, CtxRing } from "../usage/CtxRing.tsx";
import { contextOf, ctxText } from "../usage/meter.ts";
import { roundDown } from "./widths.ts";

const MORE = widthKey("more"), INSERT = widthKey("insert"), VOICE = widthKey("voice"), ATTACH = widthKey("attach"), SEND = widthKey("send"), STOP = widthKey("stop");

/** What the toolbar draws after its spacer, from the composer: the attach button (K4's), Stop while the agent works, Send. */
export type Tail = { attach: ReactNode; stop: ReactNode; send: ReactNode };

export type ToolbarProps = {
  chatId: string;
  /** The branch the composer is of (voice's controls dictate and speak for it). */
  branch: string;
  onError(msg: string): void;
  /** Opens the insert popup for the box (⌘P in it does the same). */
  onInsert(): void;
  /** The composer sends a message. */
  sending: boolean;
  /** The row has Stop beside Send. */
  stop: boolean;
  tail: Tail;
  /** The key that opens the insert popup, for its title. */
  insertKey: string;
};

export function Toolbar({ chatId, ...p }: ToolbarProps) {
  const c = useStore((s) => shownView(s, chatId));
  return c ? <Tools c={c} chatId={chatId} {...p} /> : null;
}

function Tools({ c, chatId, branch, onError, onInsert, sending, stop, tail, insertKey }: ToolbarProps & { c: ChatView }) {
  const { tokens: t } = useTheme();
  const parts = useComposerParts();
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => catalogFor(s, serverOf(c), c.agent));
  const waits = useStore((s) => s.waits[chatId]);
  const pick = useStore((s) => pickOn(s.waits[chatId], shownBranch(s, chatId))); // the choice a fork's agent is being started on
  const held = heldReason(waits, "choice"); // why the model and the effort take no pick now
  // One open list at a time for Agent, Folder, Model, Effort and Subagents (the checks: C-CH-20).
  const [openPicker, setOpenPicker] = useState<Control | null>(null);
  const [patching, setPatching] = useState(false); // a fork's PATCH starts its agent again, which takes seconds
  const where = useWhere(c);
  // The chat is shown as it was, and takes no change: its server is not connected, or no longer has it. Every choice is then a fixed chip.
  const gone = useStore((s) => !!s.gone[chatId]);
  const frozen = sendOff(where) || gone;
  const usable = useStore((s) => usableAgents(s, where.server));
  const reason = (agentOpen(c) || frozen) && !!toolbarLine(where, usable, c, gone).text; // the line under the controls lets the row wrap
  const frozenWhy = gone ? goneText(where.name) : notConnectedLine(where.name);
  const serverKey = useServerChip(c), agentKey = useAgentChip(c);
  const [room, setRoom] = useState<{ w: number; gap: number } | null>(null);
  const [, setMeasured] = useState(0); // counts the widths kept: the fit is made again with them
  const [more, setMore] = useState(false); // the "more" popup is open
  const drawn = useRef<{ fit: Fit; more: boolean; insert: InsertPlace; voice: VoicePlace | "" } | null>(null); // where the last commit drew each control, the way to the insert popup and voice's pair, and whether the popup was open
  const moreChip = useRef<View>(null);
  const zoomNow = useZoom(); // a change of the screen's zoom drops the kept widths: the measuring layer is made anew
  const epoch = useRef({ zoom: zoomNow, n: 0 });
  if (epoch.current.zoom !== zoomNow) epoch.current = { zoom: zoomNow, n: epoch.current.n + 1 };
  const kept = () => setMeasured((n) => n + 1);

  const mode = pick || frozen ? "fixed" : pickerMode(c, !!move);
  const shown: Choice = mode === "move" ? moveChoice(move, c) : c;
  const fixed = pick ? { ...c, model: pick.model, effort: pick.effort } : c; // what the fixed chip names
  // choice: what the pick makes of the model and effort shown, as the server resolves it.
  const configure = (p: { model?: string; effort?: string }, choice: Choice) => {
    setPatching(true);
    const call: Promise<unknown> = c.fresh ? pickOnFork(chatId, p, choice, subline({ ...c, model: choice.model, effort: choice.effort }, cat)) : api.configure(chatId, shownBranch(getState(), chatId), p);
    return call.then(() => onError(""), (e) => onError(e.message)).finally(() => setPatching(false));
  };
  // A refusal's text was about the choice before this one.
  const setChoice = (ch: Choice) => { onError(""); setMoveChoice(chatId, ch); };
  const pickModel = (id: string) => { const ch = withModel(shown, id, cat); if (mode === "move") setChoice(ch); else void configure({ model: id }, ch); };
  const pickEffort = (id: string) => { const ch = withEffort(shown, id); if (mode === "move") setChoice(ch); else void configure({ effort: id }, ch); };
  const folderOpen = !frozen && (!c.locked || !!c.folderMissing);
  const agentPick = agentOpen(c) && !frozen;
  const m = modelOf(shown, cat);
  const choices = mode !== "fixed" && !!c.agent; // the model and the effort are choices, once their catalog is here
  const fixedTitle = frozen ? frozenWhy : c.fresh ? "Starting the agent on this model…" : "Model and effort are fixed once the chat has started";
  const u = contextOf(c, cat);

  // What the chat has, each with what decides its width.
  const keys: Partial<Record<Control, string>> = { folder: widthKey("folder", base(c.cwd) || "/", { fixed: !folderOpen, lock: !folderOpen }) };
  if (showsServer(where)) keys.server = serverKey;
  if (agentPick) keys.agent = agentKey;
  if (mode === "fixed") keys.model = widthKey("model", subline(fixed, cat), { fixed: true, lock: folderOpen });
  else if (choices && cat) keys.model = widthKey("model", modelLabel(shown, cat));
  else if (choices) keys.model = widthKey("model", "Loading models…", { fixed: true });
  if (choices && cat && m?.efforts?.length) keys.effort = widthKey("effort", effortLabel(shown.effort, m));
  const subsOf = subChip(c, !!move); // the subagent settings: a choice on a new chat alone, else fixed
  const subs = frozen && subsOf.kind === "open" ? { kind: "fixed" as const, why: frozenWhy } : subsOf;
  const limits = subSettings(c);
  keys.subagents = widthKey("subagents", subChipLabel(limits), { fixed: subs.kind === "fixed" });
  // Fixed and on the default settings, the chip tells what every chat had before there were any: it gives way to the others.
  const spare = subs.kind === "fixed" && limits.depth === DEFAULT_SUB_DEPTH && limits.cap === DEFAULT_SUB_CAP;
  // The meter with its text, and cut to its ring (the error meter: to its icon).
  const meterKey = u.error ? widthKey("meter", "Context unavailable", { fixed: true }) : widthKey("meter", ctxText(u.used, u.win));
  const ringKey = widthKey("meter", "", { fixed: !!u.error, mark: u.error ? "icon" : "ring" });
  const hasAttach = !!parts.AttachButton;
  const hasVoice = !!parts.VoiceButtons;
  const row = {
    room: room?.w ?? Infinity, gap: room?.gap ?? 0, more: widths.get(MORE),
    controls: CONTROLS.filter((id) => keys[id]).map((id) => ({ id, w: widths.get(keys[id]!), ...(id === "subagents" && spare ? { optional: true } : {}) })),
    meter: { full: widths.get(meterKey), ring: widths.get(ringKey) },
    fixed: [...(hasAttach ? [widths.get(ATTACH)] : []), ...(stop ? [widths.get(STOP)] : []), widths.get(SEND)],
    held: more ? drawn.current?.fit.popup ?? [] : null,
    // The Subagents popover stays open through a pick, which can make its chip longer: the others leave before it.
    pinned: openPicker === "subagents" && drawn.current?.fit.toolbar.includes("subagents") ? "subagents" as const : undefined,
  };
  const insertHeld = more && drawn.current?.insert === "more";
  const { fit: f, insert, voice: voicePlace } = hasVoice
    ? fitWithTail(row, { insert: widths.get(INSERT), voice: widths.get(VOICE) }, { insert: insertHeld, voice: more && drawn.current?.voice === "more" })
    : { ...fitWithInsert(row, widths.get(INSERT), insertHeld), voice: "" as const };
  // Voice is listening (or speaking) for this composer's chat: the "more" popup closes as it starts, and its chip says so while the pair is inside.
  // (not while it starts: a start that fails hangs its problem popover from the entry that was pressed)
  const voiceOn = useVoiceSession((s) => s.owner !== null && s.owner.kind !== "pill" && s.owner.chat === chatId && s.owner.branch === branch && s.phase !== "starting");
  const voiceOff = frozen ? frozenWhy : ""; // the composer cannot send now: neither control starts anything
  // A control that changes place has no open list: it is made anew where it goes, and its list would open there by itself, at once or, for
  // one that went into the popup, when the popup is opened next.
  const placeOf = (x: { fit: Fit; more: boolean }, id: Control) => (x.fit.toolbar.includes(id) ? "row" : x.fit.popup.includes(id) && x.more ? "popup" : "");
  const open = openPicker && drawn.current && (!placeOf({ fit: f, more }, openPicker) || placeOf(drawn.current, openPicker) !== placeOf({ fit: f, more }, openPicker)) ? null : openPicker;
  const opens = (id: Control) => ({ open: open === id, onOpenChange: (o: boolean) => setOpenPicker(o ? id : null) });

  useLayoutEffect(() => {
    drawn.current = { fit: f, more, insert, voice: voicePlace };
    if (open !== openPicker) setOpenPicker(null);
    if (more && !f.more) setMore(false); // nothing is left in it
  });
  useEffect(() => { if (voiceOn && voicePlace === "more") setMore(false); }, [voiceOn]);

  const chips: Record<Control, ReactNode> = {
    server: showsServer(where) ? <ServerChip c={c} /> : null,
    agent: agentPick ? <AgentPick c={c} disabled={patching || sending} {...opens("agent")} onBusy={setPatching} onError={onError} /> : null,
    folder: <>
      {!folderOpen && <LockMark />}
      <DirPicker cwd={c.cwd} missing={c.folderMissing} locked={!folderOpen} server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })} {...opens("folder")} />
    </>,
    model: mode === "fixed" ? (
      <TChip kind="model" title={fixedTitle}>
        {folderOpen && <Lock color={t.muted} />}<ChipName muted full={`${subline(fixed, cat)} — ${fixedTitle}`}>{subline(fixed, cat)}</ChipName>
      </TChip>
    ) : !c.agent ? null : !cat ? (
      <TChip kind="model" title="Loading models…"><ChipName muted>Loading models…</ChipName></TChip>
    ) : (
      <Picker kind="model" label={modelLabel(shown, cat)} title="Model" value={shown.model} searchable cap={MODEL_CAP} disabled={patching || sending || !!held} hint={held || undefined}
        options={cat.models} {...opens("model")} onPick={pickModel} />
    ),
    effort: choices && !!cat && !!m?.efforts?.length ? (
      <Picker kind="effort" label={effortLabel(shown.effort, m)} title="Effort" prefix="Effort" value={shown.effort ?? ""} disabled={patching || sending || !!held} hint={held || undefined}
        options={m.efforts.map((e) => ({ id: e, label: effortLabel(e, m) }))} {...opens("effort")} onPick={pickEffort} />
    ) : null,
    subagents: <parts.SubagentsChip c={c} fixed={subs.kind === "fixed" ? subs.why : ""} disabled={patching || sending || !!held} {...opens("subagents")} onBusy={setPatching} onError={onError} />,
  };
  // The meter in the row is S9's (its popup is the one the row's press opens); what is measured in the hidden layer is its ring alone, drawn the same
  // (a button of the same box) under a testID of its own, so that the page has one `ctx-meter`.
  const meter = (compact: boolean) => <ContextMeter chat={chatId} compact={compact} />;
  const measured = (compact: boolean) => (u.error ? <CtxError reason={u.error} ringOnly={compact} testID="ctx-meter-measure" /> : <CtxRing used={u.used} win={u.win} ringOnly={compact} onPress={() => {}} testID="ctx-meter-measure" />);
  const unknown = CONTROLS.filter((id) => keys[id] && chips[id] !== null && widths.get(keys[id]!) === undefined);
  const insertButton = (
    <IconButton {...tid("insert-btn")} title={`Insert a prompt (${insertKey})`} disabled={frozen} keepFocus aria-haspopup="dialog" onPress={onInsert}>
      {(colour) => <InsertIcon color={colour} />}
    </IconButton>
  );

  return (
    <MeasureEpoch.Provider value={epoch.current.n}>
    <View style={styles.wrap}>
      <Sized {...tid("composer-tools", { more: f.more, meter: f.meter, insert, voice: voicePlace })} style={[styles.row, { flexWrap: reason ? "wrap" : "nowrap" }]}
        onWidth={(width) => { const w = roundDown(width); setRoom((r) => (r && r.w === w ? r : { w, gap: 4 })); }}>
        {f.toolbar.filter((id) => keys[id] && widths.get(keys[id]!) !== undefined).map((id) => <View key={id} style={styles.control} {...tid("tool", { control: id })}>{chips[id]}</View>)}
        {f.more ? (
          <Measure k={MORE} onKept={kept} part="more">
            <TChip kind="more" testID="more-chip" square chipRef={moreChip} expanded={more} popup="dialog"
              title={`More: ${[...f.popup, ...(insert === "more" ? ["insert a prompt"] : []), ...(voicePlace === "more" ? ["dictate", "speech mode"] : [])].join(", ")}`} onPress={() => setMore(!more)}>
              <MoreIcon color={voiceOn && voicePlace === "more" ? t.accent : t.muted} />
            </TChip>
          </Measure>
        ) : null}
        <Measure k={f.meter === "ring" ? ringKey : meterKey} onKept={kept} part="meter">{meter(f.meter === "ring")}</Measure>
        <View {...tid("tool-grow")} style={styles.grow} />
        {insert === "row" ? <Measure k={INSERT} onKept={kept} part="insert">{insertButton}</Measure> : null}
        {voicePlace === "row" && parts.VoiceButtons ? <Measure k={VOICE} onKept={kept} part="voice"><parts.VoiceButtons chatId={chatId} branch={branch} place="row" disabled={voiceOff} /></Measure> : null}
        {hasAttach ? <Measure k={ATTACH} onKept={kept} part="attach">{tail.attach}</Measure> : null}
        {stop ? <Measure k={STOP} onKept={kept} part="stop">{tail.stop}</Measure> : null}
        <Measure k={SEND} onKept={kept} part="send">{tail.send}</Measure>
        {reason ? <AgentReason c={c} /> : null}
      </Sized>

      {/* the controls whose width is not kept yet are measured here, out of sight, and drawn in the row once they are */}
      <MeasuringLayer key={epoch.current.n}>
        {unknown.map((id) => <Measure key={id} k={keys[id]!} onKept={kept}>{chips[id]}</Measure>)}
        {/* (what the row draws whatever the fit, and what the fit may need next, is measured together with the controls: one round of
            measuring, so the fit is never made with only some of the widths, whatever the order the layouts are reported in) */}
        {widths.get(MORE) === undefined ? <Measure k={MORE} onKept={kept}><TChip kind="more" square title="More" onPress={() => {}}><MoreIcon color={t.muted} /></TChip></Measure> : null}
        {widths.get(INSERT) === undefined ? <Measure k={INSERT} onKept={kept}>{insertButton}</Measure> : null}
        {parts.VoiceButtons && widths.get(VOICE) === undefined ? <Measure k={VOICE} onKept={kept}><parts.VoiceButtons chatId={chatId} branch={branch} place="row" disabled={voiceOff} /></Measure> : null}
        {widths.get(meterKey) === undefined ? <Measure k={meterKey} onKept={kept}>{measured(false)}</Measure> : null}
        {widths.get(ringKey) === undefined ? <Measure k={ringKey} onKept={kept}>{measured(true)}</Measure> : null}
        {widths.get(SEND) === undefined ? <Measure k={SEND} onKept={kept}>{tail.send}</Measure> : null}
        {stop && widths.get(STOP) === undefined ? <Measure k={STOP} onKept={kept}>{tail.stop}</Measure> : null}
        {hasAttach && widths.get(ATTACH) === undefined ? <Measure k={ATTACH} onKept={kept}>{tail.attach}</Measure> : null}
      </MeasuringLayer>

      <Overlay open={more && f.more} onClose={() => { setMore(false); setOpenPicker(null); (moreChip.current as unknown as { focus?: () => void } | null)?.focus?.(); }}
        label="More of the toolbar" kind="popover" anchor={moreChip} up testID="more-pop">
        <View style={styles.popup}>
          {/* (a chip here is not re-measured in place: a pick changes its label, which must not draw it anew and take its focus; the
              measuring layer has the width of the new label) */}
          {f.popup.map((id) => <View key={id} {...tid("more-row", { control: id })} style={styles.moreRow}>
            <View style={styles.control}>{chips[id]}</View>
          </View>)}
          {insert === "more" ? (
            <View {...tid("more-row", { control: "insert" })} style={styles.moreRow}>
              <MoreInsert keyName={insertKey} disabled={frozen} onPress={() => { setMore(false); onInsert(); }} />
            </View>
          ) : null}
          {voicePlace === "more" && parts.VoiceButtons ? <parts.VoiceButtons chatId={chatId} branch={branch} place="more" disabled={voiceOff} /> : null}
        </View>
      </Overlay>
    </View>
    </MeasureEpoch.Provider>
  );
}

/** The entry of the insert popup in the "more" popup, where the row has no room for the button: as tall as a chip, and no chip. */
function MoreInsert({ keyName, disabled, onPress }: { keyName: string; disabled: boolean; onPress(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(`Insert a prompt (${keyName})`);
  return (
    <Pressable ref={ref} {...tid("more-insert")} role="button" aria-haspopup="dialog" disabled={disabled} accessibilityLabel="Insert a prompt"
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.moreInsert, { backgroundColor: t.panel, borderColor: hovered ? t.line2 : "transparent" }, disabled && styles.dim, webStyle({ cursor: "pointer" })]}>
      <InsertIcon color={t.muted} />
      <Text size={12}>Insert a prompt</Text>
      <Text size={12} tone="faint" style={styles.keyName}>{keyName}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative", alignSelf: "stretch" },
  row: { flexDirection: "row", alignItems: "center", columnGap: 4, rowGap: 0, marginTop: 4, alignSelf: "stretch" },
  control: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  popup: { alignItems: "flex-start", gap: 4, padding: 2 },
  moreRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  moreInsert: { flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 8, borderWidth: 1, borderRadius: 6 },
  keyName: { marginLeft: 4 },
  dim: { opacity: 0.35 },
});
