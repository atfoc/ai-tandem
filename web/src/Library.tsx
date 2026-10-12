// The prompt library's two popups (plans/prompt-library.md, sections 4, 5 and 7). The library popup,
// opened from the sidebar's foot, is a dialog of the Servers dialog's kind: a search, the tree of
// the libraries and an editor for what is chosen in it. The insert popup, opened from a composer's
// text box (logic/insert.ts), has the search and the list of prompts and puts the picked one's text
// into that box. Both show the libraries the page holds (store `libraries`, kept current by the
// stream), and everything a library says (names, texts, a refusal's sentence) is shown as plain text.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore, getState, setState, subscribe } from "./store.ts";
import { confirm } from "./Dialogs.tsx";
import { libraryApi } from "./libraryapi.ts";
import { insertItem, type LibraryView } from "./logic/library.ts";
import { insertKeyName, isInsertKey, onInsertPopup, type InsertTarget } from "./logic/insert.ts";
import { hasSearch } from "./logic/promptsearch.ts";
import { TOP, changeOf, chosenItem, chosenKey, deleteGroupText, deletePromptText, groupHolds, hasServerLevel, isDirty, leaveText, libraryTrees, moveIn, nameProblem, newPlace,
  offText, orderLibraries, placeChoice, placeOf, placeValue, promptList, sameChosen, shownFields, textLine, treeKey, treeRows,
  type Chosen, type Edits, type Fields, type Hit, type TreeRow } from "./logic/libraryview.ts";
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

function LibraryDialog({ back }: { back?: InsertTarget }): React.JSX.Element {
  const libs = useLibraries();
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const asking = useStore((s) => !!s.confirm);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(closedRows));
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [fresh, setFresh] = useState<"prompt" | "group" | null>(null); // a new item is being made: its kind
  const [place, setPlace] = useState<string | null>(null);              // where the new item goes; null = beside what is chosen
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [focused, setFocused] = useState("");                          // the row of the list that Tab reaches
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const kept = useRef<{ key: string; fields: Fields } | null>(null);   // the chosen item as it last was: it may be deleted under what was typed

  const searching = hasSearch(query);
  const rows = useMemo(() => treeRows(trees, closed), [trees, closed]);
  const hits = useMemo(() => (searching ? promptList(trees, query) : []), [trees, query, searching]);
  const level = hasServerLevel(libs);
  const lib = (server: string) => libs.find((v) => v.server === server);

  // What the editor is on, and what of it is not saved.
  const kind = fresh ?? (chosen && chosen.kind !== "server" ? chosen.kind : null);
  const item = fresh ? undefined : chosenItem(libs, chosen);
  if (item && chosen) kept.current = { key: chosenKey(chosen), fields: item };
  const saved = fresh ? NO_FIELDS : item ?? (chosen && kept.current?.key === chosenKey(chosen) ? kept.current.fields : undefined);
  const shown = saved && shownFields(saved, edits);
  const dirty = fresh ? !!(edits.name?.trim() || edits.text) : !!saved && !!kind && isDirty(saved, edits, kind);
  const gone = !fresh && !!chosen && (chosen.kind === "server" ? !lib(chosen.server) : !item);
  const off = fresh ? false : !!chosen && lib(chosen.server)?.connected === false;
  // Where the item is: the groups it can be put in, and the one it is in. A new one starts beside what is chosen;
  // a place that went meanwhile (its server dropped) gives way to that start.
  const startAt = newPlace(libs, chosen);
  const choice = placeChoice(libs, fresh || !chosen || !kind ? null : { server: chosen.server, ...(kind === "group" ? { group: chosen.id } : {}) });
  const offered = (value: string | null): value is string => value !== null && choice.some((l) => l.places.some((p) => p.value === value));
  const placeNow = fresh ? (offered(place) ? place : startAt ? placeValue(startAt) : "") : chosen && shown ? placeValue({ server: chosen.server, group: shown.parent }) : "";

  const reset = () => { setEdits({}); setErr(""); setFresh(null); setPlace(null); };
  /** Does `then` at once, or after the user agreed to drop what is not saved. */
  const leave = (then: () => void) => {
    if (!dirty || !kind) return then();
    confirm({ ...leaveText(kind, shown?.name ?? ""), actions: [{ label: "Discard", tone: "danger", run: then }] });
  };
  const close = () => leave(() => { setState({ libraryDialog: null }); back?.cancel(); });
  const choose = (c: Chosen) => { if (!fresh && sameChosen(c, chosen)) return; leave(() => { reset(); setChosen(c); }); };
  const create = (what: "prompt" | "group") => leave(() => { reset(); setFresh(what); });
  const toggle = (key: string) => setClosed((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    closedRows.clear(); for (const k of next) closedRows.add(k);
    return next;
  });

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
  useEffect(() => { if (gone && !dirty) { reset(); setChosen(null); } }, [gone, dirty]);
  // A new item's name is typed first.
  useEffect(() => { if (fresh) nameInput.current?.focus(); }, [fresh]);
  // The focus is in the popup: when what had it went (a deleted item's buttons), the search has it.
  useEffect(() => {
    if (!asking && (!document.activeElement || document.activeElement === document.body)) search.current?.focus({ preventScroll: true });
  }, [asking, chosen, fresh]);
  // Esc closes the popup, after the question for what is not saved. The confirm dialog above takes its own.
  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (getState().confirm) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeNow.current(); } else keepTab(e, root.current);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  const save = async () => {
    if (busy || !kind || !saved || off) return;
    setBusy(true); setErr("");
    try {
      if (fresh) {
        const at = placeOf(placeNow), name = (edits.name ?? "").trim();
        const made = fresh === "prompt" ? (await libraryApi.createPrompt(at.server, name, at.group, edits.text ?? "")).prompt : (await libraryApi.createGroup(at.server, name, at.group)).group;
        const next: Chosen = { kind: fresh, server: at.server, id: made.id };
        // The library with the new item comes on the stream; one that did not come is given the item the server answered with.
        if (!await whenStore(() => !!chosenItem(getState().libraries, next))) setState((s) => ({ libraries: insertItem(s.libraries, at.server, fresh, { text: "", ...made }) }));
        reset(); setChosen(next); setFocused(chosenKey(next));
        return;
      }
      if (!chosen) return;
      const change = changeOf(saved, edits, kind), was = chosenItem(getState().libraries, chosen);
      if (kind === "prompt") await libraryApi.changePrompt(chosen.server, chosen.id, change); else await libraryApi.changeGroup(chosen.server, chosen.id, { name: change.name, parent: change.parent });
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
  const treeRow = (r: TreeRow) => {
    const on = r.key === chosenAt;
    return (
      <div key={r.key} data-key={r.key} role="treeitem" aria-level={r.depth + 1} aria-expanded={r.open} aria-selected={on} tabIndex={r.key === tab ? 0 : -1} title={r.name}
        className={`lib-row ${r.kind} ${on ? "on" : ""} ${r.off ? "off" : ""}`} style={{ paddingLeft: 4 + r.depth * 14 }}
        onClick={() => choose({ kind: r.kind, server: r.server, id: r.id })} onDoubleClick={() => { if (r.open !== undefined) toggle(r.key); }} onFocus={() => setFocused(r.key)}>
        <span className={`lib-twist ${r.open ? "open" : ""}`} onClick={r.open === undefined ? undefined : (e) => { e.stopPropagation(); toggle(r.key); }}>{r.open !== undefined && <Chevron />}</span>
        {r.kind === "server" ? <ServerIcon /> : r.kind === "group" ? <GroupIcon /> : <PromptIcon />}
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

  // ---- the editor
  const problem = shown && (fresh ? (shown.name.trim() ? nameProblem(shown.name) : "") : edits.name !== undefined ? nameProblem(shown.name) : "");
  const canSave = !!shown && !busy && !off && dirty && !nameProblem(shown.name) && (!fresh || !!placeNow);
  const set = (p: Edits) => setEdits((e) => ({ ...e, ...p }));
  const where = chosen && !fresh ? lib(chosen.server) : undefined;
  const editor = !kind || !shown ? null : (
    <form className="lib-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) { e.preventDefault(); void save(); } }}>
      <div className="lib-form-head">{fresh ? `New ${fresh}` : kind === "prompt" ? "Prompt" : "Group"}</div>
      {off && where && <div className="lib-notice">{offText(where.name)}</div>}
      {gone && <div className="lib-notice">This {kind} is no longer in the library. What is typed here is kept.</div>}
      <label className="lib-field"><span>Name</span>
        <input ref={nameInput} type="text" value={shown.name} readOnly={off} spellCheck={false} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="lib-field"><span>Group</span>
        <select value={placeNow} disabled={off || !choice.length} onChange={(e) => (fresh ? setPlace(e.target.value) : set({ parent: placeOf(e.target.value).group }))}>
          {fresh && level
            ? choice.map((l) => <optgroup key={l.server} label={l.name}>{l.places.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</optgroup>)
            : choice.flatMap((l) => l.places).map((p) => <option key={p.value} value={p.value}>{p.label === TOP && level && where ? `Top of ${where.name}` : p.label}</option>)}
        </select>
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
            <div ref={list} className="lib-list" role={searching ? "listbox" : "tree"} aria-label={searching ? "Prompts found" : "Prompts"} onKeyDown={listKeys}>
              {searching ? (hits.length ? hits.map(hitRow) : <div className="menu-empty">No matching prompts</div>)
                : rows.length ? rows.map(treeRow) : <div className="menu-empty">The library has no prompts yet.</div>}
            </div>
            <div className="lib-new">
              <button type="button" className="btn sm" disabled={!startAt} onClick={() => create("prompt")}>New prompt</button>
              <button type="button" className="btn sm" disabled={!startAt} onClick={() => create("group")}>New group</button>
            </div>
          </div>
          <div className="lib-edit">
            {editor ?? about ?? <div className="lib-none">Choose a prompt to edit it, or make a new one.</div>}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn sm" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
