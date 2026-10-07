// The Servers dialog: the list of servers this app connects to, with add, edit, remove,
// "Test connection" and the fingerprint of a self-signed certificate to compare and accept.
// The sidebar's foot holds the button, which renders the dialog itself. Everything another
// server said (version, detail, message, agents, fingerprints) is shown as plain text.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, getState, setState } from "./store.ts";
import { confirm, reportError } from "./Dialogs.tsx";
import { serversApi, type ServerPatch } from "./serversapi.ts";
import { anyNotConnected, formError, formView, heldResult, insertServer, removeText, resultHeading, rowActions, rowResult, serversOf, stateLabel, stepText,
  type HeldResult, type ServerForm as Form, type ServerView, type TestResult } from "./logic/servers.ts";
import "./servers.css";

const EMPTY: Form = { name: "", address: "", secret: "", selfSigned: false, pin: "" };
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const texts = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map(String) : []);

/** The entry in the answer of an add, an edit or an accept. The store's entries come from the stream
 *  (`snapshot`, `servers`, `server_state`), whose events may be here before the answer: the answer's
 *  view only adds an entry the store does not have yet, and never replaces one. */
export function answered(v?: ServerView | null): void {
  if (v?.id) setState((s) => ({ servers: insertServer(s.servers, v) }));
}

/** The list the dialog reads when it opens: its notice, and the entries the store does not have. */
export function listed(l?: { servers?: ServerView[] | null; notice?: string } | null): void {
  setState((s) => ({ servers: serversOf(l ?? {}).servers.reduce(insertServer, s.servers), serversNotice: l?.notice ?? "" }));
}

/** Opens the dialog; with a form, on that form (an entry to add or, with an id, to edit). */
export function openServers(form?: Form): void { setState({ serversDialog: form ? { form } : {} }); }

/** The sidebar's button, with a dot while an entry is not connected. It renders the dialog too. */
export function ServersButton(): React.JSX.Element {
  const open = useStore((s) => !!s.serversDialog);
  const dot = useStore((s) => anyNotConnected(s.servers));
  return (
    <>
      <button className="servers-btn" title={dot ? "Servers: one is not connected" : "Servers"} aria-label="Servers" onClick={() => openServers()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="4.5" rx="1" /><rect x="2" y="9" width="12" height="4.5" rx="1" /><path d="M4.5 4.75h.01M4.5 11.25h.01" strokeLinecap="round" />
        </svg>
        {dot && <span className="servers-dot" />}
      </button>
      {open && createPortal(<ServersDialog />, document.body)}
    </>
  );
}

export function ServersDialog(): React.JSX.Element | null {
  const dlg = useStore((s) => s.serversDialog);
  const servers = useStore((s) => s.servers);
  const notice = useStore((s) => s.serversNotice);
  // n counts the forms opened, so that a second one starts from its own values.
  const [open, setOpen] = useState<{ form: Form; n: number } | null>(() => (dlg?.form ? { form: dlg.form, n: 0 } : null));
  const [err, setErr] = useState("");
  const close = () => { setOpen(null); setState({ serversDialog: null }); };
  // A form the dialog was opened with is taken once: it stays in this component alone.
  useEffect(() => {
    const form = dlg?.form;
    if (!form) return;
    setOpen((o) => ({ form, n: (o?.n ?? 0) + 1 }));
    setState({ serversDialog: {} });
  }, [dlg?.form]);
  // The notice, which no snapshot carries. The entries are the stream's.
  useEffect(() => {
    if (!dlg) return;
    serversApi.list().then(listed, (e) => setErr(said(e)));
  }, [!dlg]);
  // The focus goes back to what had it when the dialog opened, if that is still there.
  useEffect(() => {
    if (!dlg) return;
    const before = document.activeElement;
    return () => { if (before instanceof HTMLElement && before.isConnected && (document.activeElement === document.body || !document.activeElement)) before.focus({ preventScroll: true }); };
  }, [!dlg]);
  // Esc leaves the form, then the dialog. In the bubble phase: the confirm dialog above takes its own in capture.
  useEffect(() => {
    if (!dlg) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || getState().confirm) return;
      e.preventDefault();
      if (open) setOpen(null); else close();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [!dlg, !open]);
  if (!dlg) return null;
  return (
    <div className="servers-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !open) close(); }}>
      <div className="servers-dialog" role="dialog" aria-modal="true" aria-label="Servers">
        {open ? <ServerForm key={open.n} initial={open.form} onClose={() => setOpen(null)} /> : (
          <>
            <div className="dialog-title">Servers</div>
            {notice && <div className="servers-notice">{notice}</div>}
            {err && <div className="dialog-err">{err}</div>}
            <div className="servers-list">
              {servers.map((v) => <ServerRow key={v.id} v={v} onEdit={(x) => setOpen((o) => ({ form: editForm(x), n: (o?.n ?? 0) + 1 }))} />)}
            </div>
            <div className="dialog-actions">
              <button className="btn sm" onClick={close}>Close</button>
              <button className="btn sm primary" autoFocus onClick={() => setOpen((o) => ({ form: EMPTY, n: (o?.n ?? 0) + 1 }))}>Add server</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** An entry's edit form: the secret empty, which keeps the stored one. */
const editForm = (v: ServerView): Form => ({ id: v.id, name: v.name, address: v.address ?? "", secret: "", selfSigned: !!v.selfSigned, pin: v.pin ?? "" });

/** A test's answer, as plain text. step = the line of the step a failed test stopped at; accept = the fingerprint to compare; pinned = the one held so far. */
function Result({ ok, message, step, detail, version, agents, accept, pinned }: {
  ok: boolean; message?: string; step?: string; detail?: string; version?: string; agents?: unknown; accept?: string; pinned?: string;
}): React.JSX.Element | null {
  const list = texts(agents);
  if (!message && !detail && !accept) return null;
  return (
    <div className={`servers-result ${ok ? "ok" : "bad"}`} role="status">
      {message && <div className="servers-result-msg">{message}</div>}
      {step && <div className="servers-line servers-step">{step}</div>}
      {detail && <div className="servers-line">{detail}</div>}
      {version && <div className="servers-line">Version {version}</div>}
      {list.length > 0 && <div className="servers-line">Agents: {list.join(", ")}</div>}
      {pinned && <div className="servers-line">Accepted before <span className="servers-fp">{pinned}</span></div>}
      {accept && <div className="servers-line">{pinned ? "Presented now" : "Fingerprint"} <span className="servers-fp">{accept}</span></div>}
    </div>
  );
}

/** One entry. result = a test's answer to start with. */
export function ServerRow({ v, onEdit, result = null }: { v: ServerView; onEdit?: (v: ServerView) => void; result?: TestResult | null }): React.JSX.Element {
  // The answer is kept with the state the entry had when it came, and dropped once the entry is in another.
  const [held, setHeld] = useState<HeldResult | null>(() => (result ? { result, state: v.state } : null));
  const state = useRef(v.state);
  state.current = v.state;
  const r = heldResult(held, v.state);
  useEffect(() => { setHeld((h) => (heldResult(h, v.state) ? h : null)); }, [v.state]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const acts = rowActions(v);
  const attempt = async (f: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await f(); } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  // A test of the entry as saved; the local server reads the certificate before it sends anything.
  const test = () => attempt(async () => { const res = await serversApi.testSaved(v.id); setHeld(res ? { result: res, state: state.current } : null); });
  const accept = (fingerprint: string) => attempt(async () => {
    const a = await serversApi.accept(v.id, fingerprint);
    setHeld(null);
    answered(a?.server);
  });
  const remove = async () => {
    setBusy(true); setErr("");
    try {
      const n = await serversApi.items(v.id);
      confirm({
        title: "Remove server", body: removeText(v.name, n?.chats ?? 0, n?.runs ?? 0),
        actions: [{ label: "Remove", tone: "danger", run: async () => { await serversApi.remove(v.id); setState((s) => ({ servers: s.servers.filter((x) => x.id !== v.id) })); } }],
      });
    } catch (e) { reportError("Couldn't remove the server", e); } finally { setBusy(false); }
  };
  const tone = v.state === "connected" ? "ok" : v.state === "connecting" ? "wait" : "bad";
  const agents = texts(v.agents);
  // What the test's answer adds to the row's own lines: each fact is shown once.
  const shown = rowResult(v, r);
  const fp = shown.accept ?? "";
  return (
    <div className="servers-row">
      <div className="servers-row-head">
        <span className="servers-name">{v.name}</span>
        <span className={`servers-state ${tone}`}>{stateLabel(v.state)}</span>
      </div>
      {v.address && <div className="servers-line servers-addr">{v.address}</div>}
      {v.detail && <div className="servers-line">{v.detail}</div>}
      {v.version && <div className="servers-line">Version {v.version}</div>}
      {agents.length > 0 && <div className="servers-line">Agents: {agents.join(", ")}</div>}
      {!shown.ownCert ? null : v.state === "certificate_changed" ? (
        <>
          {v.pin && <div className="servers-line">Accepted before <span className="servers-fp">{v.pin}</span></div>}
          {v.fingerprint && <div className="servers-line">Presented now <span className="servers-fp">{v.fingerprint}</span></div>}
        </>
      ) : v.pin && <div className="servers-line">Fingerprint <span className="servers-fp">{v.pin}</span></div>}
      {r && <Result ok={r.ok} message={resultHeading(shown, r.ok)} step={shown.step} detail={shown.detail} version={shown.version} agents={shown.agents} accept={fp} pinned={shown.pinned} />}
      {err && <div className="dialog-err">{err}</div>}
      {(acts.length > 0 || fp) && (
        <div className="servers-row-actions">
          {fp ? <button className="btn sm primary" disabled={busy} onClick={() => accept(fp)}>Accept fingerprint</button>
            : acts.includes("accept") && v.fingerprint ? <button className="btn sm primary" disabled={busy} onClick={() => accept(v.fingerprint!)}>Accept fingerprint</button>
            : acts.includes("showFingerprint") && <button className="btn sm primary" disabled={busy} onClick={test}>Show fingerprint</button>}
          {acts.includes("test") && <button className="btn sm" disabled={busy} onClick={test}>Test connection</button>}
          {acts.includes("edit") && <button className="btn sm" disabled={busy} onClick={() => onEdit?.(v)}>Edit</button>}
          {acts.includes("remove") && <button className="btn sm" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      )}
    </div>
  );
}

/** An edit sends what changed, so that a new name alone does not connect again; an empty secret keeps the stored one. */
function patchOf(f: Form, was: Form): ServerPatch {
  const p: ServerPatch = {};
  if (f.name !== was.name) p.name = f.name;
  if (f.address !== was.address) p.address = f.address;
  if (f.secret) p.secret = f.secret;
  if (f.selfSigned !== was.selfSigned) p.selfSigned = f.selfSigned;
  if (f.pin !== was.pin) p.pin = f.pin;
  return p;
}

/** The add and edit form. The secret is held here alone, and dropped at save and at close.
 *  result = a test's answer of the initial form to start with. */
export function ServerForm({ initial, onClose, result = null }: { initial: Form; onClose: () => void; result?: TestResult | null }): React.JSX.Element {
  const [f, setF] = useState<Form>(initial);
  const [tested, setTested] = useState<Form | null>(result ? initial : null);
  const [r, setR] = useState<TestResult | null>(result);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const problem = formError(f);
  const view = formView(f, tested, r, initial);
  const current = view.message !== undefined ? r : null; // the answer of the form as it is now
  const done = () => { setF((x) => ({ ...x, secret: "" })); onClose(); };
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));

  const runTest = async (form: Form) => {
    setBusy(true); setErr("");
    try {
      const res = form.id
        ? await serversApi.testSaved(form.id, { address: form.address, selfSigned: form.selfSigned, pin: form.pin, ...(form.secret ? { secret: form.secret } : {}) })
        : await serversApi.test(form);
      setTested(form); setR(res);
    } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  // The fingerprint goes into the form, and the test runs again: only now is the secret sent.
  const accept = (fingerprint: string) => { const next = { ...f, selfSigned: true, pin: fingerprint }; setF(next); void runTest(next); };
  const save = async (force: boolean) => {
    const sent = f;
    setBusy(true); setErr("");
    try {
      const a = sent.id ? await serversApi.edit(sent.id, patchOf(sent, initial), force) : await serversApi.add(sent, force);
      answered(a?.server);
      if (a?.saved) return done();
      // The local server ran the test itself, and it did not pass.
      setTested(sent); setR(a?.result ?? null);
      if (!a?.result) setErr("The server was not saved.");
      setBusy(false);
    } catch (e) { setErr(said(e)); setBusy(false); }
  };

  return (
    <form className="servers-form" onSubmit={(e) => { e.preventDefault(); if (busy) return; if (view.canSave) void save(!!view.force); else if (!problem) void runTest(f); }}>
      <div className="dialog-title">{f.id ? "Edit server" : "Add server"}</div>
      <label className="servers-field"><span>Name</span>
        <input type="text" value={f.name} autoFocus maxLength={80} placeholder="Studio" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="servers-field"><span>Address</span>
        <input type="text" value={f.address} placeholder="https://host:port" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(e) => set({ address: e.target.value })} />
      </label>
      <label className="servers-field"><span>Secret</span>
        <input type="password" value={f.secret} autoComplete="off" placeholder={f.id ? "unchanged" : ""} onChange={(e) => set({ secret: e.target.value })} />
      </label>
      <label className="servers-check">
        <input type="checkbox" checked={f.selfSigned} onChange={(e) => set({ selfSigned: e.target.checked, pin: e.target.checked ? f.pin : "" })} />
        Self-signed certificate
      </label>
      {f.selfSigned && f.pin && <div className="servers-line">Accepted fingerprint <span className="servers-fp">{f.pin}</span></div>}
      {problem && (f.name || f.address || f.secret) && <div className="servers-line">{problem}</div>}
      <Result ok={!!current?.ok} message={view.message} step={current && !current.ok ? stepText(current.step) : ""} detail={view.detail} version={current?.version} agents={current?.agents} accept={view.accept} pinned={view.pinned} />
      {err && <div className="dialog-err">{err}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn sm" onClick={done}>Cancel</button>
        <button type="button" className="btn sm" disabled={busy || !!problem} onClick={() => runTest(f)}>{busy ? "Working…" : "Test connection"}</button>
        {view.accept && <button type="button" className="btn sm primary" disabled={busy} onClick={() => accept(view.accept!)}>Accept fingerprint</button>}
        {view.saveAnyway && <button type="button" className="btn sm" disabled={busy} onClick={() => save(true)}>Save anyway</button>}
        <button type="button" className="btn sm primary" disabled={busy || !view.canSave} onClick={() => save(!!view.force)}>Save</button>
      </div>
    </form>
  );
}
