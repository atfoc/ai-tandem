// The Models chip of the goal composer and its popover: a model and an effort for the orchestrator
// and for each of the run's three tiers, with the chat's own pickers. Each pick is saved at once.
import React, { useEffect, useRef, useState } from "react";
import { Picker, effortLabel } from "../Composer.tsx";
import { tiersLabel } from "../logic/run.ts";
import { canResetTiers, orchestratorChoice, tiersReset, ORCHESTRATOR_ROW, TIER_ROWS } from "../logic/rungoal.ts";
import type { Catalog, RunView, TiersChange } from "../types.ts";

export function RunTiers({ r, cat, hint, onChange }: {
  r: RunView; cat: Catalog; hint: string; onChange: (tiers: TiersChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null); // the open picker: the tier and "m" or "e"
  const picking = useRef(pick);
  picking.current = pick;
  const pop = useRef<HTMLDivElement>(null);
  const modelOf = (id: string) => cat.models.find((x) => x.id === id);
  useEffect(() => {
    if (!open) { setPick(null); return; }
    // Esc closes the popover before anything else sees it; an open picker takes its own Esc first.
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !picking.current) { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  // Anchored at the chip's left edge and moved left by what passes the window's right edge, as
  // the settings form is.
  React.useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const over = Math.min(b.right - (window.innerWidth - 12), b.left);
    if (over > 0) el.style.left = `${-over}px`;
  }, [open]);
  const label = tiersLabel(r.tiers, (id) => modelOf(id)?.label);
  // The orchestrator's row shows the deep tier's choice until it has one of its own.
  const rows = [ORCHESTRATOR_ROW, ...TIER_ROWS];
  const choiceOf = (k: (typeof rows)[number][0]) => (k === "orchestrator" ? orchestratorChoice(r.tiers) : r.tiers[k]);
  return (
    <div className="menu-wrap">
      <button className="tchip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
        title={`Models: ${rows.map(([k, name]) => `${name} ${modelOf(choiceOf(k).model)?.label ?? (choiceOf(k).model || "none")}`).join(", ")} — ${hint}`}>
        <span className="tchip-pre">Models</span><span className="run-tiers-label">{label}</span><span className="caret">▾</span>
      </button>
      {open && (
        <div ref={pop} className="menu up usage-pop run-tiers" role="dialog" aria-label="Models of the orchestrator and by tier" onMouseDown={(e) => e.stopPropagation()}>
          <div className="menu-head">Models</div>
          <div className="run-field-foot top">The orchestrator gives every task one of three tiers.</div>
          {rows.map(([k, name, note]) => {
            const c = choiceOf(k), m = modelOf(c.model);
            return (
              <div className="run-tier" key={k} data-tier={k}>
                <span className="run-tier-name"><b>{name}</b><span>{note}</span></span>
                <Picker label={m?.label ?? (c.model || "Pick a model")} title={`${name} model`} hint={hint} value={c.model} searchable options={cat.models}
                  open={pick === k + "m"} onOpenChange={(o) => setPick(o ? k + "m" : null)} onPick={(id) => onChange({ [k]: { model: id } })} />
                {m?.efforts?.length ? (
                  <Picker label={effortLabel(c.effort, m)} title={`${name} effort`} hint={hint} value={c.effort ?? ""}
                    options={m.efforts.map((e) => ({ id: e, label: effortLabel(e, m) }))}
                    open={pick === k + "e"} onOpenChange={(o) => setPick(o ? k + "e" : null)} onPick={(id) => onChange({ [k]: { effort: id } })} />
                ) : <span className="tchip static run-tier-none" title="This model has no effort setting">—</span>}
              </div>
            );
          })}
          <div className="run-tier-foot">
            <button className="run-tier-reset" disabled={!canResetTiers(r)} onClick={() => r.tierDefaults && onChange(tiersReset(r.tierDefaults))}>Reset to the defaults</button>
          </div>
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}
