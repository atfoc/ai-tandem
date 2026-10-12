// The Subagents chip of the composer's toolbar and its popover: a chat's two subagent settings,
// how many levels of subagents it may have (Depth) and how many may run at the same time (Running
// at once). Both can be changed until the first message, in a chat that is neither a fork nor a
// branch; after that the chip shows them fixed (logic/subsettings.ts subChip).
import React, { useEffect, useRef } from "react";
import { getState, shownBranch, upsertChat } from "./store.ts";
import { api } from "./api.ts";
import { UNTIL_FIRST_MESSAGE } from "./Composer.tsx";
import { capOff, capOptions, depthNote, depthOptions, pickSubs, subChange, subChipLabel, subChipTitle, subSettings, type SubOption } from "./logic/subsettings.ts";
import type { ChatView } from "./types.ts";

/** fixed: why the settings cannot be changed ("" while they can): the chip then opens nothing.
 *  A pick is sent at once and the popover stays open, so both settings can be set in one visit;
 *  the answer is the chat with the new values. A click outside or Esc closes it.
 *  disabled: the composer sends, or another of the toolbar's changes is being saved: the chip
 *  opens nothing and the popover takes no pick meanwhile. onBusy: a pick is being saved. */
export function SubagentsPick({ c, fixed, disabled, open, onOpenChange, onBusy, onError }: {
  c: ChatView; fixed: string; disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void; onBusy: (busy: boolean) => void; onError: (msg: string) => void;
}) {
  const s = subSettings(c);
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const shown = open && !fixed;
  const id = React.useId();

  // Esc closes the popover, before the composer (where it would stop the agent) and the layers under it see it.
  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onOpenChange(false); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [shown]);
  // Opening puts the focus on the current depth, so the arrows and Enter work at once; closing
  // hands it back to the chip, from any close path.
  useEffect(() => {
    if (!shown) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      chip.current?.focus();
      return;
    }
    wasOpen.current = true;
    pop.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [shown]);
  // Placed once, when it opens: over the chip, at its left edge, moved left by what its right edge
  // would pass the window's (less a 12px margin), never past the window's left edge. It stays
  // there while it is open: a pick can make the chip's label longer, which sends other controls
  // of the toolbar into its "more" popup and moves the chip, and the rows must not move under
  // the pointer. (The toolbar keeps the chip in its row meanwhile: logic/composerfit.ts, pinned.)
  React.useLayoutEffect(() => {
    const el = pop.current, at = chip.current;
    if (!el || !at) return;
    const r = at.getBoundingClientRect();
    el.style.position = "fixed";
    el.style.left = `${Math.max(Math.min(r.left, window.innerWidth - 12 - el.offsetWidth), 0)}px`;
    el.style.bottom = `${window.innerHeight - r.top + 6}px`;
  }, [shown]);

  const label = <><span className="tchip-pre">Subagents</span>{subChipLabel(s)}</>;
  if (fixed) return <span className="tchip static sub-chip" title={subChipTitle(s, fixed)}>{label}</span>;

  const pick = (section: "depth" | "cap", value: number) => {
    const change = subChange(s, section, value);
    if (!change || disabled) return;
    onBusy(true);
    void pickSubs((p) => api.configure(c.id, shownBranch(getState(), c.id), p), change, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  // The arrows go through the rows that take a pick, of both sections.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep Excalidraw's shortcuts out of the popover
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(pop.current?.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement), down = e.key === "ArrowDown";
    rows[at < 0 ? (down ? 0 : rows.length - 1) : (at + (down ? 1 : rows.length - 1)) % rows.length]?.focus();
  };
  const off = capOff(s);
  const row = (section: "depth" | "cap", o: SubOption, dead = false) => (
    <button key={o.value} type="button" role="radio" aria-checked={o.on} aria-disabled={dead || undefined}
      title={section === "depth" ? depthNote(o.value) : undefined}
      className={`menu-item pick ${o.on ? "on" : ""}`} onClick={() => { if (!dead) pick(section, o.value); }}>
      <span className="menu-label">{o.label}</span>
      {o.on && <span>✓</span>}
    </button>
  );
  return (
    <div className="menu-wrap">
      <button ref={chip} className="tchip sub-chip" aria-expanded={open} aria-haspopup="dialog" aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) onOpenChange(!open); }} title={subChipTitle(s, UNTIL_FIRST_MESSAGE)}>
        {label}<span className="caret">▾</span>
      </button>
      {open && (
        <div ref={pop} className="menu up sub-pop" role="dialog" aria-label="Subagents" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div className="menu-head" id={`${id}-depth`}>Depth</div>
          <div role="radiogroup" aria-labelledby={`${id}-depth`}>{depthOptions(s).map((o) => row("depth", o))}</div>
          <div className="menu-sep" />
          <div className={`sub-pop-cap ${off ? "off" : ""}`} title={off ? "With depth Off no subagent runs" : undefined}>
            <div className="menu-head" id={`${id}-cap`}>Running at once</div>
            <div role="radiogroup" aria-labelledby={`${id}-cap`} aria-disabled={off || undefined}>{capOptions(s).map((o) => row("cap", o, off))}</div>
          </div>
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={() => onOpenChange(false)} />}
    </div>
  );
}
