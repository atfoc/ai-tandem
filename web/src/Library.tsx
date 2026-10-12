// The prompt library's two popups (plans/prompt-library.md, sections 4, 5 and 7). The library popup,
// opened from the sidebar's foot, is a dialog of the Servers dialog's kind: a search, the tree of
// the libraries and an editor for what is chosen in it. Where an item is, is the tree's: a new one
// is made where the tree was right-clicked or beside what is chosen, and a prompt or a group is
// moved by dragging it (or by "Move…" of the menu, for the keys). The insert popup, opened from a composer's
// text box (logic/insert.ts), has the search and the list of prompts and puts the picked one's text
// into that box. Both show the libraries the page holds (store `libraries`, kept current by the
// stream), and everything a library says (names, texts, a refusal's sentence) is shown as plain text.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore, getState, setState, subscribe } from "./store.ts";
import { Menu, confirm } from "./Dialogs.tsx";
import { libraryApi } from "./libraryapi.ts";
import { insertItem, type LibraryView } from "./logic/library.ts";
import { insertKeyName, isInsertKey, onInsertPopup, type InsertTarget } from "./logic/insert.ts";
import { hasSearch } from "./logic/promptsearch.ts";
import { NEW_ROW, canMove, changeOf, chosenItem, chosenKey, deleteGroupText, deletePromptText, groupHolds, hasServerLevel, heldPlace, indentStep, isDirty, keysAbove, leaveText,
  libraryTrees, moveIn, nameProblem, newPlace, offText, orderLibraries, placeRows, placeText, promptList, rowPlace, sameChosen, samePlace, shownFields, textLine, topText, treeKey,
  treeRows, withNewRow, type Chosen, type Edits, type Fields, type Hit, type Place, type TreeRow } from "./logic/libraryview.ts";
import { Chevron, GroupIcon } from "./icons.tsx";
import "./library.css";

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KEY = insertKeyName(typeof navigator !== "undefined" ? navigator.platform : "");
const NO_FIELDS: Fields = { name: "", parent: "", text: "" };

/** The libraries in the order both popups show them. */
function useLibraries(): LibraryView[] {
  const libs = useStore((s) => s.libraries), servers = useStore((s) => s.servers);
  return useMemo(() => orderLibraries(libs, servers), [libs, servers]);
}

/** Opens the library popup. back: the text box whose insert popup it is opened from, which has its
 *  focus and its caret again when the popup closes. */
export function openLibrary(back?: InsertTarget): void { setState({ libraryDialog: back ? { back } : {} }); }

/** Opens the insert popup for a text box. Under a dialog nothing opens, and the box is as it was. */
export function openInsert(target: InsertTarget): void {
  const s = getState();
  if (s.confirm || s.serversDialog || s.libraryDialog) return target.cancel();
  if (s.insertPopup && s.insertPopup !== target) s.insertPopup.cancel();
  setState({ insertPopup: target });
}

/** Plugs the insert popup in, for the life of the app: ⌘P in a composer's text box and a composer's
 *  Insert button open it. While it is open ⌘P is its own, wherever the focus is in it and however
 *  long the key is held: the page is not printed. */
export function useInsertPopup(): void {
  useEffect(() => {
    const off = onInsertPopup(openInsert);
    const k = (e: KeyboardEvent) => { if (getState().insertPopup && isInsertKey(e, navigator.platform)) { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener("keydown", k, true);
    return () => { off(); window.removeEventListener("keydown", k, true); };
  }, []);
}

/** The sidebar's button, beside Servers and the theme picker. */
export function LibraryButton(): React.JSX.Element {
  return (
    <button className="library-btn" title="Prompt library" aria-label="Prompt library" aria-haspopup="dialog" onClick={() => openLibrary()}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 2.5h8.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z" /><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H13M6 5.5h4M6 8h2.5" />
      </svg>
    </button>
  );
}

/** Both popups, each drawn while it is open. */
export function LibraryPopups(): React.JSX.Element {
  const dlg = useStore((s) => s.libraryDialog), target = useStore((s) => s.insertPopup);
  return <>{dlg && <LibraryDialog back={dlg.back} />}{target && <InsertPopup target={target} />}</>;
}

/** Keeps Tab inside a popup: from its last control to its first, and back; from outside it, in. */
function keepTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const els = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter((x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0);
  if (!els.length) return;
  const at = document.activeElement, out = !at || !root.contains(at), edge = e.shiftKey ? els[0] : els[els.length - 1];
  if (!out && at !== edge) return;
  e.preventDefault();
  (e.shiftKey ? els[els.length - 1] : els[0]).focus();
}

/** Waits until the store is as `ok` says, a few seconds at most. A library's server sends the
 *  `library` event of a change before the call's answer, but on another line: the answer may be
 *  here first. Answers whether it was. */
function whenStore(ok: () => boolean, ms = 3000): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((done) => {
    const end = (v: boolean) => { off(); clearTimeout(t); done(v); };
    const off = subscribe(() => { if (ok()) end(true); });
    const t = setTimeout(() => end(false), ms);
  });
}

const PromptIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
);
const ServerIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1" /><rect x="2" y="9" width="12" height="4.5" rx="1" /></svg>
);

/** A prompt as a list shows it: its path, its name, and whether its server is not connected. */
function PromptLine({ h }: { h: Hit }): React.JSX.Element {
  return (
    <>
      <span className="lib-line">{h.path && <span className="lib-path">{h.path}/</span>}<span className="lib-pname">{h.prompt.name}</span></span>
      {h.off && <span className="lib-off">not connected</span>}
    </>
  );
}

// ---- the insert popup

function InsertPopup({ target }: { target: InsertTarget }): React.JSX.Element {
  const libs = useLibraries();
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null); // the key of the highlighted prompt; null = the first of the list
  const rows = useMemo(() => promptList(trees, query), [trees, query]);
  const any = useMemo(() => promptList(trees, "").length > 0, [trees]);
  const found = rows.findIndex((r) => r.key === picked), hi = found >= 0 ? found : rows.length ? 0 : -1;
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const listId = React.useId();
  // The popup is closed before the box is told: the box takes the focus, and nothing takes it back.
  const close = (text?: string) => {
    if (getState().insertPopup !== target) return;
    setState({ insertPopup: null });
    if (text === undefined) target.cancel(); else target.insert(text);
  };
  // The library popup takes the box over: it gives the focus and the caret back when it closes.
  const toLibrary = () => { if (getState().insertPopup === target) setState({ insertPopup: null, libraryDialog: { back: target } }); };
  useEffect(() => { input.current?.focus(); }, [target]);
  // Esc closes the popup before anything else hears it (a composer would stop its agent).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (getState().confirm) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } else keepTab(e, root.current);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [target]);
  useEffect(() => { if (hi >= 0) list.current?.querySelector(`[data-row="${hi}"]`)?.scrollIntoView({ block: "nearest" }); }, [hi, rows]);
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // (the canvas has shortcuts of its own)
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setPicked(rows[moveIn(rows.length, hi, e.key === "ArrowDown" ? 1 : -1)]?.key ?? null); return; }
    if (e.key !== "Enter" || e.target !== input.current || e.nativeEvent.isComposing) return; // (Enter on a button is that button's)
    e.preventDefault();
    if (hi >= 0) close(rows[hi].prompt.text); else if (!any) toLibrary();
  };
  return (
    // (the press beside the popup is not the browser's to act on: the box that has the focus again keeps it)
    <div className="ins-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); close(); } }}>
      <div ref={root} className="ins-dialog" role="dialog" aria-modal="true" aria-label="Insert a prompt" onKeyDown={keys}>
        <div className="ins-search">
          <input ref={input} className="menu-search-input" type="text" role="combobox" aria-controls={listId} aria-expanded={true} aria-autocomplete="list"
            aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined} aria-label="Search prompts" placeholder="Search prompts" spellCheck={false} autoComplete="off"
            value={query} onChange={(e) => { setQuery(e.target.value); setPicked(null); }} />
        </div>
        <div ref={list} className="ins-list" role="listbox" id={listId} aria-label="Prompts">
          {!any ? (
            <div className="ins-empty">
              <div>The library has no prompts yet.</div>
              <button type="button" className="btn sm primary" onClick={toLibrary}>Open the library</button>
            </div>
          ) : !rows.length ? <div className="menu-empty">No matching prompts</div> : rows.map((h, i) => (
            <div key={h.key} id={`${listId}-${i}`} data-row={i} role="option" aria-selected={i === hi} className={`ins-row ${i === hi ? "active" : ""}`}
              onMouseMove={() => { if (i !== hi) setPicked(h.key); }} onMouseDown={(e) => e.preventDefault()} onClick={() => close(h.prompt.text)}>
              <div className="ins-row-head"><PromptLine h={h} /></div>
              <div className="ins-text">{textLine(h.prompt.text) || "(no text)"}</div>
            </div>
          ))}
        </div>
        <div className="ins-foot">
          <span className="ins-hint">↑↓ to choose · Enter to insert · Esc to close</span>
          {any && <button type="button" className="btn sm" onClick={toLibrary}>Edit the library</button>}
        </div>
      </div>
    </div>
  );
}

// ---- the library popup

const closedRows = new Set<string>(); // the groups and servers closed in the tree; kept while the page is open
const PAD = 4;                        // a row's own space at the left edge; each level of depth adds the tree's step

/** The menu of a right click in the tree. at: where a new item goes, null when nothing can be made (no library is
 *  connected); off: the name of its server when that is not connected; item: the prompt or group of the row, which
 *  can be moved; key: the row, "" for the space under the rows. */
type TreeMenu = { x: number; y: number; key: string; at: Place | null; off: string; item: Chosen | null };

function LibraryDialog({ back }: { back?: InsertTarget }): React.JSX.Element {
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
  const [menu, setMenu] = useState<TreeMenu | null>(null);
  const [move, setMove] = useState<{ item: Chosen; by: "drag" | "keys" } | null>(null); // an item is on its way to another place: dragged, or picked up by the menu's "Move…"
  const [over, setOver] = useState<Place | null>(null);                // where it would land now; null where it cannot
  const [treeErr, setTreeErr] = useState("");                          // why a move was refused
  const [reveal, setReveal] = useState("");                            // the row of an item that was moved or made: it is scrolled to
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), nameInput = useRef<HTMLInputElement>(null), ctx = useRef<HTMLDivElement>(null);
  const kept = useRef<{ key: string; fields: Fields } | null>(null);   // the chosen item as it last was: it may be deleted under what was typed

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
  const close = () => leave(() => { setState({ libraryDialog: null }); back?.cancel(); });
  const choose = (c: Chosen) => { if (!fresh && sameChosen(c, chosen)) return; leave(() => { reset(); setTreeErr(""); setChosen(c); }); };
  const keepClosed = (next: Set<string>) => { closedRows.clear(); for (const k of next) closedRows.add(k); return next; };
  const toggle = (key: string) => setClosed((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return keepClosed(next); });
  /** Opens a place in the tree: its server, its group and the groups that group is in. */
  const openAt = (at: Place) => setClosed((was) => { const up = keysAbove(libs, at).filter((k) => was.has(k)); if (!up.length) return was; const next = new Set(was); for (const k of up) next.delete(k); return keepClosed(next); });
  const endMove = () => { setMove(null); setOver(null); };
  /** Starts a new item in a place: the tree shows where (the search gives way to it), and its name is typed in the editor. */
  const create = (what: "prompt" | "group", at: Place | null) => { if (at) leave(() => { reset(); setTreeErr(""); endMove(); setQuery(""); openAt(at); setFresh({ kind: what, at }); }); };

  // The search has the focus first. The focus goes back to what had it when the popup opened, if that is still there
  // (an insert popup's text box takes it itself); also from the question that closed the popup, which goes next.
  useEffect(() => {
    const before = document.activeElement;
    search.current?.focus();
    return () => {
      const at = document.activeElement, free = !at || at === document.body || !!at.closest(".dialog-backdrop");
      if (!back && free && before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  // An item that is gone with nothing typed over it leaves the editor; what was typed stays, and a save says why it cannot be.
  useEffect(() => { if (gone && !dirty) { const made = !!fresh; reset(); if (!made) setChosen(null); } }, [gone, dirty]);
  // A new item's name is typed first, and its row is on screen.
  useEffect(() => { if (fresh) { nameInput.current?.focus(); list.current?.querySelector("[data-new]")?.scrollIntoView({ block: "nearest" }); } }, [fresh]);
  // The focus is in the popup: when what had it went (a deleted item's buttons, the bar of a move), the search has it.
  useEffect(() => {
    if (!asking && (!document.activeElement || document.activeElement === document.body)) search.current?.focus({ preventScroll: true });
  }, [asking, chosen, fresh, move]);
  // A search shows no tree: its menu and a move end with it. So does the move of an item that is gone.
  useEffect(() => { if (searching) { setMenu(null); endMove(); } }, [searching]);
  const moving = move && chosenItem(libs, move.item) ? move : null;
  useEffect(() => { if (move && !moving) endMove(); }, [move, moving]);
  // Esc closes what is open on top: the menu, a move, then the popup, after the question for what is not saved. The
  // confirm dialog above takes its own.
  const escape = useRef(close);
  escape.current = () => (menu ? closeMenu() : moving ? cancelMove() : close());
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (getState().confirm) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); escape.current(); } else keepTab(e, root.current);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

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
      // What was typed stays in the editor until the library has moved on from what it held before the save: nothing
      // is shown as it was. (Moved on, not "as saved": another window's later save may be what it holds by now.)
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
  const rowEl = (key: string) => [...(list.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])].find((el) => el.dataset.key === key);
  const focusRow = (key: string) => { setFocused(key); rowEl(key)?.focus(); };
  const listKeys = (e: React.KeyboardEvent) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
    if (key === undefined) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rowEl(key)?.click(); return; }
    const at = keysOf.indexOf(key);
    if (e.key === "ArrowUp" && at === 0) { e.preventDefault(); search.current?.focus(); return; }
    let to: string | undefined;
    if (searching) to = e.key === "ArrowDown" ? keysOf[at + 1] : e.key === "ArrowUp" ? keysOf[at - 1] : e.key === "Home" ? keysOf[0] : e.key === "End" ? keysOf[keysOf.length - 1] : undefined;
    else { const k = treeKey(rows, key, e.key); if (k.toggle) { e.preventDefault(); toggle(k.toggle); } to = k.focus; }
    if (to) { e.preventDefault(); focusRow(to); }
  };
  const searchKeys = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && keysOf.length) { e.preventDefault(); focusRow(tab); }
    if (e.key === "Enter" && searching && hits.length && !e.nativeEvent.isComposing) { e.preventDefault(); choose({ kind: "prompt", server: hits[0].server, id: hits[0].prompt.id }); }
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
  const startMove = (it: Chosen) => { closeMenu(); setTreeErr(""); setOver(null); setMove({ item: it, by: "keys" }); };
  // (the line that says how a move by the keys goes takes room from the list: the row that is moved stays on screen)
  useEffect(() => { if (move?.by === "keys") rowEl(chosenKey(move.item))?.scrollIntoView({ block: "nearest" }); }, [move]);
  const cancelMove = () => { const it = moving?.item; if (moving?.by === "keys" && it && !list.current?.contains(document.activeElement)) focusRow(chosenKey(it)); endMove(); };
  /** In a move by the keys, the focused row is where the item would land; a click or Enter there lands it. */
  const landOn = (to: Place | null) => { const at = landing(to); if (moving && at) void moveTo(moving.item, at, "keys"); };
  /** Where a drag is over: the row's place, the bar's (the top), and the top for the space under the rows. */
  const dragPlace = (e: React.DragEvent): Place | null => {
    if (moving?.by !== "drag") return null; // (also whatever else is dragged over the tree: a file, a text)
    const el = e.target as HTMLElement, key = el.closest<HTMLElement>("[data-key]")?.dataset.key, row = key === undefined ? undefined : rows.find((r) => r.key === key);
    return landing(el.closest("[data-new]") ? freshAt : row ? rowPlace(row) : topOf);
  };
  const drop = {
    onDragOver: (e: React.DragEvent) => {
      if (moving?.by !== "drag") return;
      const to = dragPlace(e);
      setOver((was) => (samePlace(was, to) ? was : to));
      if (to) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
    },
    onDragLeave: (e: React.DragEvent) => { if (moving?.by === "drag" && (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget))) setOver(null); },
    onDrop: (e: React.DragEvent) => {
      const to = dragPlace(e);
      if (!moving || !to) return;
      e.preventDefault(); e.stopPropagation();
      void moveTo(moving.item, to, "drag");
    },
  };
  /** A drag of a row begins. Its end is heard on the row itself: once the row has left the page (its item deleted in
   *  another window) nothing else is told. Nothing of the page changes while the browser takes the drag up, so the
   *  move is known a task later: a row that shifts under the pointer during dragstart ends the drag at once (a list
   *  scrolled to its end shifts when it grows), and the picture that follows the pointer is the row as it was. For
   *  the same reason nothing that a drag shows changes the height of the list. */
  const dragStart = (e: React.DragEvent, r: TreeRow) => {
    const it: Chosen = { kind: r.kind, server: r.server, id: r.id };
    let ended = false;
    e.dataTransfer.setData("text/x-aiwb-library", r.key); e.dataTransfer.effectAllowed = "move";
    e.currentTarget.addEventListener("dragend", () => { ended = true; setMove((m) => (m?.by === "drag" ? null : m)); setOver(null); }, { once: true });
    setTimeout(() => { if (!ended) { setMenu(null); setOver(null); setMove({ item: it, by: "drag" }); } });
  };
  // A moved or a new item is on screen where it is now, and has the focus when a row had it.
  useEffect(() => {
    const el = reveal && rowEl(reveal);
    if (!el) { if (reveal && searching) setReveal(""); return; } // (a search shows no tree: the row is not waited for)
    el.scrollIntoView({ block: "nearest" });
    if (!document.activeElement || document.activeElement === document.body || list.current?.contains(document.activeElement)) el.focus({ preventScroll: true });
    setReveal("");
  }, [reveal, rows, searching]);

  // ---- the menu of a right click (or of the menu key on a row): a new item where it was opened, and "Move…"
  const openMenu = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement, node = el.closest<HTMLElement>("[data-key]"), key = node?.dataset.key ?? "";
    const row = searching ? undefined : rows.find((r) => r.key === key), hit = searching ? hits[keysOf.indexOf(key)] : undefined;
    const at = el.closest("[data-new]") ? freshAt : row ? rowPlace(row) : hit ? heldPlace(libs, { server: hit.server, group: hit.prompt.parent }) : newPlace(libs, null);
    e.preventDefault();
    // (opened by the menu key the event has no pointer: the menu is at its row)
    const box = (node ?? e.currentTarget).getBoundingClientRect(), inBox = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    const v = at ? lib(at.server) : undefined;
    setMenu({ x: inBox ? e.clientX : box.left + 24, y: inBox ? e.clientY : Math.min(box.bottom, box.top + 26), key, at, off: v && !v.connected ? v.name : "",
      item: row && row.kind !== "server" ? { kind: row.kind, server: row.server, id: row.id } : null });
  };
  /** Closes the menu; the focus it had goes back to its row. */
  function closeMenu(): void {
    if (menu && ctx.current?.contains(document.activeElement)) (rowEl(menu.key || tab) ?? search.current)?.focus();
    setMenu(null);
  }
  useEffect(() => { if (menu) ctx.current?.querySelector<HTMLElement>(".menu-item:not(:disabled)")?.focus(); }, [menu]);
  const menuKeys = (e: React.KeyboardEvent) => {
    const items = [...(ctx.current?.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)") ?? [])], at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? moveIn(items.length, at, 1) : e.key === "ArrowUp" ? moveIn(items.length, at, -1) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); items[to]?.focus(); }
  };

  // What is lit in the tree: where the moved item would land, or where the open menu makes a new one.
  const litAt = moving ? over : menu && !menu.off ? menu.at : null;
  const lit = litAt && !searching ? placeRows(drawn, litAt, level) : null;
  const guides = (depth: number) => Array.from({ length: depth }, (_, d) => <span key={d} className="lib-guide" style={{ left: PAD + d * step + 7 }} />);
  const treeRow = (r: TreeRow) => {
    const edge = { paddingLeft: PAD + r.depth * step }, mark = lit?.head === r.key ? "drop" : lit?.inside.has(r.key) ? "drop-in" : "";
    const icon = r.kind === "server" ? <ServerIcon /> : r.kind === "group" ? <GroupIcon /> : <PromptIcon />;
    if (r.key === NEW_ROW) return (
      <div key={r.key} data-new="" role="treeitem" aria-level={r.depth + 1} aria-selected={true} className={`lib-row ${r.kind} new on ${mark}`} style={edge}>
        {guides(r.depth)}{r.kind === "group" && <span className="lib-twist" />}{icon}
        <span className="lib-name">{r.name.trim() || `New ${r.kind}`}</span>
      </div>
    );
    const on = r.key === chosenAt, it: Chosen = { kind: r.kind, server: r.server, id: r.id }, moved = !!moving && sameChosen(moving.item, it);
    return (
      <div key={r.key} data-key={r.key} role="treeitem" aria-level={r.depth + 1} aria-expanded={r.open} aria-selected={on} tabIndex={r.key === tab ? 0 : -1} title={r.name}
        className={`lib-row ${r.kind} ${on ? "on" : ""} ${r.off ? "off" : ""} ${mark} ${moved ? "moved" : ""}`} style={edge}
        draggable={r.kind !== "server" && !r.off} onDragStart={(e) => dragStart(e, r)}
        onClick={() => (moving?.by === "keys" ? landOn(rowPlace(r)) : choose(it))} onDoubleClick={() => { if (r.open !== undefined && !moving) toggle(r.key); }}
        onFocus={() => { setFocused(r.key); if (moving?.by === "keys") setOver(landing(rowPlace(r))); }}>
        {guides(r.depth)}
        {r.open !== undefined && <span className={`lib-twist ${r.open ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}><Chevron /></span>}
        {icon}
        <span className="lib-name">{r.name}</span>
        {r.kind === "server" && r.off && <span className="lib-off">not connected</span>}
        {r.kind === "server" && <span className="lib-count">{r.count}</span>}
      </div>
    );
  };
  const hitRow = (h: Hit, i: number) => {
    const key = keysOf[i], on = key === chosenAt;
    return (
      <div key={key} data-key={key} role="option" aria-selected={on} tabIndex={key === tab ? 0 : -1} className={`lib-row hit ${on ? "on" : ""} ${h.off ? "off" : ""}`}
        onClick={() => choose({ kind: "prompt", server: h.server, id: h.prompt.id })} onFocus={() => setFocused(key)}>
        <PromptIcon /><PromptLine h={h} />
      </div>
    );
  };
  const movedName = moving ? chosenItem(libs, moving.item)?.name ?? "" : "";
  const toTop = landing(topOf);

  // ---- the editor
  const problem = shown && (fresh ? (shown.name.trim() ? nameProblem(shown.name) : "") : edits.name !== undefined ? nameProblem(shown.name) : "");
  const canSave = !!shown && !busy && !off && dirty && !nameProblem(shown.name) && (!fresh || !!freshAt);
  const set = (p: Edits) => setEdits((e) => ({ ...e, ...p }));
  const at = fresh ? freshAt : chosen && shown ? heldPlace(libs, { server: chosen.server, group: shown.parent }) : null;
  const editor = !kind || !shown ? null : (
    <form className="lib-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) { e.preventDefault(); void save(); } }}>
      <div className="lib-form-head">
        <span>{fresh ? `New ${fresh.kind}` : kind === "prompt" ? "Prompt" : "Group"}</span>
        {at && <span className="lib-where" title={fresh ? "Where it will be in the tree." : "Where it is in the tree. Drag it there to move it."}>{placeText(libs, at, level)}</span>}
      </div>
      {off && where && <div className="lib-notice">{offText(where.name)}</div>}
      {gone && <div className="lib-notice">{fresh ? `The library this ${kind} was to go into is no longer here.` : `This ${kind} is no longer in the library.`} What is typed here is kept.</div>}
      <label className="lib-field"><span>Name</span>
        <input ref={nameInput} type="text" value={shown.name} readOnly={off} spellCheck={false} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
      </label>
      {kind === "prompt" && (
        <label className="lib-field lib-text"><span>Text</span>
          <textarea value={shown.text} readOnly={off} spellCheck={false} onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      {problem && <div className="lib-problem">{problem}</div>}
      {err && <div className="dialog-err" role="alert">{err}</div>}
      <div className="lib-form-actions">
        {!fresh && <button type="button" className="btn sm" disabled={busy || off || gone} onClick={remove}>Delete</button>}
        <span className="grow" />
        {(fresh || dirty) && <button type="button" className="btn sm" disabled={busy} onClick={() => (fresh ? reset() : (setEdits({}), setErr("")))}>{fresh ? "Cancel" : "Revert"}</button>}
        <button type="submit" className="btn sm primary" disabled={!canSave} title="Save (⌘↵ or Ctrl+↵)">{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
  const about = chosen?.kind === "server" && !fresh && where ? (
    <div className="lib-about">
      <div className="lib-form-head">{where.name}</div>
      <div className="lib-hint">{count(where.prompts?.length ?? 0, "prompt")} in {count(where.groups?.length ?? 0, "group")}.</div>
      {!where.connected && <div className="lib-notice">{offText(where.name)}</div>}
    </div>
  ) : null;

  const notices = libs.filter((v) => v.notice);
  return (
    <div className="lib-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); close(); } }}>
      <div ref={root} className="lib-dialog" role="dialog" aria-modal="true" aria-label="Prompt library" onKeyDown={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <div className="dialog-title">Prompt library</div>
          <div className="lib-hint">{KEY} in a message box inserts a prompt</div>
        </div>
        {notices.map((v) => <div key={v.server} className="lib-notice">{level ? `${v.name}: ` : ""}{v.notice}</div>)}
        <div className="lib-body">
          <div className="lib-side">
            <div className="lib-search">
              <input ref={search} className="menu-search-input" type="text" aria-label="Search prompts" placeholder="Search prompts" spellCheck={false} autoComplete="off"
                value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={searchKeys} />
              {query && <button type="button" className="menu-search-clear" title="Clear search" aria-label="Clear search" onClick={() => { setQuery(""); search.current?.focus(); }}>×</button>}
            </div>
            <div ref={list} className={`lib-list ${lit?.all ? "drop" : ""}`} role={searching ? "listbox" : "tree"} aria-label={searching ? "Prompts found" : "Prompts"} onKeyDown={listKeys} onContextMenu={openMenu} {...drop}>
              {searching ? (hits.length ? hits.map(hitRow) : <div className="menu-empty">No matching prompts</div>)
                : drawn.length ? drawn.map(treeRow) : <div className="menu-empty">The library has no prompts yet.</div>}
            </div>
            {moving?.by === "keys" && <div className="lib-hint" role="status">Moving “{movedName}”: choose a group, or the top. Enter moves it there, Esc cancels.</div>}
            {treeErr && <div className="dialog-err" role="alert">{treeErr}</div>}
            {/* During a move the bar of the top level is where the buttons are, and as high: the list keeps its height. */}
            <div className="lib-new">
              {moving && topOf ? (
                <button type="button" data-top="" className={`btn sm lib-top ${samePlace(over, topOf) ? "drop" : ""}`} aria-disabled={!toTop} {...drop}
                  onClick={() => landOn(topOf)} onFocus={() => { if (moving.by === "keys") setOver(toTop); }}>{topText(lib(topOf.server)?.name ?? "", level)}</button>
              ) : (
                <>
                  <button type="button" className="btn sm" disabled={!startAt} onClick={() => create("prompt", startAt)}>New prompt</button>
                  <button type="button" className="btn sm" disabled={!startAt} onClick={() => create("group", startAt)}>New group</button>
                </>
              )}
            </div>
          </div>
          <div className="lib-edit">
            {editor ?? about ?? <div className="lib-none">Choose a prompt to edit it, or make a new one. Right-click in the list to make one there; drag a prompt or a group to move it.</div>}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn sm" onClick={close}>Close</button>
        </div>
        {menu && (
          <div ref={ctx} className="lib-ctx" style={{ left: Math.max(4, Math.min(menu.x, innerWidth - 216)), top: Math.max(4, Math.min(menu.y, innerHeight - 150)) }} onKeyDown={menuKeys}>
            <Menu onClose={closeMenu} label="Prompt library">
              <div className="menu-note lib-ctx-note">{!menu.at ? "No library is connected." : menu.off ? `${menu.off} is not connected: nothing can be changed there until it is back.` : placeText(libs, menu.at, level)}</div>
              <button type="button" role="menuitem" className="menu-item plain" disabled={!menu.at || !!menu.off} onClick={() => { const to = menu.at; setMenu(null); create("prompt", to); }}>New prompt</button>
              <button type="button" role="menuitem" className="menu-item plain" disabled={!menu.at || !!menu.off} onClick={() => { const to = menu.at; setMenu(null); create("group", to); }}>New group</button>
              {menu.item && <div className="menu-sep" />}
              {menu.item && <button type="button" role="menuitem" className="menu-item plain" disabled={!!menu.off} onClick={() => startMove(menu.item!)}>Move…</button>}
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
