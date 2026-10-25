// The tree popup (the old page's fork/TreePopup.tsx; B-TR-01 to B-TR-26): a chat's branches as one tree, shown while the store's `treeNav` is set. It is
// mounted always (the shell's `Overlays` slot) and shows itself from the store, as a dialog on the wide layouts (this file) and, on the phone, as the full-height
// sheet of TreeSheet.tsx (ux-improvements goal 3.5), which shares the tree's state and rules with the dialog (useTreeNav.ts).
// A press picks a row; two presses (a mouse) or a press on the row already picked (a finger) open the chat there; a right click or a long press has the
// rest, as a menu (a finger has a "⋯" at the row's end for it, and a long press). The row a branch ends at says what the branch is doing and has its Stop; a chat forked from this one is a link in the tree.
// What a wait of the chat holds (logic/waits.ts heldReason) is drawn disabled and says why: opening a row and "Branch and edit" while a message that
// starts a new branch is on its way, the two forks while a fork is being made. Label, Stop and a fork's link stay live. The tree of a chat shown as it
// was (useOffWhy) is to be read only: no row opens, nothing branches, forks, is labelled or stopped, no branch shows a live mark, and the foot says why.
//
// Esc closes the row menu first (it is the overlay on top), then clears the search, then closes the popup; in the label field it cancels the label. The
// overlay stack gives Esc to the top one only (ui/overlaystack.ts): a confirm dialog above the popup has it first. A press on the dimmed page, and
// Android's back, close the popup outright.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, type LayoutChangeEvent, type TextStyle } from "react-native";

import { agentClass } from "@aiwb/core/agents.ts";
import { FILTERS, preview, type Entry, type Filter, type ForkLink, type Row } from "@aiwb/core/logic/forktree.ts";
import { chatBusy } from "@aiwb/core/logic/status.ts";
import { escStep, isTreeKey, menuItems, stoppable, type MarkOf, type MenuItem as TreeItem, type RowMark } from "@aiwb/core/logic/treepopup.ts";
import { heldReason } from "@aiwb/core/logic/waits.ts";
import { closeTree, openTree } from "@aiwb/core/state/actions.ts";
import { chatTitle, getState } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { onKey } from "../../platform/keys";
import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { AgentGlyph, BranchIcon, MoreIcon } from "../../ui/icons.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { useOverlayKind } from "../../ui/overlaykind.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { usePhone } from "../../ui/useLayout.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { TREE_POPUP_ID } from "./ids.ts";
import { LabelInput } from "./LabelInput.tsx";
import { Gutter, markColour } from "./TreeGutter.tsx";
import { TreeFolderHint } from "./FolderHint.tsx";
import { TreeSheet } from "./TreeSheet.tsx";
import { BUSY_FORK, footText, headSub, markText, opensOn, stopTitle } from "./treemodel.ts";
import { useTreeNav, type Nav } from "./useTreeNav.ts";

export { TREE_POPUP_ID };

// Whether Esc was just pressed: the overlay's close does not say what asked for it (Esc, the dimmed page, the back button), and only Esc takes the
// popup's steps. The key port's handler runs before the overlay's own listener (it is registered when the app starts).
let escAt = -1e9;

export function TreePopup() {
  const nav = useStore((s) => s.treeNav);
  const phone = usePhone();
  // ⌘⇧B / Ctrl+Shift+B toggles the popup, from anywhere but the label field, which would lose its text half typed.
  useEffect(() => onKey((e) => {
    if (e.key === "Escape") { escAt = Date.now(); return; }
    if (!isTreeKey(e)) return;
    const s = getState();
    if (!s.treeNav && !s.sel.chat) return;
    if (labelFocused()) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    if (s.treeNav) closeTree(); else openTree(s.sel.chat!);
  }), []);
  if (!nav) return null;
  const key = `${nav.chat}:${nav.focus ? `${nav.focus.branch}:${nav.focus.item}` : ""}`;
  // the phone has the tree as a full-height sheet of its own (TreeSheet.tsx); the wide layouts keep the dialog
  return phone ? <TreeSheet key={key} nav={nav} /> : <Navigator key={key} nav={nav} />;
}

/** Whether the label field has the focus (web: the document's active element; native has no key to take). */
function labelFocused(): boolean {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  return !!el && el.getAttribute?.("data-testid") === "fk-label-input";
}

function Navigator({ nav }: { nav: Nav }) {
  const [picked, setPicked] = useState<string | null>(null);
  const tn = useTreeNav(nav, picked);
  const { c, items, tree, list, links, marks, notes, ends, selId, busy, waits, on, chats, off, readOnly, noOpen, branches: n, loading, err, filter, setFilter, query, setQuery } = tn;
  const pointer = usePointer(), t = useTokens();
  const [menu, setMenu] = useState<string | null>(null); // the row whose menu is open
  const [labeling, setLabeling] = useState<string | null>(null);
  const last = useRef<{ row: string; at: number } | null>(null); // the row pressed last: a second press on it is the double click
  const search = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);
  const rowRefs = useRef<Record<string, View | null>>({});
  const tops = useRef<Record<string, number>>({});

  // the picked row is scrolled into view: the popup opens on it (B-TR-07)
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!selId || scrolled.current === selId || tops.current[selId] === undefined) return;
    scrolled.current = selId;
    scroll.current?.scrollTo({ y: Math.max(0, tops.current[selId] - 60), animated: false });
  }, [selId, list]);
  const rowLaid = (id: string) => (e: LayoutChangeEvent) => {
    tops.current[id] = e.nativeEvent.layout.y;
    if (id === selId && scrolled.current !== id) { scrolled.current = id; scroll.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 60), animated: false }); }
  };

  if (!c) return null;

  // The popup's close: Esc takes its steps (the label being typed, then the search; the row menu is an overlay of its own, on top, and answers for itself),
  // everything else closes it.
  const close = () => {
    if (Date.now() - escAt < 100) {
      const step = escStep({ dialog: !!getState().confirm, labeling: labeling !== null, menu: false, query });
      if (step === "none") return;
      if (labeling !== null) { setLabeling(null); return; }
      if (step === "search") { setQuery(""); return; }
    }
    closeTree();
  };

  const run = (e: Entry, a: TreeItem) => {
    setMenu(null);
    if (a.id === "note" || off) return;
    if (a.id === "label") { setLabeling(e.id); return; }
    tn.perform(e, a);
  };
  const doneLabel = (e: Entry, v: string | null) => {
    tn.label(e, v);
    setLabeling(null);
  };
  // a press: picks the row; the second one (a mouse) or one on the picked row (a finger) opens it
  const press = (id: string, openIt: () => void) => {
    const now = Date.now();
    const again = opensOn(pointer, id, { picked: selId, last: last.current, now });
    last.current = { row: id, at: now };
    setPicked(id);
    if (again) openIt();
  };
  const menuRow = (id: string) => {
    setPicked(id);
    if (!off && tree && menuItems(tree, id, { busy, readOnly }).length) setMenu(id);
  };
  const acts = menu && tree && !off ? menuItems(tree, menu, { busy, readOnly }) : [];
  const foot = footText({ pointer, off, readOnly, held: noOpen });
  const open = tn.open, openFork = tn.openFork, stop = tn.stop;

  return (
    <Overlay open kind="dialog" label="Chat tree" width={760} testID={TREE_POPUP_ID} onClose={close}>
      <Frame agent={c.agent}>
        <View style={styles.head}>
          <BranchIcon size={14} />
          <Text weight="600" size={13}>Chat tree</Text>
          <Text {...tid("fk-nav-sub")} size={12} tone="muted" numberOfLines={1} style={styles.sub}>{headSub(chatTitle(c, items), n, links.length)}</Text>
          <Filters filter={filter} onPick={(f) => { setFilter(f); search.current?.focus(); }} />
          <IconButton {...tid("fk-close")} title="Close" onPress={closeTree}>{(color) => <Text size={16} style={{ color }}>×</Text>}</IconButton>
        </View>
        <Search ref={search} value={query} onChange={setQuery} focus={pointer === "mouse"} />
        <ScrollView ref={scroll} {...tid("fk-rows")} style={[styles.rows, { borderTopColor: t.line }]} contentContainerStyle={styles.rowsIn} keyboardShouldPersistTaps="handled">
          {!tree ? (err && !loading
            ? <Text {...tid("fk-none", { kind: "error" })} tone="danger" style={styles.none}>Couldn't load the chat tree: {err}{" "}<Text {...tid("fk-retry")} tone="accent" accessibilityRole="link" onPress={tn.retry}>Retry</Text></Text>
            : <Text {...tid("fk-none", { kind: "loading" })} tone="muted" style={styles.none}>Loading…</Text>)
            : !list.length && <Text {...tid("fk-none", { kind: "empty" })} tone="muted" style={styles.none}>{tree.order.length ? "Nothing matches." : "No messages yet."}</Text>}
          {tree && list.map((r, i) => {
            if (r.link) {
              const l = r.link;
              return (
                <Fragment key={r.id}>
                  {l.where === "loose" && list[i - 1]?.link?.where !== "loose" && <LooseHead />}
                  <LinkRow r={r} l={l} fork={chats[l.chat]} on={r.id === selId} onLaid={rowLaid(r.id)} onPress={() => press(r.id, () => openFork(l))} onOpen={() => openFork(l)} />
                </Fragment>
              );
            }
            const e = tree.entries[r.id];
            return (
              <RowView key={r.id} r={r} e={e} on={r.id === selId} agent={c.agent} mark={off ? null : marks[r.id] ?? null} note={notes[r.id]} end={ends[r.id]} held={noOpen}
                labeling={!off && labeling === r.id} more={pointer === "touch" && !off} onLabel={(v) => doneLabel(e, v)} onStop={stop} onLaid={rowLaid(r.id)}
                setRef={(v) => { rowRefs.current[r.id] = v; }}
                onPress={() => press(r.id, () => open(r.id))} onMenu={() => menuRow(r.id)} />
            );
          })}
        </ScrollView>
        <View {...tid("fk-nav-foot")} style={[styles.foot, { borderTopColor: t.line }]}>
          <Text {...tid(foot.held ? "fk-held" : "fk-foot-text")} size={11.5} tone="muted">{foot.text}</Text>
          <TreeFolderHint chatId={nav.chat} />
        </View>
      </Frame>
      {menu && tree && acts.length > 0 && (
        <RowMenu anchor={rowRefs.current[menu]} acts={acts} waits={{ held: (id) => heldReason(waits, id, on) }} onClose={() => setMenu(null)} onPick={(a) => run(tree.entries[menu], a)} />
      )}
    </Overlay>
  );
}

/** The popup's frame: its own height (the rows scroll inside it, the head and the foot stay). */
function Frame({ agent, children }: { agent: string; children: React.ReactNode }) {
  const kind = useOverlayKind();
  const win = useWindowDimensions();
  const sheet = kind === "sheet";
  const height = sheet ? Math.round(win.height * 0.85) - 48 : Math.min(660, win.height - 64);
  return <View {...tid("fk-nav", { agent: agentClass(agent) })} style={{ height }}>{children}</View>;
}

function Filters({ filter, onPick }: { filter: Filter; onPick: (f: Filter) => void }) {
  const t = useTokens();
  return (
    <View {...tid("fk-filters")} style={[styles.filters, { backgroundColor: t.panel, borderColor: t.line }]}>
      {FILTERS.map((f) => (
        <Pressable key={f.id} {...tid("fk-filter", { id: f.id, on: filter === f.id })} role="button" accessibilityState={{ selected: filter === f.id }} onPress={() => onPick(f.id)}
          style={[styles.filter, filter === f.id && { backgroundColor: t.bg }]}>
          <Text size={11.5} tone={filter === f.id ? "text" : "muted"}>{f.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const Search = ({ ref, value, onChange, focus }: { ref: React.Ref<TextInput>; value: string; onChange: (v: string) => void; focus: boolean }) => {
  const t = useTokens();
  return (
    <TextInput {...tid("fk-search")} ref={ref} autoFocus={focus} value={value} onChangeText={onChange} placeholder="Search the tree…" placeholderTextColor={t.faint}
      accessibilityLabel="Search the tree" autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="search"
      style={[styles.search, { color: t.text, backgroundColor: t.bg, borderColor: t.line2 }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
  );
};

/** held: why opening does nothing now ("" when it does): the row says so in its title, and its text, which is what a press opens, is marked as disabled. The
 *  row itself is not: its Stop and its label stay live. */
function RowView({ r, e, on, agent, mark, note, end, held, labeling, more, onLabel, onStop, onLaid, setRef, onPress, onMenu }: {
  r: Row; e: Entry; on: boolean; agent: string; mark: MarkOf | null; note?: string; end?: string; held: string; labeling: boolean; more: boolean; onLabel: (v: string | null) => void;
  onStop: (branch: string) => void; onLaid: (e: LayoutChangeEvent) => void; setRef: (v: View | null) => void; onPress: () => void; onMenu: () => void;
}) {
  const t = useTokens();
  const kind = e.item.kind;
  const m = mark && markText(mark);
  const tip = useControlRef(held || undefined);
  const data = { kind, end, on, path: r.onPath, held: !!held, mark: mark?.mark };
  const body = (
    <>
      <Gutter g={r.gutter} />
      <View style={styles.glyph}>{kind === "user" ? <Text size={9.5} weight="700" tone="accent" style={styles.you}>you</Text> : <AgentGlyph agent={agent} size={10} />}</View>
      {labeling
        ? <LabelInput initial={e.label ?? ""} onDone={onLabel} />
        : <Text {...tid("fk-text")} numberOfLines={1} size={13} tone={held ? "faint" : r.onPath ? "text" : "muted"} weight={r.onPath && !held ? "500" : undefined} style={styles.text}
            aria-disabled={held ? true : undefined}>{preview(e.item.text, 110)}</Text>}
      {!labeling && e.label && <View {...tid("fk-tag")} style={[styles.tag, { backgroundColor: t.accentSoft }]}><Text size={10.5} weight="600" tone="accent" numberOfLines={1}>{`⚑ ${e.label}`}</Text></View>}
      {note && <View {...tid("fk-model")} style={[styles.model, { borderColor: t.line }]}><Text size={10.5} tone="muted" numberOfLines={1}>{note}</Text></View>}
      {m && mark && (
        <View {...tid("fk-mark", { mark: mark.mark })} style={styles.mark}>
          <View style={[styles.markDot, { backgroundColor: markColour(t, mark.mark) }]} />
          <Text size={10.5} weight="600" style={{ color: markColour(t, mark.mark) }} accessibilityHint={m.title}>{m.text}</Text>
        </View>
      )}
      {mark && stoppable(mark.mark) && (
        <Pressable {...tid("fk-stop")} role="button" accessibilityLabel={stopTitle(mark)} onPress={() => onStop(mark.branch)} style={[styles.stop, { borderColor: t.line2, backgroundColor: t.bg }]}>
          <Text size={10.5} weight="600">Stop</Text>
        </Pressable>
      )}
      {r.isLeaf ? <Text {...tid("fk-here")} size={10.5} weight="700" tone="ok">● here</Text> : r.isTip ? <Text {...tid("fk-end")} size={10} tone="faint">end</Text> : null}
      {more && !labeling && <IconButton {...tid("fk-row-more")} size="sm" title="Row actions" onPress={onMenu}>{(c) => <MoreIcon size={12} color={c} />}</IconButton>}
    </>
  );
  // (the label field keeps its own presses: the row around it is a plain view while it is typed in)
  if (labeling) return <View ref={setRef} {...tid("fk-row", data)} onLayout={onLaid} style={[styles.row, { backgroundColor: t.accentSoft }]}>{body}</View>;
  return (
    <Pressable ref={(v) => { setRef(v as View | null); (tip as unknown as (x: unknown) => void)?.(v); }} {...tid("fk-row", data)} onLayout={onLaid} onPress={onPress} onLongPress={onMenu} delayLongPress={450}
      {...({ onContextMenu: (ev: { preventDefault(): void }) => { ev.preventDefault(); onMenu(); } } as object)}
      accessibilityState={{ selected: on }} aria-selected={on}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, on ? { backgroundColor: t.accentSoft } : hovered ? { backgroundColor: t.hover } : null]}>
      {body}
    </Pressable>
  );
}

/** A chat forked from this one: a link to it, with what that chat is doing. fork: its view, absent once it is deleted. */
function LinkRow({ r, l, fork, on, onLaid, onPress, onOpen }: { r: Row; l: ForkLink; fork: ChatView | undefined; on: boolean; onLaid: (e: LayoutChangeEvent) => void; onPress: () => void; onOpen: () => void }) {
  const t = useTokens();
  const mark: RowMark | null = !fork ? null : (fork.approvals ?? 0) > 0 || fork.status === "approval" ? "approval" : chatBusy(fork) ? "running" : null;
  return (
    <Pressable {...tid("fk-row", { kind: "fork", on, archived: l.archived, mark: mark ?? undefined })} onLayout={onLaid} onPress={onPress}
      accessibilityState={{ selected: on }} aria-selected={on}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, on ? { backgroundColor: t.accentSoft } : hovered ? { backgroundColor: t.hover } : null]}>
      <Gutter g={r.gutter} />
      <View style={styles.glyph}><BranchIcon size={11} color={t.muted} /></View>
      <Text {...tid("fk-fork-link")} role="link" accessibilityLabel={`Open the fork “${l.title}”`} numberOfLines={1} size={13} tone={l.archived ? "muted" : "accent"} onPress={onOpen} style={styles.forkLink}>{l.title}</Text>
      <View style={styles.grow} />
      {mark && <View {...tid("fk-mark", { mark })} style={styles.mark}><View style={[styles.markDot, { backgroundColor: markColour(t, mark) }]} /><Text size={10.5} weight="600" style={{ color: markColour(t, mark) }}>{mark === "approval" ? "needs approval" : "working"}</Text></View>}
      {l.archived && <Text {...tid("fk-end")} size={10} tone="faint">archived</Text>}
    </Pressable>
  );
}

function LooseHead() {
  const t = useTokens();
  return <View style={[styles.looseHead, { borderTopColor: t.line }]}><Text {...tid("fk-loose-head")} size={11} tone="muted">Forks made before fork points were recorded</Text></View>;
}

/** A row's menu: your message "Branch and edit", "Fork and edit", "Label"/"Relabel"; a reply "Fork to new chat" (disabled while its branch runs), the note
 *  where a fork partway through a turn is not offered, and Label. What a wait holds is disabled, with its reason. */
function RowMenu({ anchor, acts, waits, onClose, onPick }: { anchor: View | null | undefined; acts: TreeItem[]; waits: { held: (id: "branchEdit" | "forkEdit" | "fork") => string }; onClose: () => void; onPick: (a: TreeItem) => void }) {
  const ref = useMemo(() => ({ current: anchor ?? null }), [anchor]);
  return (
    <Overlay open kind="popover" label="Row actions" anchor={ref} onClose={onClose}>
      <Menu label="Row actions" minWidth={190}>
        {acts.map((a) => {
          if (a.id === "note") return <View key={a.id} style={styles.ctxNote}><Text {...tid("fk-ctx-note")} size={11.5} tone="muted">{a.label}</Text></View>;
          const held = a.id === "label" ? "" : waits.held(a.id), busy = a.id !== "label" && a.disabled;
          const why = busy ? BUSY_FORK : held;
          return <MenuItem key={a.id} {...tid("fk-ctx-item", { kind: a.id })} label={a.label} title={why || undefined} note={why || undefined} disabled={!!why} onPress={() => onPick(a)} />;
        })}
      </Menu>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 10, paddingBottom: 8, paddingLeft: 14, paddingRight: 10 },
  sub: { flex: 1, minWidth: 0 },
  filters: { flexDirection: "row", padding: 2, borderRadius: 7, borderWidth: 1 },
  filter: { paddingVertical: 2, paddingHorizontal: 9, borderRadius: 5 },
  search: { marginHorizontal: 12, marginBottom: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderRadius: 7, fontSize: 13 },
  rows: { flex: 1, minHeight: 0, borderTopWidth: 1 },
  rowsIn: { paddingVertical: 6 },
  none: { padding: 20, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, minHeight: 25, ...(webStyle({ cursor: "default" }) as object) },
  glyph: { width: 24, alignItems: "center", justifyContent: "center" },
  you: { textTransform: "uppercase", letterSpacing: 0.3 },
  text: { flex: 1, minWidth: 0 },
  tag: { flexShrink: 1, maxWidth: "45%", borderRadius: 4, paddingHorizontal: 5 },
  model: { flexShrink: 1, maxWidth: "35%", borderWidth: 1, borderRadius: 4, paddingHorizontal: 5 },
  mark: { flexDirection: "row", alignItems: "center", gap: 4 },
  markDot: { width: 6, height: 6, borderRadius: 3 },
  stop: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 7 },
  forkLink: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1 },
  looseHead: { marginTop: 6, paddingTop: 7, paddingBottom: 3, paddingHorizontal: 14, borderTopWidth: 1 },
  foot: { flexDirection: "row", flexWrap: "wrap", gap: 14, paddingVertical: 7, paddingHorizontal: 14, alignItems: "center", borderTopWidth: 1 },
  ctxNote: { paddingTop: 5, paddingBottom: 4, paddingHorizontal: 10, maxWidth: 220 },
});
