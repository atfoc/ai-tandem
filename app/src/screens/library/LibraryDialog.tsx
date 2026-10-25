// The library popup (the old page's Library.tsx `LibraryDialog`; C-PL-01 to C-PL-19, C-PL-33): a search, the tree of the libraries and an editor for what is chosen in it. Where an
// item is, is the tree's: a new one is made where the tree was right-clicked (long-pressed) or beside what is chosen, and a prompt or a group is moved by dragging it (or by
// "Move…" of the menu, for the keys). Nothing is saved while typing: Save saves, leaving unsaved changes asks first. Both popups show the libraries the store holds (the stream
// keeps them current), and everything a library says is shown as plain text. A centred dialog on the wide layouts and a bottom sheet on the phone (Overlay), the same
// component: the list above the editor in a sheet (the old page's narrow window), beside it in a dialog.
//
// What the old page did with the DOM is done here with refs and measures: a row's focus (`focus()`), a row scrolled into view (the rows' laid-out places), the places a drag lands on
// (`measureInWindow`, libdrag.ts), the keys of the tree (the keys port, while a row has the focus).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

import { libraryApi } from "@aiwb/core/libraryapi.ts";
import { insertItem } from "@aiwb/core/logic/library.ts";
import { hasSearch } from "@aiwb/core/logic/promptsearch.ts";
import type { InsertTarget } from "@aiwb/core/logic/insert.ts";
import {
  NEW_ROW, canMove, changeOf, chosenItem, chosenKey, deleteGroupText, deletePromptText, groupHolds, hasServerLevel, heldPlace, indentStep, isDirty, keysAbove, leaveText,
  libraryTrees, nameProblem, newPlace, placeRows, placeText, promptList, rowPlace, sameChosen, samePlace, shownFields, topText, treeKey, treeRows, withNewRow,
  type Chosen, type Edits, type Fields, type Place, type TreeRow,
} from "@aiwb/core/logic/libraryview.ts";
import { getState, setState, subscribe } from "@aiwb/core/state/store.ts";

import { dragPointer } from "../../platform/dragpointer";
import { makeScrollGuard } from "../../platform/dragscroll";
import { focusNowhere } from "../../platform/focus";
import { onKey } from "../../platform/keys";
import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogActions, DialogTitle } from "../../ui/Dialog.tsx";
import { Menu, MenuItem, MenuSep } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useLayout, usePhone } from "../../ui/useLayout.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { confirm } from "../shell/nav.ts";
import { pushScreen, pushedScreens } from "../shell/screens.ts";
import { About, Editor, NONE_TEXT, Notice } from "./Editor.tsx";
import { createLibDrag, type Spots } from "./libdrag.ts";
import { insertKey } from "./open.ts";
import { SearchField } from "./parts.tsx";
import { HitRowView, NewRowView, TreeRowView, type RowCtx } from "./Tree.tsx";
import { useLibraries } from "./useLibraries.ts";
import type { Rect } from "../sidebar/drophit.ts";

export const LIBRARY_DIALOG_ID = "library-dialog";

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_FIELDS: Fields = { name: "", parent: "", text: "" };
const closedRows = new Set<string>(); // the groups and servers closed in the tree; kept while the app is open
const itemOf = (r: { kind: Chosen["kind"]; server: string; id: string }): Chosen => ({ kind: r.kind, server: r.server, id: r.id });

/** The menu of a right click (a long press) in the tree. at: where a new item goes, null when nothing can be made (no library is connected); off: the name of its server
 *  when that is not connected; item: the prompt or group of the row, which can be moved; key: the row, "" for the space under the rows. x, y: where it hangs from. */
type TreeMenu = { x: number; y: number; key: string; at: Place | null; off: string; item: Chosen | null };

type Measurable = { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void };
/** A rectangle in the window; a view that is gone, or that never answers, has none (a measure that never comes back would stop the drag). */
const rectOf = (el: Measurable | null | undefined): Promise<Rect | null> => new Promise((done) => {
  if (!el?.measureInWindow) return done(null);
  const late = setTimeout(() => done(null), 500);
  el.measureInWindow((x, y, width, height) => { clearTimeout(late); done(width || height ? { x, y, width, height } : null); });
});

/** Waits until the store is as `ok` says, a few seconds at most. A library's server sends the `library` event of a change before the call's answer, but on another line:
 *  the answer may be here first. Answers whether it was. */
function whenStore(ok: () => boolean, ms = 3000): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((done) => {
    const end = (v: boolean) => { off(); clearTimeout(t); done(v); };
    const off = subscribe(() => { if (ok()) end(true); });
    const t = setTimeout(() => end(false), ms);
  });
}

export function LibraryDialog() {
  const dlg = useStore((s) => s.libraryDialog);
  const phone = usePhone();
  // On the phone the library is a pushed screen (package S4), not this dialog: whoever asked for the dialog (the insert sheet's "Library", the sidebar foot,
  // Settings' row) gets the screen, and the text box it came from is as it was.
  useEffect(() => {
    if (!dlg || !phone) return;
    setState({ libraryDialog: null });
    dlg.back?.cancel();
    if (pushedScreens().at(-1)?.name !== "library") pushScreen("library", {});
  }, [dlg, phone]);
  if (!dlg || phone) return null;
  return <Library back={dlg.back} />;
}

function Library({ back }: { back?: InsertTarget }) {
  const t = useTokens();
  const phone = useLayout() === "phone";
  const win = useWindowDimensions();
  const libs = useLibraries();
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const asking = useStore((s) => !!s.confirm);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(closedRows));
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [fresh, setFresh] = useState<{ kind: "prompt" | "group"; at: Place } | null>(null); // a new item is being made: its kind, and where it goes
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [focused, setFocused] = useState("");                          // the row of the list that Tab reaches
  const [ring, setRing] = useState("");                                // the row the keyboard moved the focus to last
  const [menu, setMenu] = useState<TreeMenu | null>(null);
  const [move, setMove] = useState<{ item: Chosen; by: "drag" | "keys" } | null>(null); // an item is on its way to another place: dragged, or picked up by the menu's "Move…"
  const [over, setOver] = useState<Place | null>(null);                // where it would land now; null where it cannot
  const [treeErr, setTreeErr] = useState("");                          // why a move was refused
  const [reveal, setReveal] = useState("");                            // the row of an item that was moved or made: it is scrolled to
  const search = useRef<TextInput>(null), nameInput = useRef<TextInput>(null), scroll = useRef<ScrollView>(null);
  const listBox = useRef<View>(null), newBar = useRef<View>(null);
  const rowEls = useRef(new Map<string, View>()), rowCbs = useRef(new Map<string, (el: View | null) => void>()), rowAt = useRef(new Map<string, { y: number; h: number }>());
  const view = useRef({ top: 0, height: 0 });
  const inList = useRef(""), inField = useRef(false);                  // the row of the list that has the focus; whether a box of the editor has it
  const kept = useRef<{ key: string; fields: Fields } | null>(null);   // the chosen item as it last was: it may be deleted under what was typed
  const guard = useMemo(() => makeScrollGuard(), []);
  const guardRef = useCallback((el: View | null) => { guard.guard(el as unknown); }, [guard]);

  const searching = hasSearch(query);
  const level = hasServerLevel(libs);
  const lib = (server: string) => libs.find((v) => v.server === server);
  const freshAt = fresh ? heldPlace(libs, fresh.at) : null;            // (a group that went meanwhile gives way to the top of its library)
  const rows = useMemo(() => treeRows(trees, closed), [trees, closed]);
  // The tree as it is drawn: with a row for the item that is being made, where it goes.
  const drawn = useMemo(() => withNewRow(rows, fresh && freshAt ? { kind: fresh.kind, at: freshAt, name: edits.name ?? "" } : null, level), [rows, fresh, freshAt?.server, freshAt?.group, edits.name, level]);
  const step = indentStep(drawn);
  const hits = useMemo(() => (searching ? promptList(trees, query) : []), [trees, query, searching]);

  // What the editor is on, and what of it is not saved.
  const kind = fresh?.kind ?? (chosen && chosen.kind !== "server" ? chosen.kind : null);
  const item = fresh ? undefined : chosenItem(libs, chosen);
  if (item && chosen) kept.current = { key: chosenKey(chosen), fields: item };
  const saved = fresh ? NO_FIELDS : item ?? (chosen && kept.current?.key === chosenKey(chosen) ? kept.current.fields : undefined);
  const shown = saved && shownFields(saved, edits);
  const dirty = fresh ? !!(edits.name?.trim() || edits.text) : !!saved && !!kind && isDirty(saved, edits, kind);
  const where = fresh ? lib(fresh.at.server) : chosen ? lib(chosen.server) : undefined; // the library the editor's item is in, or goes into
  const gone = fresh ? !where : !!chosen && (chosen.kind === "server" ? !where : !item);
  const off = (fresh || !!chosen) && where?.connected === false;
  // Where the buttons under the tree make a new item: beside the one that is being made, else by what is chosen.
  const startAt = (freshAt && !off ? freshAt : null) ?? newPlace(libs, chosen);

  const reset = () => { setEdits({}); setErr(""); setFresh(null); };
  /** Does `then` at once, or after the user agreed to drop what is not saved. */
  const leave = (then: () => void) => {
    if (!dirty || !kind) return then();
    confirm({ ...leaveText(kind, shown?.name ?? ""), actions: [{ label: "Discard", tone: "danger", run: then }] });
  };
  const close = () => leave(() => { setState({ libraryDialog: null }); if (back) back.cancel(); });
  const choose = (c: Chosen) => { if (!fresh && sameChosen(c, chosen)) return; leave(() => { reset(); setTreeErr(""); setChosen(c); }); };
  const keepClosed = (next: Set<string>) => { closedRows.clear(); for (const k of next) closedRows.add(k); return next; };
  const toggle = (key: string) => setClosed((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return keepClosed(next); });
  /** Opens a place in the tree: its server, its group and the groups that group is in. */
  const openAt = (at: Place) => setClosed((was) => { const up = keysAbove(libs, at).filter((k) => was.has(k)); if (!up.length) return was; const next = new Set(was); for (const k of up) next.delete(k); return keepClosed(next); });
  const endMove = () => { setMove(null); setOver(null); };
  /** Starts a new item in a place: the tree shows where (the search gives way to it), and its name is typed in the editor. */
  const create = (what: "prompt" | "group", at: Place | null) => { if (at) leave(() => { reset(); setTreeErr(""); endMove(); setQuery(""); openAt(at); setFresh({ kind: what, at }); }); };

  // ---- the focus
  // The search has the focus first. When the popup closes the focus goes back to what had it when it opened (ui/modal.web.tsx), unless the insert popup's text box
  // (`back`) has taken it by then.
  useEffect(() => { search.current?.focus(); }, []);
  // An item that is gone with nothing typed over it leaves the editor; what was typed stays, and a save says why it cannot be.
  useEffect(() => { if (gone && !dirty) { const made = !!fresh; reset(); if (!made) setChosen(null); } }, [gone, dirty]);
  // A new item's name is typed first, and its row is on screen.
  useLayoutEffect(() => {
    if (!fresh) return;
    scrollTo(NEW_ROW);
    nameInput.current?.focus();
  }, [fresh]);
  // The focus is in the popup: when what had it went (a deleted item's buttons, the bar of a move), the search has it.
  useEffect(() => { if (!asking && focusNowhere()) search.current?.focus(); }, [asking, chosen, fresh, move]);
  // A search shows no tree: its menu and a move end with it. So does the move of an item that is gone.
  useEffect(() => { if (searching) { setMenu(null); endMove(); drag.cancel(); } }, [searching]);
  const moving = move && chosenItem(libs, move.item) ? move : null;
  useEffect(() => { if (move && !moving) { endMove(); drag.cancel(); } }, [move, moving]);

  // ---- scrolling the list
  /** Scrolls the list so that a row is in sight. */
  function scrollTo(key: string): void {
    const r = rowAt.current.get(key), v = view.current;
    if (!r || !v.height) return;
    if (r.y < v.top) scroll.current?.scrollTo({ y: r.y, animated: false });
    else if (r.y + r.h > v.top + v.height) scroll.current?.scrollTo({ y: r.y + r.h - v.height, animated: false });
  }
  const rowEl = (key: string) => rowEls.current.get(key);
  const focusRow = (key: string) => { setFocused(key); scrollTo(key); rowEl(key)?.focus(); };

  const save = async () => {
    if (busy || !kind || !saved || off) return;
    setBusy(true); setErr("");
    try {
      if (fresh) {
        const at = freshAt, what = fresh.kind, name = (edits.name ?? "").trim();
        if (!at) return;
        const made = what === "prompt" ? (await libraryApi.createPrompt(at.server, name, at.group, edits.text ?? "")).prompt : (await libraryApi.createGroup(at.server, name, at.group)).group;
        const next: Chosen = { kind: what, server: at.server, id: made.id };
        // The library with the new item comes on the stream; one that did not come is given the item the server answered with.
        if (!await whenStore(() => !!chosenItem(getState().libraries, next))) setState((s) => ({ libraries: insertItem(s.libraries, at.server, what, { text: "", ...made }) }));
        reset(); setChosen(next); setFocused(chosenKey(next)); setReveal(chosenKey(next));
        return;
      }
      if (!chosen) return;
      const change = changeOf(saved, edits, kind), was = chosenItem(getState().libraries, chosen);
      if (kind === "prompt") await libraryApi.changePrompt(chosen.server, chosen.id, change); else await libraryApi.changeGroup(chosen.server, chosen.id, { name: change.name });
      // What was typed stays in the editor until the library has moved on from what it held before the save: nothing is shown as it was. (Moved on, not "as saved":
      // another window's later save may be what it holds by now.)
      await whenStore(() => { const f = chosenItem(getState().libraries, chosen); return !f || !was || f.name !== was.name || f.parent !== was.parent || f.text !== was.text; });
      setEdits({});
    } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  const remove = () => {
    if (!chosen || chosen.kind === "server" || !saved) return;
    const v = lib(chosen.server), c = chosen;
    confirm({
      ...(c.kind === "prompt" ? deletePromptText(saved.name) : deleteGroupText(saved.name, v ? groupHolds(v, c.id) : { prompts: 0, groups: 0 })),
      // (the item leaves the editor with the library's event; what was typed over it goes with it)
      actions: [{ label: "Delete", tone: "danger", run: async () => { await (c.kind === "prompt" ? libraryApi.deletePrompt(c.server, c.id) : libraryApi.deleteGroup(c.server, c.id)); setEdits({}); setErr(""); } }],
    });
  };

  // ---- the list: the tree, or the prompts a search finds
  const keysOf = searching ? hits.map((h) => chosenKey({ kind: "prompt", server: h.server, id: h.prompt.id })) : rows.map((r) => r.key);
  const chosenAt = chosen && !fresh ? chosenKey(chosen) : "";
  const tab = keysOf.includes(focused) ? focused : keysOf.includes(chosenAt) ? chosenAt : keysOf[0] ?? "";
  const searchKeys = (e: { nativeEvent: { key: string; isComposing?: boolean }; preventDefault(): void }) => {
    const k = e.nativeEvent.key;
    if (k === "ArrowDown" && keysOf.length) { e.preventDefault(); setRing(tab); focusRow(tab); }
    if (k === "Enter" && searching && hits.length && !e.nativeEvent.isComposing) { e.preventDefault(); choose({ kind: "prompt", server: hits[0].server, id: hits[0].prompt.id }); }
  };

  // ---- a move: a prompt or a group goes to another group of its library, or to its top
  /** The place if the moved item can go there, else null. */
  const landing = (to: Place | null) => (moving && canMove(libs, moving.item, to) ? to : null);
  const topOf = moving ? { server: moving.item.server, group: "" } : null;
  /** Moves the item. The library's server has the last word: what it refuses is said under the tree. */
  const moveTo = async (it: Chosen, to: Place, by: "drag" | "keys") => {
    endMove(); setTreeErr("");
    if (by === "keys") focusRow(chosenKey(it));
    openAt(to); // (also when the move is refused: the place is where the user looks next)
    try {
      await (it.kind === "prompt" ? libraryApi.changePrompt(it.server, it.id, { parent: to.group }) : libraryApi.changeGroup(it.server, it.id, { parent: to.group }));
      await whenStore(() => chosenItem(getState().libraries, it)?.parent === to.group);
      setReveal(chosenKey(it));
    } catch (e) { setTreeErr(said(e)); }
  };
  const startMove = (it: Chosen) => { closeMenu(it); setTreeErr(""); setOver(null); setMove({ item: it, by: "keys" }); };
  // (the line that says how a move by the keys goes takes room from the list: the row that is moved stays on screen)
  useEffect(() => { if (move?.by === "keys") scrollTo(chosenKey(move.item)); }, [move]);
  /** In a move by the keys, the focused row is where the item would land; a click or Enter there lands it. */
  const landOn = (to: Place | null) => { const at = landing(to); if (moving && at) void moveTo(moving.item, at, "keys"); };

  // The drag's session: what it needs is read from the latest render.
  const now = useRef({ libs, freshAt, drawn, moving, searching });
  now.current = { libs, freshAt, drawn, moving, searching };
  const latest = useRef({ moveTo, openMenu: (key: string, at: { x: number; y: number } | null) => {} });
  latest.current.moveTo = moveTo;
  const drag = useMemo(() => createLibDrag({
    measure: async (): Promise<Spots> => {
      const { drawn: shownRows, freshAt: fa } = now.current;
      const [list, bar, rs] = await Promise.all([
        rectOf(listBox.current), rectOf(newBar.current),
        Promise.all(shownRows.map(async (r) => ({ key: r.key, rect: await rectOf(rowEls.current.get(r.key)), place: r.key === NEW_ROW ? fa : rowPlace(r) }))),
      ]);
      return { list, bar, rows: rs.filter((r): r is { key: string; rect: Rect; place: Place | null } => !!r.rect) };
    },
    top: (it) => ({ server: it.server, group: "" }),
    landing: (it, to) => (canMove(now.current.libs, it, to) ? to : null),
    begin: (it) => { setMenu(null); setOver(null); setMove({ item: it, by: "drag" }); },
    finish: () => setMove((m) => (m?.by === "drag" ? null : m)),
    // (the menu opens a moment after the finger left: the mouse events a browser still sends after a touch would press the dimmed page of the menu that is already there)
    tap: (it) => { setTimeout(() => latest.current.openMenu(chosenKey(it), null), 150); },
    over: (to) => setOver((was) => (samePlace(was, to) ? was : to)),
    drop: (it, to) => { void latest.current.moveTo(it, to, "drag"); },
    keys: onKey,
    pointer: dragPointer,
    scroll: (dy) => scroll.current?.scrollTo({ y: Math.max(0, view.current.top + dy), animated: false }),
    every: (f, ms) => { const id = setInterval(f, ms); return () => clearInterval(id); },
  }), []);
  useEffect(() => () => drag.cancel(), [drag]);
  const cancelMove = () => { const it = moving?.item; if (drag.active) drag.cancel(); else if (moving?.by === "keys" && it && !inList.current) focusRow(chosenKey(it)); endMove(); };

  // A moved or a new item is on screen where it is now, and has the focus when a row had it.
  useEffect(() => {
    const el = reveal ? rowEl(reveal) : undefined;
    if (!el) { if (reveal && searching) setReveal(""); return; } // (a search shows no tree: the row is not waited for)
    scrollTo(reveal);
    if (focusNowhere() || inList.current) el.focus();
    setReveal("");
  }, [reveal, rows, searching]);

  // ---- the menu of a right click (or of the menu key on a row, or a long press): a new item where it was opened, and "Move…"
  async function openMenu(key: string, pt: { x: number; y: number } | null) {
    const { libs: ls, freshAt: fa, searching: s } = now.current;
    const row = s ? undefined : rows.find((r) => r.key === key), hit = s ? hits[keysOf.indexOf(key)] : undefined;
    const at = key === NEW_ROW ? fa : row ? rowPlace(row) : hit ? heldPlace(ls, { server: hit.server, group: hit.prompt.parent }) : newPlace(ls, null);
    const box = key ? await rectOf(rowEl(key)) : null;
    // (opened by the menu key the event has no pointer: the menu is at its row)
    const inBox = !!pt && (!key || (!!box && pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height));
    const x = inBox && pt ? pt.x : box ? box.x + 24 : pt?.x ?? 40, y = inBox && pt ? pt.y : box ? Math.min(box.y + box.height, box.y + 26) : pt?.y ?? 80;
    const v = at ? lib(at.server) : undefined;
    setMenu({ x, y, key, at, off: v && !v.connected ? v.name : "", item: row && row.kind !== "server" ? itemOf(row) : null });
  }
  latest.current.openMenu = (key, pt) => { void openMenu(key, pt); };
  /** Closes the menu; the focus goes to its row (the menu's own overlay leaves a focus that is outside it alone). */
  function closeMenu(it?: Chosen): void {
    if (menu) { const key = it ? chosenKey(it) : menu.key || tab; (rowEl(key) ?? search.current)?.focus(); }
    setMenu(null);
  }
  const anchor = useMemo(() => (menu ? ({ current: { measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) => done(menu.x, menu.y, 0, 0) } } as unknown as RefObject<View>) : null), [menu?.x, menu?.y, menu === null]);

  // The keys of the tree, while a row has the focus: the arrows walk the rows, Left and Right close and open, Enter and Space press the row.
  const kb = useRef({ rows, hits, keysOf, searching, toggle, focusRow, press: (_k: string) => {} });
  kb.current = { rows, hits, keysOf, searching, toggle, focusRow, press: (key: string) => {
    if (searching) { const h = hits[keysOf.indexOf(key)]; if (h) choose({ kind: "prompt", server: h.server, id: h.prompt.id }); return; }
    const r = rows.find((x) => x.key === key);
    if (r) { if (move?.by === "keys") landOn(rowPlace(r)); else choose(itemOf(r)); }
  } };
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;
  useEffect(() => onKey((e) => {
    const key = inList.current;
    if (!key || menuOpen.current || getState().confirm || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = kb.current, at = k.keysOf.indexOf(key);
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); k.press(key); return; }
    if (e.key === "ArrowUp" && at === 0) { e.preventDefault(); e.stopPropagation(); search.current?.focus(); return; }
    let to: string | undefined;
    if (k.searching) to = e.key === "ArrowDown" ? k.keysOf[at + 1] : e.key === "ArrowUp" ? k.keysOf[at - 1] : e.key === "Home" ? k.keysOf[0] : e.key === "End" ? k.keysOf[k.keysOf.length - 1] : undefined;
    else { const r = treeKey(k.rows, key, e.key); if (r.toggle) { e.preventDefault(); e.stopPropagation(); k.toggle(r.toggle); } to = r.focus; }
    if (to) { e.preventDefault(); e.stopPropagation(); setRing(to); k.focusRow(to); }
  }), []);
  // ⌘↵ / Ctrl+↵ in either box of the editor saves (the keys port reports it on a tablet's keyboard too).
  const canSave = !!shown && !busy && !off && dirty && !nameProblem(shown.name) && (!fresh || !!freshAt);
  const saveNow = useRef({ canSave, save });
  saveNow.current = { canSave, save };
  useEffect(() => onKey((e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !inField.current || getState().confirm) return;
    e.preventDefault(); e.stopPropagation();
    if (saveNow.current.canSave) void saveNow.current.save();
  }), []);

  // What is lit in the tree: where the moved item would land, or where the open menu makes a new one.
  const litAt = moving ? over : menu && !menu.off ? menu.at : null;
  const lit = litAt && !searching ? placeRows(drawn, litAt, level) : null;
  const ctx: RowCtx = {
    step, chosenAt, tab, ring, lit: lit ? { head: lit.head, inside: lit.inside } : null,
    moved: moving ? moving.item : null, keyMove: moving?.by === "keys", drag, guard,
    press: (r) => { if (moving?.by === "keys") landOn(rowPlace(r)); else { setRing(""); choose(itemOf(r)); } },
    toggle, menu: (key, at) => { void openMenu(key, at); },
    focused: (key) => { inList.current = key; setFocused(key); const r = rows.find((x) => x.key === key); if (moving?.by === "keys" && r) setOver(landing(rowPlace(r))); },
    blurred: (key) => { if (inList.current === key) inList.current = ""; },
    ref: (key) => {
      let cb = rowCbs.current.get(key);
      if (!cb) { cb = (el) => { if (el) rowEls.current.set(key, el); else rowEls.current.delete(key); }; rowCbs.current.set(key, cb); }
      return cb;
    },
    laid: (key, y, h) => { rowAt.current.set(key, { y, h }); },
  };

  // ---- the editor
  const problem = shown && (fresh ? (shown.name.trim() ? nameProblem(shown.name) : "") : edits.name !== undefined ? nameProblem(shown.name) : "");
  const set = (p: Edits) => setEdits((e) => ({ ...e, ...p }));
  const at = fresh ? freshAt : chosen && shown ? heldPlace(libs, { server: chosen.server, group: shown.parent }) : null;
  const editor = !kind || !shown ? null : (
    <Editor libs={libs} level={level} kind={kind} fresh={!!fresh} shown={shown} at={at} off={off} where={where} gone={gone} problem={problem ?? ""} err={err} busy={busy} dirty={dirty} canSave={canSave}
      nameRef={nameInput} onName={(v) => set({ name: v })} onText={(v) => set({ text: v })} onSave={() => void save()} onDelete={remove}
      onRevert={() => (fresh ? reset() : (setEdits({}), setErr("")))} inField={(on) => { inField.current = on; }} />
  );
  const about = chosen?.kind === "server" && !fresh && where ? <About where={where} /> : null;

  const toTop = landing(topOf);
  const notices = libs.filter((v) => v.notice);
  const escape = useRef(close);
  escape.current = () => { if (moving || drag.active) cancelMove(); else close(); };
  const height = Math.max(380, Math.min(560, win.height - 150));
  const movedName = moving ? chosenItem(libs, moving.item)?.name ?? "" : "";
  /** A finger held on the space under the rows, and lifted: the menu of the top level, as a right click makes it (opened after the finger left, like the rows' own). (Not on the rows: their own gesture is a drag after a long press.) */
  const spaceGesture = useMemo(() => Gesture.Pan().runOnJS(true).activateAfterLongPress(500).onEnd((e, ok) => { if (ok) setTimeout(() => latest.current.openMenu("", { x: e.absoluteX, y: e.absoluteY }), 150); }), []);
  const spaceMenu = { onContextMenu: (e: { preventDefault(): void; clientX?: number; clientY?: number }) => { if (searching) return; e.preventDefault(); void openMenu("", e.clientX === undefined ? null : { x: e.clientX, y: e.clientY ?? 0 }); } };

  return (
    <Overlay open kind="dialog" label="Prompt library" width={860} testID={LIBRARY_DIALOG_ID} onClose={() => escape.current()}>
      <GestureHandlerRootView style={phone ? styles.stretch : { height }}>
        <View style={phone ? undefined : styles.frame}>
          <View style={styles.head}>
            <DialogTitle>Prompt library</DialogTitle>
            <Text {...tid("lib-hint-keys")} size={12} tone="muted">{insertKey()} in a message box inserts a prompt</Text>
          </View>
          {notices.map((v) => <Notice key={v.server}>{level ? `${v.name}: ` : ""}{v.notice}</Notice>)}
          <View style={[styles.body, phone && styles.bodyCol]}>
            <View style={[styles.side, phone && styles.sideCol]}>
              <SearchField ref={search} testID="lib-search" value={query} onChange={setQuery} onKeyPress={searchKeys} onClear={() => { setQuery(""); search.current?.focus(); }}
                />
              <View ref={listBox} collapsable={false} {...tid("lib-list-frame")} style={[styles.listBox, phone && styles.listBoxCol, { borderColor: lit?.all ? t.accent : t.line }, lit?.all && { boxShadow: `inset 0 0 0 1px ${t.accent}` } as object]}>
                <ScrollView ref={scroll} testID="lib-scroll" keyboardShouldPersistTaps="handled" nestedScrollEnabled scrollEnabled={!move || move.by !== "drag"} contentContainerStyle={styles.listIn} scrollEventThrottle={16}
                  onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; }} onScroll={(e) => { view.current.top = e.nativeEvent.contentOffset.y; }}>
                  <View {...tid("lib-list", { mode: searching ? "hits" : "tree", drop: lit?.all || undefined })} role={searching ? ("listbox" as never) : "tree"} aria-label={searching ? "Prompts found" : "Prompts"} style={styles.rows}
                    {...(searching ? {} : spaceMenu as object)} ref={guardRef}>
                    {searching ? (hits.length ? hits.map((h, i) => {
                      const key = keysOf[i];
                      return <HitRowView key={key} h={h} k={key} on={key === chosenAt} tab={key === tab} ctx={{ ...ctx, choose: () => choose({ kind: "prompt", server: h.server, id: h.prompt.id }), menu: (pt) => { void openMenu(key, pt); } }} />;
                    }) : <Text {...tid("lib-empty")} size={12} tone="muted" style={styles.empty}>No matching prompts</Text>)
                      : drawn.length ? drawn.map((r) => (r.key === NEW_ROW
                        ? <NewRowView key={r.key} r={r} ctx={ctx} rowRef={ctx.ref(NEW_ROW)} />
                        : <TreeRowView key={r.key} r={r} ctx={ctx} canDrag={r.kind !== "server" && !r.off} />))
                        : <Text {...tid("lib-empty")} size={12} tone="muted" style={styles.empty}>The library has no prompts yet.</Text>}
                    {!searching ? <GestureDetector gesture={spaceGesture}><View {...tid("lib-space")} style={styles.space} /></GestureDetector> : null}
                  </View>
                </ScrollView>
              </View>
              {moving?.by === "keys" ? <Text {...tid("lib-hint")} role="status" size={12} tone="muted">Moving “{movedName}”: choose a group, or the top. Enter moves it there, Esc cancels.</Text> : null}
              {treeErr ? <Text {...tid("lib-tree-err")} accessibilityRole="alert" size={12} tone="danger" selectable style={styles.treeErr}>{treeErr}</Text> : null}
              {/* During a move the bar of the top level is where the buttons are, and as high: the list keeps its height. */}
              <View ref={newBar} collapsable={false} {...tid("lib-new")} style={styles.newRow}>
                {moving && topOf ? (
                  <TopBar text={topText(lib(topOf.server)?.name ?? "", level)} lit={samePlace(over, topOf)} off={!toTop} onPress={() => landOn(topOf)} onFocus={() => { if (moving.by === "keys") setOver(toTop); }} />
                ) : (
                  <>
                    <Button size="sm" testID="lib-new-prompt" label="New prompt" disabled={!startAt} onPress={() => create("prompt", startAt)} />
                    <Button size="sm" testID="lib-new-group" label="New group" disabled={!startAt} onPress={() => create("group", startAt)} />
                  </>
                )}
              </View>
            </View>
            <View {...tid("lib-edit")} style={[styles.edit, phone && styles.editCol]}>
              {editor ?? about ?? <Text {...tid("lib-none")} size={12} tone="muted" style={styles.none}>{NONE_TEXT}</Text>}
            </View>
          </View>
          <DialogActions>
            <Button size="sm" testID="lib-close" label="Close" onPress={close} />
          </DialogActions>
        </View>
      </GestureHandlerRootView>
      {menu && anchor ? (
        <Overlay open kind="popover" label="Prompt library" anchor={anchor} testID="lib-menu" onClose={() => closeMenu()}>
          <Menu label="Prompt library" minWidth={190}>
            <View {...tid("lib-menu-note")} style={styles.menuNote}>
              <Text size={11.5} tone="muted">{!menu.at ? "No library is connected." : menu.off ? `${menu.off} is not connected: nothing can be changed there until it is back.` : placeText(libs, menu.at, level)}</Text>
            </View>
            <MenuItem testID="lib-menu-item" label="New prompt" autoFocus={!!menu.at && !menu.off} disabled={!menu.at || !!menu.off} onPress={() => { const to = menu.at; setMenu(null); create("prompt", to); }} />
            <MenuItem testID="lib-menu-item" label="New group" disabled={!menu.at || !!menu.off} onPress={() => { const to = menu.at; setMenu(null); create("group", to); }} />
            {menu.item ? <MenuSep /> : null}
            {menu.item ? <MenuItem testID="lib-menu-item" label="Move…" disabled={!!menu.off} onPress={() => startMove(menu.item!)} /> : null}
          </Menu>
        </Overlay>
      ) : null}
    </Overlay>
  );
}

/** The bar of the top level, in the buttons' place during a move: a drop target, and reachable with Tab in a move by the keys. It is off (aria-disabled, still
 *  focusable) where the moved item already is. */
function TopBar({ text, lit, off, onPress, onFocus }: { text: string; lit: boolean; off: boolean; onPress(): void; onFocus(): void }) {
  const t = useTokens();
  const ref = useControlRef(undefined, undefined, undefined, off);
  return (
    <Pressable ref={ref} {...tid("lib-top", { drop: lit || undefined })} role="button" accessibilityState={{ disabled: off }} onPress={() => { if (!off) onPress(); }} onFocus={onFocus}
      style={[styles.top, lit ? { borderStyle: "solid", borderColor: t.accent, backgroundColor: t.accentSoft } : { borderStyle: "dashed", borderColor: t.line2 }, webStyle({ cursor: "pointer" })]}>
      <Text size={12} numberOfLines={1} tone={lit ? "text" : off ? "faint" : "muted"} style={styles.topText}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stretch: { alignSelf: "stretch" },
  frame: { flex: 1, minHeight: 0 },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", columnGap: 12 },
  body: { flex: 1, minHeight: 0, flexDirection: "row", gap: 14, marginTop: 12 },
  bodyCol: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", flexDirection: "column", alignSelf: "stretch" },
  side: { width: 290, minHeight: 0, gap: 8 },
  sideCol: { width: "100%" },
  listBox: { flex: 1, minHeight: 0, borderWidth: 1, borderRadius: 6, padding: 4, overflow: "hidden" },
  listBoxCol: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", height: 200 },
  listIn: { flexGrow: 1 },
  rows: { flexGrow: 1 },
  space: { flexGrow: 1, minHeight: 24 },
  empty: { padding: 10, textAlign: "center" },
  treeErr: { overflow: "hidden" },
  newRow: { flexDirection: "row", gap: 6, minHeight: 28 },
  edit: { flex: 1, minWidth: 0, minHeight: 0 },
  editCol: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", width: "100%" },
  none: { alignSelf: "center", padding: 16, marginVertical: 40, textAlign: "center" },
  menuNote: { paddingTop: 5, paddingBottom: 4, paddingHorizontal: 10, maxWidth: 220 },
  top: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  topText: { textAlign: "center" },
});
