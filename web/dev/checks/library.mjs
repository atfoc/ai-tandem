// The readers of the prompt library's popups for the checks of the new build (S11; a helper module: no dash in its name, so the runner does not take it for a check): the
// counterparts of the `seen()` and `shape()` functions of dev/checks/PL4.1-library.mjs, PL5.2-popup.mjs and PL6.1-tree.mjs, over testIDs. The testIDs (app/src/screens/library):
//   library-dialog   the library popup (a dialog, a sheet on the phone)      insert-popup   the insert popup
//   lib-search, lib-search-clear     the search of the library popup          insert-search  the insert popup's
//   lib-scroll   the list's scroll view; lib-edit the editor's column
//   lib-list [mode: tree | hits, drop]   the rows' container (role tree | listbox); lib-list-frame its bordered box (the space under the rows is its own)
//   lib-row [key, kind: server | group | prompt, depth, drop: drop | drop-in, moved, off, fixed, new, hit]  a row (role treeitem | option; aria-level, aria-expanded, aria-selected)
//     lib-name, lib-twist, lib-guide, lib-off, lib-count, lib-path, lib-pname   its parts
//   lib-empty, lib-none, lib-about, lib-hint (a move by the keys), lib-tree-err, lib-notice
//   lib-new (the buttons' place) with lib-new-prompt, lib-new-group, or lib-top [drop] (the bar of the top level, during a move)
//   lib-form [kind, fresh] with lib-form-head, lib-where, lib-name-input, lib-text-input, lib-problem, lib-err, lib-delete, lib-revert, lib-save, lib-notice
//   lib-menu (the popover or sheet) with lib-menu-note, lib-menu-item (told apart by text; aria-disabled)
//   insert-row [key, server] (role option, aria-selected) with lib-path, lib-pname, lib-off, insert-text; insert-list, insert-empty, insert-none, insert-open-library, insert-edit-library
//   confirm-dialog   the question
import { tidSel } from "./sel.mjs";

const T = tidSel;

/** In the page: what the library popup shows, the question above it, and where the focus is (the counterpart of PL4.1's and PL6.1's `seen`). */
export function seen() {
  const T = (id, data) => `[data-testid="${id}"]` + Object.entries(data ?? {}).map(([k, v]) => `[data-${k}="${v}"]`).join("");
  const q = (root, id) => root?.querySelector(T(id)), qa = (root, id) => [...(root?.querySelectorAll(T(id)) ?? [])];
  const text = (e) => e?.textContent ?? "", dlg = document.querySelector(T("library-dialog")), at = document.activeElement;
  const all = qa(dlg, "lib-row"), rows = all.filter((r) => r.dataset.new !== "true"), fresh = all.find((r) => r.dataset.new === "true");
  const name = (r) => text(q(r, "lib-name")), level = (r) => Number(r.getAttribute("aria-level"));
  const line = (r) => (r.dataset.hit === "true" ? text(q(r, "lib-path")) + text(q(r, "lib-pname")) : "  ".repeat(level(r) - 1) + name(r));
  const form = q(dlg, "lib-form"), menu = document.querySelector(T("lib-menu")), top = q(dlg, "lib-top"), ask = document.querySelector(T("confirm-dialog"));
  const list = q(dlg, "lib-list"), box = q(dlg, "lib-list-frame");
  const off = (b) => b.getAttribute("aria-disabled") === "true";
  const buttons = (root) => [...root.querySelectorAll('[role="button"]')];
  const askBox = ask && (ask.querySelector('[role="dialog"]') ?? ask);
  const heading = ask?.querySelector('[role="heading"]');
  const askButtons = ask ? buttons(ask).map((b) => text(b)) : [];
  return {
    open: document.querySelectorAll(T("library-dialog")).length, list: list?.getAttribute("role") ?? "", mode: list?.dataset.mode ?? "", rows: rows.map(line), drawn: all.map((r) => (r.dataset.new === "true" ? "+" : "") + line(r)),
    fresh: fresh ? line(fresh) : "", on: rows.filter((r) => r.getAttribute("aria-selected") === "true").map(line), onName: rows.filter((r) => r.getAttribute("aria-selected") === "true").map(name),
    off: rows.filter((r) => q(r, "lib-off")).map(line), closed: rows.filter((r) => r.getAttribute("aria-expanded") === "false").map(name),
    fixed: rows.filter((r) => r.dataset.fixed === "true" || r.dataset.kind === "server").map(name),
    says: text(q(dlg, "lib-empty")), none: text(q(dlg, "lib-none")), about: text(q(dlg, "lib-about")),
    form: form ? { head: text(q(form, "lib-form-head")), name: q(form, "lib-name-input").value, text: q(form, "lib-text-input")?.value ?? null, fixed: q(form, "lib-name-input").readOnly,
      where: text(q(form, "lib-where")), fields: [...form.querySelectorAll("input, textarea, select")].map((e) => e.tagName.toLowerCase()).join(),
      err: text(q(form, "lib-err")), notice: text(q(form, "lib-notice")), problem: text(q(form, "lib-problem")),
      off: buttons(form).filter(off).map(text), buttons: buttons(form).map(text) } : null,
    ask: ask ? { title: text(heading), body: text(heading?.nextElementSibling), err: text(ask.querySelector('[role="alert"]')), buttons: askButtons } : null,
    focus: !at || at === document.body ? "nothing" : at.matches(T("library-btn")) ? "button" : at.matches(T("lib-search")) ? "search" : at.matches(T("lib-row")) ? "row " + line(at).trim()
      : at.matches(T("lib-name-input")) ? "name" : at.matches(T("lib-menu-item")) ? "menu " + text(at) : at.matches(T("lib-top")) ? "top" : at.closest(T("confirm-dialog")) ? "question"
      : at.closest(T("library-dialog")) ? "popup " + at.tagName.toLowerCase() : at.tagName.toLowerCase() + "[" + (at.dataset.testid ?? "") + "]",
    lit: { head: all.filter((r) => r.dataset.drop === "drop").map(name), inside: all.filter((r) => r.dataset.drop === "drop-in").map(name), all: list?.dataset.drop === "true", top: top?.dataset.drop === "true" },
    moved: rows.filter((r) => r.dataset.moved === "true").map(name), top: top ? { text: text(top), off: off(top) } : null,
    hint: text(q(dlg, "lib-hint")), buttons: [...(q(dlg, "lib-new")?.querySelectorAll('[role="button"]') ?? [])].map(text), treeErr: qa(dlg, "lib-tree-err").map(text).join("|"),
    menu: menu ? { note: text(q(menu, "lib-menu-note")), items: qa(menu, "lib-menu-item").map((b) => text(b) + (off(b) ? " (off)" : "")), role: q(menu, "menu")?.getAttribute("role") ?? menu.querySelector('[role="menu"]')?.getAttribute("role") } : null,
    box: box ? (() => { const r = box.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })() : null,
  };
}

/** In the page: how the rows of the tree are set in (PL6.1's `shape`), in pixels from the left edge of the list's own space. start: where the first thing of the row is (its twist, or a
 *  prompt's icon); twist: the column of its twist; guides: the lines beside it; over, under: how far a line ends from the row's upper and lower edge; gap: the space between the row
 *  and the one above; room: the width its name has. */
export function shape() {
  const T = (id) => `[data-testid="${id}"]`;
  const frame = document.querySelector(T("lib-list-frame")), box = frame.getBoundingClientRect();
  const cs = getComputedStyle(frame), edge = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const x = (v) => Math.round((v - edge) * 10) / 10, rows = [...document.querySelector(T("lib-list")).querySelectorAll(T("lib-row"))];
  return rows.map((r, i) => {
    const b = r.getBoundingClientRect(), kids = [...r.children].filter((c) => c.dataset.testid !== "lib-guide"), first = kids[0].getBoundingClientRect();
    const twist = r.querySelector(T("lib-twist"))?.getBoundingClientRect(), lines = [...r.querySelectorAll(T("lib-guide"))].map((l) => l.getBoundingClientRect());
    return { name: r.querySelector(T("lib-name")).textContent, level: Number(r.getAttribute("aria-level")), kind: r.dataset.kind, start: x(first.left), twist: twist ? [x(twist.left), x(twist.right)] : null,
      guides: lines.map((l) => x(l.left)), over: Math.max(0, ...lines.map((l) => Math.abs(l.top - b.top))), under: Math.max(0, ...lines.map((l) => Math.abs(l.bottom - b.bottom))),
      gap: i ? Math.round((b.top - rows[i - 1].getBoundingClientRect().bottom) * 10) / 10 : 0, room: Math.round(r.querySelector(T("lib-name")).getBoundingClientRect().width) };
  });
}

/** In the page: what the insert popup shows, and where the focus is (PL5.2's `seen`). */
export function insertSeen() {
  const T = (id) => `[data-testid="${id}"]`;
  const text = (e) => e?.textContent ?? "", pop = document.querySelector(T("insert-popup")), at = document.activeElement;
  const opts = [...(pop?.querySelectorAll(T("insert-row")) ?? [])];
  const line = (r) => text(r.querySelector(T("lib-path"))) + text(r.querySelector(T("lib-pname")));
  const buttons = pop ? [...pop.querySelectorAll('[role="button"]')].map((b) => text(b).trim()) : [];
  return {
    open: document.querySelectorAll(T("insert-popup")).length, rows: opts.map(line), on: opts.filter((r) => r.getAttribute("aria-selected") === "true").map(line), off: opts.filter((r) => r.querySelector(T("lib-off"))).map(line),
    fields: pop?.querySelectorAll("input, textarea, select, [contenteditable]").length ?? 0, buttons,
    says: text(pop?.querySelector(T("insert-empty"))) || text(pop?.querySelector(T("insert-none"))),
    focus: !at || at === document.body ? "nothing" : at.matches(T("insert-search")) ? "search" : at.matches(T("composer-input")) ? "box" : at.matches(T("lib-search")) ? "library" : at.closest(T("insert-popup")) && at.getAttribute("role") === "button" ? "button"
      : at.tagName.toLowerCase() + "[" + (at.dataset.testid ?? "") + "]",
    selected: String(getSelection()), library: document.querySelectorAll(T("library-dialog")).length,
  };
}

/** What is wrong with how a tree is set in (PL6.1's `misshapen`): nothing, for one that reads as it is built. step: how far a level is set in at least; a tree that is not deep also has
 *  every row of a group right of that group's twist. */
export function misshapen(rows, { step, deep = false }) {
  const bad = [], up = []; // up[level - 1]: the row of that level the current row is under
  for (const r of rows) {
    up.length = r.level - 1;
    const parent = up[r.level - 2];
    if (r.guides.length !== r.level - 1) bad.push(`"${r.name}" (level ${r.level}) has ${r.guides.length} lines beside it`);
    r.guides.forEach((at, i) => { const t = up[i]?.twist; if (!t || at < t[0] || at > t[1]) bad.push(`line ${i + 1} beside "${r.name}" is at ${at}, not in the twist's column of "${up[i]?.name}" (${JSON.stringify(t)})`); });
    if (r.over > 0.5 || r.under > 0.5 || r.gap !== 0) bad.push(`the lines beside "${r.name}" have a gap: ${JSON.stringify({ over: r.over, under: r.under, gap: r.gap })}`);
    if (!parent && (r.start !== rows[0].start || r.start > 8)) bad.push(`"${r.name}" is at the top and starts at ${r.start}, the first row at ${rows[0].start}`);
    if (parent && r.start - parent.start < step) bad.push(`"${r.name}" starts ${r.start - parent.start} px right of "${parent.name}", which it is in`);
    if (parent && !deep && r.start < parent.twist[1]) bad.push(`"${r.name}" starts at ${r.start}, under the twist of "${parent.name}" (${JSON.stringify(parent.twist)})`);
    if ((r.kind === "prompt") !== !r.twist) bad.push(`"${r.name}" is a ${r.kind} and has ${r.twist ? "a" : "no"} twist`);
    if (r.room < 60) bad.push(`the name of "${r.name}" has ${r.room} px`);
    up[r.level - 1] = r;
  }
  return bad;
}

export { T };
