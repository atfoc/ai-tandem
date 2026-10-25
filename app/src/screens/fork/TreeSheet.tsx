// The chat tree on the phone (ux-improvements goal 3.5, "Branches and the tree"): a full-height sheet instead of the dialog. Its head says "Chat tree" with
// the chat's name and branch count and has Done; under it a 32 pt Messages / Labeled filter and the search field stay put while the 48 pt rows scroll. One tap
// on a row opens the chat there (what the dialog's second press does) and closes the sheet. Press and hold opens the row's actions (a P1 sheet: the fork and
// branch actions, Label…), and Label… a form (P3). There is one sheet at a time: while the actions or the form are open the tree is not drawn; it keeps its
// state (the filter, the search, the place in the list) and comes back when they close without an action. What the tree shows and does is the dialog's
// (useTreeNav.ts); only the shape differs. The wide layouts keep the dialog (TreePopup.tsx).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, type TextStyle } from "react-native";

import { agentClass, agentShortName } from "@aiwb/core/agents.ts";
import { FILTERS, nameOfBranch, preview, type Entry, type ForkLink, type Row } from "@aiwb/core/logic/forktree.ts";
import { chatBusy } from "@aiwb/core/logic/status.ts";
import { menuItems, stoppable, type MarkOf, type MenuItem as TreeItem, type RowMark } from "@aiwb/core/logic/treepopup.ts";
import { heldReason } from "@aiwb/core/logic/waits.ts";
import { closeTree } from "@aiwb/core/state/actions.ts";
import { chatTitle } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { haptic } from "../../platform/haptics";
import { ActionSheet, type ActionItem } from "../../ui/ActionSheet.tsx";
import { FormSheet } from "../../ui/FormSheet.tsx";
import { AgentGlyph, BranchIcon, Pencil } from "../../ui/icons.tsx";
import { LONG_PRESS_MS, PHONE, DRAG_SLOP, TYPE } from "../../ui/metrics.ts";
import { SearchField } from "../../ui/SearchField.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { TREE_POPUP_ID, TREE_TID } from "./ids.ts";
import { LABEL_MAX, LABEL_PLACEHOLDER } from "./LabelInput.tsx";
import { inGrace, holdEnded } from "../quotes/sheetstore.ts";
import { forkWords } from "./msgsheet.ts";
import { Gutter, markColour } from "./TreeGutter.tsx";
import { BUSY_FORK, filterWords, headSub, labelCount, markText, rowSheetSub, stopTitle } from "./treemodel.ts";
import { useTreeNav, type Nav } from "./useTreeNav.ts";

/** The width of a level's cell in the tree lines (the dialog's is 16): a little longer for 48 pt rows. */
const CELL = 26;
/** The glyph's column: "YOU" or the agent's mark. */
const GLYPH = 30;
/** Where the picked row is put when the sheet opens: this far under the top of the list. */
const LEAD = 60;

/** What the sheet has stepped aside for: a row's actions, or its Label form. */
type Aside = { kind: "acts" | "label"; id: string } | null;

export function TreeSheet({ nav }: { nav: Nav }) {
  const tn = useTreeNav(nav, null);
  const t = useTokens();
  const { c, tree, list, links, chats, loading, err, filter, setFilter, query, setQuery } = tn;
  const [aside, setAside] = useState<Aside>(null);
  const picked = useRef<"label" | "done" | null>(null); // what the actions sheet that is closing did: Label… goes on to the form, any other action closes everything
  const place = useRef<ScrollView | null>(null);
  const at = useRef(0); // where the list is scrolled to
  const restore = useRef<number | "start" | null>("start"); // what the list is put back to once it has its rows: the picked row on opening, the place it was left at after a step aside
  const tops = useRef<Record<string, number>>({});
  const laid = useRef(new Set<string>());

  // The rows are put in place once all of them are laid out (a row's top is known by then); the sheet's list is the kit Sheet's own scroll view.
  const rowLaid = (id: string) => (e: LayoutChangeEvent) => {
    tops.current[id] = e.nativeEvent.layout.y;
    laid.current.add(id);
    if (restore.current === null || !list.length || laid.current.size < list.length) return;
    const y = restore.current === "start" ? (tn.selId !== null && tops.current[tn.selId] !== undefined ? Math.max(0, tops.current[tn.selId] - LEAD) : 0) : restore.current;
    restore.current = null;
    requestAnimationFrame(() => place.current?.scrollTo({ y, animated: false }));
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => { at.current = e.nativeEvent.contentOffset.y; };

  const labels = useMemo(() => (tree ? labelCount(tree.entries) : 0), [tree]);
  if (!c) return null;
  const e = aside && tree ? tree.entries[aside.id] : undefined;

  const hold = (id: string) => { haptic("select"); holdEnded(); setAside({ kind: "acts", id }); };
  // The sheet comes back: its rows are drawn again, and the list goes back to where it was left.
  const back = () => { laid.current.clear(); restore.current = at.current; setAside(null); };
  // (the finger that held the row may still be down when the sheet opens, and its lifting may click the dimmed page: that closes nothing, as with the message's sheet)
  const afterActions = () => {
    const k = picked.current;
    if (!k && inGrace()) return;
    picked.current = null;
    if (k === "label" && aside) setAside({ kind: "label", id: aside.id }); else back();
  };

  const head = (
    <>
      <SheetHead title="Chat tree" subTestID="fk-nav-sub" sub={headSub(chatTitle(c, tn.items), tn.branches, links.length)} right={{ label: "Done", strong: true, onPress: closeTree, testID: TREE_TID.done }} />
      <View {...tid("fk-filters")} style={[styles.filters, { backgroundColor: t.panel, borderColor: t.line }]}>
        {FILTERS.map((f) => (
          <Pressable key={f.id} {...tid("fk-filter", { id: f.id, on: filter === f.id })} role="button" accessibilityState={{ selected: filter === f.id }} onPress={() => setFilter(f.id)}
            hitSlop={{ top: (PHONE.target - SEGMENT) / 2, bottom: (PHONE.target - SEGMENT) / 2 }}
            style={[styles.filter, filter === f.id && { backgroundColor: t.bg, borderColor: t.line2 }]}>
            <Text size={TYPE.secondary + 2} weight={filter === f.id ? "600" : undefined} tone={filter === f.id ? "text" : "muted"}>{filterWords(f.id, labels)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.search}><SearchField testID="fk-search" value={query} onChangeText={setQuery} placeholder="Search this chat" /></View>
      <View style={[styles.sep, { backgroundColor: t.line }]} />
    </>
  );

  return (
    <>
      <Sheet open={!aside} onClose={closeTree} label="Chat tree" testID={TREE_POPUP_ID} detent="large" head={head} scrollRef={place} onScroll={onScroll}>
        <View {...tid("fk-nav", { agent: agentClass(c.agent) })}>
          <View {...tid("fk-rows")} style={styles.rows}>
            {!tree ? (err && !loading
              ? <Text {...tid("fk-none", { kind: "error" })} size={TYPE.body} tone="danger" style={styles.none}>Couldn't load the chat tree: {err}{" "}<Text {...tid("fk-retry")} tone="accent" accessibilityRole="link" onPress={tn.retry}>Retry</Text></Text>
              : <Text {...tid("fk-none", { kind: "loading" })} size={TYPE.body} tone="muted" style={styles.none}>Loading…</Text>)
              : !list.length && <Text {...tid("fk-none", { kind: "empty" })} size={TYPE.body} tone="muted" style={styles.none}>{tree.order.length ? "Nothing matches." : "No messages yet."}</Text>}
            {tree && list.map((r, i) => {
              if (r.link) {
                const l = r.link;
                return (
                  <Fragment key={r.id}>
                    {l.where === "loose" && list[i - 1]?.link?.where !== "loose" && <LooseHead />}
                    <LinkRow r={r} l={l} fork={chats[l.chat]} onLaid={rowLaid(r.id)} onOpen={() => tn.openFork(l)} />
                  </Fragment>
                );
              }
              const en = tree.entries[r.id];
              return (
                <RowView key={r.id} r={r} e={en} on={r.id === tn.selId} agent={c.agent} mark={tn.off ? null : tn.marks[r.id] ?? null} note={tn.notes[r.id]} end={tn.ends[r.id]}
                  held={tn.noOpen} onStop={tn.stop} onLaid={rowLaid(r.id)} onOpen={() => tn.open(r.id)} onHold={() => hold(r.id)} />
              );
            })}
          </View>
        </View>
      </Sheet>
      {aside?.kind === "acts" && tree && e && (
        <RowActions tn={tn} e={e} onPick={(a) => { picked.current = a.id === "label" ? "label" : "done"; if (a.id !== "label" && a.id !== "note") tn.perform(e, a); }} onClose={afterActions} />
      )}
      {aside?.kind === "label" && e && <LabelForm e={e} onSave={(v) => tn.label(e, v)} onClose={back} />}
    </>
  );
}

/** A row's hold: the browser's touches (a check's, a phone's) start a timer as the message hold does (screens/quotes/hold.ts: plain touch handlers, so that the
 *  list still scrolls under the finger and a finger that moves, lifts or is joined by another cancels); the native press and a mouse use the Pressable's own long
 *  press. Whichever fires first holds the row once, and the tap that ends the hold opens nothing. */
function useRowHold(onHold: () => void) {
  const fired = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const stop = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => stop, []);
  const fire = () => { stop(); if (fired.current) return; fired.current = true; onHold(); };
  const point = (ev: GestureResponderEvent) => { const n = ev.nativeEvent, p = n.touches?.[0] ?? n; return { x: p.pageX, y: p.pageY }; };
  const web = Platform.OS === "web" ? {
    onTouchStart: (ev: GestureResponderEvent) => {
      stop(); fired.current = false;
      if ((ev.nativeEvent.touches?.length ?? 1) > 1) return;
      from.current = point(ev);
      timer.current = setTimeout(fire, LONG_PRESS_MS);
    },
    onTouchMove: (ev: GestureResponderEvent) => { const p = point(ev); if (Math.hypot(p.x - from.current.x, p.y - from.current.y) > DRAG_SLOP) stop(); },
    onTouchEnd: () => { stop(); holdEnded(); },
    onTouchCancel: () => { stop(); holdEnded(); },
  } : {};
  return {
    wrap: web,
    // a tap that ends a hold is no tap
    tap: (open: () => void) => () => { if (fired.current) { fired.current = false; return; } open(); },
    longPress: fire,
    pressIn: () => { fired.current = false; },
  };
}

const AGENT_COLUMN = { width: GLYPH, alignItems: "center", justifyContent: "center" } as const;

/** One message of the tree: 48 pt, its guides, "YOU" or the agent's glyph, its words, and at the end what the row is (where the chat is, the end of a branch, a label,
 *  what the branch is doing). A tap opens the chat there; a hold opens the row's actions. held: why opening does nothing now ("" when it does): the row's text is marked as
 *  disabled, and the actions sheet says why. */
function RowView({ r, e, on, agent, mark, note, end, held, onStop, onLaid, onOpen, onHold }: {
  r: Row; e: Entry; on: boolean; agent: string; mark: MarkOf | null; note?: string; end?: string; held: string;
  onStop: (branch: string) => void; onLaid: (e: LayoutChangeEvent) => void; onOpen: () => void; onHold: () => void;
}) {
  const t = useTokens();
  const kind = e.item.kind;
  const m = mark && markText(mark);
  const gesture = useRowHold(onHold);
  const data = { kind, end, on, path: r.onPath, held: !!held, mark: mark?.mark };
  return (
    <View {...gesture.wrap} style={styles.holdable}>
      <Pressable {...tid("fk-row", data)} onLayout={onLaid} onPress={gesture.tap(onOpen)} onPressIn={gesture.pressIn} onLongPress={gesture.longPress} delayLongPress={LONG_PRESS_MS}
        {...({ onContextMenu: (ev: { preventDefault(): void }) => { ev.preventDefault(); gesture.longPress(); } } as object)}
        accessibilityLabel={`${kind === "user" ? "You" : agentShortName(agent)}: ${preview(e.item.text, 110)}${r.isLeaf ? ". You are here" : ""}`} accessibilityHint="Press and hold for more"
        accessibilityState={{ selected: on }} aria-selected={on}
        style={[styles.row, r.isLeaf && { backgroundColor: t.accentSoft }]}>
        <Gutter g={r.gutter} cell={CELL} />
        <View style={AGENT_COLUMN}>{kind === "user" ? <Text size={TYPE.secondary} weight="700" tone="accent" style={styles.you}>you</Text> : <AgentGlyph agent={agent} size={14} />}</View>
        <Text {...tid("fk-text")} numberOfLines={1} size={TYPE.body} tone={r.onPath ? "text" : "muted"} weight={r.onPath ? "500" : undefined} style={styles.text}
          aria-disabled={held ? true : undefined}>{preview(e.item.text, 110)}</Text>
        {e.label ? <View {...tid("fk-tag")} style={[styles.tag, { backgroundColor: t.accentSoft }]}><Text size={TYPE.secondary} weight="600" tone="accent" numberOfLines={1}>{`⚑ ${e.label}`}</Text></View> : null}
        {note ? <Text {...tid("fk-model")} size={TYPE.secondary} tone="faint" numberOfLines={1} style={styles.note}>{note}</Text> : null}
        {m && mark ? (
          <View {...tid("fk-mark", { mark: mark.mark })} style={styles.mark}>
            <View style={[styles.markDot, { backgroundColor: markColour(t, mark.mark) }]} />
            <Text size={TYPE.secondary} weight="600" style={{ color: markColour(t, mark.mark) }} accessibilityHint={m.title}>{m.text}</Text>
          </View>
        ) : null}
        {mark && stoppable(mark.mark) ? (
          <Pressable {...tid("fk-stop")} role="button" accessibilityLabel={stopTitle(mark)} onPress={() => onStop(mark.branch)} style={styles.stop}>
            <View style={[styles.stopBox, { borderColor: t.line2, backgroundColor: t.bg }]}><Text size={TYPE.secondary} weight="600">Stop</Text></View>
          </Pressable>
        ) : null}
        {r.isLeaf
          ? <View {...tid("fk-here")} style={[styles.here, { backgroundColor: t.accentFill }]}><Text size={TYPE.secondary} weight="600" tone="onAccent">You are here</Text></View>
          : r.isTip ? <Text {...tid("fk-end")} size={TYPE.secondary} tone="faint" style={styles.endWord}>end</Text> : null}
      </Pressable>
    </View>
  );
}

/** A chat forked from this one: a link to it, with what that chat is doing. fork: its view, absent once it is deleted. */
function LinkRow({ r, l, fork, onLaid, onOpen }: { r: Row; l: ForkLink; fork: ChatView | undefined; onLaid: (e: LayoutChangeEvent) => void; onOpen: () => void }) {
  const t = useTokens();
  const mark: RowMark | null = !fork ? null : (fork.approvals ?? 0) > 0 || fork.status === "approval" ? "approval" : chatBusy(fork) ? "running" : null;
  return (
    <Pressable {...tid("fk-row", { kind: "fork", archived: l.archived, mark: mark ?? undefined })} onLayout={onLaid} onPress={onOpen} role="link" accessibilityLabel={`Open the fork “${l.title}”`} style={styles.row}>
      <Gutter g={r.gutter} cell={CELL} />
      <View style={AGENT_COLUMN}><BranchIcon size={14} color={t.muted} /></View>
      <Text {...tid("fk-fork-link")} numberOfLines={1} size={TYPE.body} tone={l.archived ? "muted" : "accent"} style={styles.text}>{l.title}</Text>
      {mark ? <View {...tid("fk-mark", { mark })} style={styles.mark}><View style={[styles.markDot, { backgroundColor: markColour(t, mark) }]} /><Text size={TYPE.secondary} weight="600" style={{ color: markColour(t, mark) }}>{mark === "approval" ? "needs approval" : "working"}</Text></View> : null}
      {l.archived ? <Text {...tid("fk-end")} size={TYPE.secondary} tone="faint" style={styles.endWord}>archived</Text> : null}
    </Pressable>
  );
}

function LooseHead() {
  const t = useTokens();
  return <View style={[styles.looseHead, { borderTopColor: t.line }]}><Text {...tid("fk-loose-head")} size={TYPE.secondary} tone="muted">Forks made before fork points were recorded</Text></View>;
}

/** A held row's actions (P1): the message as the title, "Your message · <branch>" under it; Branch and edit, Fork and edit, Fork to new chat and Label… as the
 *  menu's items say them. What a wait of the chat holds is faded, with its reason; a chat shown as it was has them all faded, with the reason it takes no call
 *  (the dialog's foot says it there). The note a reply partway through a turn has (no fork there) is the note of its Label row. */
function RowActions({ tn, e, onPick, onClose }: { tn: ReturnType<typeof useTreeNav>; e: Entry; onPick: (a: TreeItem) => void; onClose: () => void }) {
  const t = useTokens();
  const { tree, c } = tn;
  if (!tree || !c) return null;
  const acts = menuItems(tree, e.id, { busy: tn.busy, readOnly: tn.readOnly && !tn.off });
  const noteOf = acts.find((a) => a.id === "note")?.label;
  const user = e.item.kind === "user";
  const items: ActionItem[] = acts.flatMap((a): ActionItem[] => {
    if (a.id === "note") return [];
    const label = a.id === "label", why = tn.off || (label ? "" : a.disabled ? BUSY_FORK : heldReason(tn.waits, a.id, tn.on));
    const w = forkWords({ id: a.id });
    const faint = why ? t.faint : t.muted;
    const icon: ReactNode = a.id === "branchEdit" ? <Pencil size={16} color={faint} />
      : label ? <Text size={TYPE.control} style={{ color: faint }}>⚑</Text>
      : <Text size={TYPE.control} style={{ color: faint }}>⊕</Text>;
    return [{ id: a.id, label: label && e.label ? "Relabel…" : w.label, note: label && noteOf ? noteOf : w.note, icon, waitReason: why || undefined, onPress: () => onPick(a) }];
  });
  if (!items.length) return null;
  return <ActionSheet open onClose={onClose} testID={TREE_TID.rowSheet} head={{ title: preview(e.item.text, 80), sub: rowSheetSub(user, agentShortName(c.agent), nameOfBranch(tree, e.branch)) }} items={items} />;
}

/** The Label form of a row (P3): the field holds the current label, Save is off while it is unchanged; an empty label removes it. Return saves. */
function LabelForm({ e, onSave, onClose }: { e: Entry; onSave: (v: string) => void; onClose: () => void }) {
  const t = useTokens();
  const [v, setV] = useState(e.label ?? "");
  const word = v.trim(), changed = word !== (e.label ?? "");
  const save = () => { if (changed) onSave(word); onClose(); };
  return (
    <FormSheet open onClose={onClose} testID={TREE_TID.labelForm} title="Label" sub={preview(e.item.text, 80)} canSave={changed} dirty={changed} onSave={() => onSave(word)}>
      <View style={styles.field}>
        <TextInput autoFocus {...tid(TREE_TID.labelInput)} value={v} maxLength={LABEL_MAX} placeholder={LABEL_PLACEHOLDER} placeholderTextColor={t.faint} accessibilityLabel="Label"
          returnKeyType="done" blurOnSubmit onChangeText={setV} onSubmitEditing={save}
          style={[styles.input, { color: t.text, backgroundColor: t.panel, borderColor: t.line2 }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
      </View>
    </FormSheet>
  );
}

/** A segment of the 32 pt filter: the track's border (1) and padding (2) leave it 26 pt; its hit slop makes the target 44 pt (goal 3.1.1),
 *  inside the 8 pt above and below the track. */
const SEGMENT = 26;

const styles = StyleSheet.create({
  // (the sheet's own side padding is 8: the filter and the search sit 16 from the screen's edge)
  filters: { flexDirection: "row", height: 32, padding: 2, marginHorizontal: PHONE.margin - 8, marginTop: 8, marginBottom: 8, borderRadius: 9, borderWidth: 1 },
  filter: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: "transparent" },
  search: { marginHorizontal: -8 },
  sep: { height: StyleSheet.hairlineWidth, marginTop: 8, marginHorizontal: -8 },
  rows: { paddingTop: 6 },
  none: { padding: 20, textAlign: "center" },
  holdable: { ...(webStyle({ userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }) as object) },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: PHONE.cell, marginHorizontal: 2, paddingHorizontal: 12, borderRadius: 10, ...(webStyle({ cursor: "pointer" }) as object) },
  you: { textTransform: "uppercase", letterSpacing: 0.3 },
  text: { flex: 1, minWidth: 0 },
  tag: { flexShrink: 1, maxWidth: "45%", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  note: { flexShrink: 1, maxWidth: "30%" },
  mark: { flexDirection: "row", alignItems: "center", gap: 5 },
  markDot: { width: 7, height: 7, borderRadius: 4 },
  stop: { minWidth: PHONE.target, minHeight: PHONE.target, alignItems: "center", justifyContent: "center" },
  stopBox: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  here: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 3 },
  endWord: { paddingLeft: 4 },
  looseHead: { marginTop: 6, paddingTop: 10, paddingBottom: 4, paddingHorizontal: 14, borderTopWidth: 1 },
  field: { paddingHorizontal: PHONE.margin - 8, paddingTop: 16 },
  input: { minHeight: PHONE.target, fontSize: TYPE.control, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
});
