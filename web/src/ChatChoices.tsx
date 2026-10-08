// The first two of a chat's five choices, before folder, model and effort in the composer's
// toolbar: the server the chat is on and its agent. Both can be changed until the first message,
// in a chat that is neither a fork nor a branch (agentOpen); the toolbar shows the agent only
// then, and the server also for a chat on another server (showsServer).
import React from "react";
import { useStore, getState, upsertChat, shownBranch } from "./store.ts";
import { api } from "./api.ts";
import { Picker } from "./Composer.tsx";
import { openServers } from "./Servers.tsx";
import { pickAgent, usableAgents } from "./logic/agentlist.ts";
import { AGENT_UNCONFIRMED, agentChoiceOn, pickServer, toolbarLine, type Where } from "./logic/chatserver.ts";
import { serverChoice, serverConnected, serverName, serverOf } from "./logic/serverlists.ts";
import { AgentGlyph, WarnIcon, agentClass, agentName } from "./icons.tsx";
import type { AgentKind, ChatView } from "./types.ts";
import "./remotechat.css";

type Menu = { disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void };
type Saves = { c: ChatView; onBusy: (busy: boolean) => void; onError: (msg: string) => void };

/** The entry id of the server a chat's board is on; none for a chat on no board and for a board
 *  of this computer. */
const useBoardServer = (c?: { board?: string }): string | undefined => useStore((s) => (c?.board ? s.boards[c.board]?.server : undefined));

/** A chat's server as its composer reads it (logic/chatserver.ts). A chat on a board of another
 *  server is on that server, also where its own record does not name it. */
export function useWhere(c?: { server?: string; board?: string }): Where {
  const onBoard = useBoardServer(c);
  const server = serverOf(c?.server ? c : { server: onBoard });
  const name = useStore((s) => serverName(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  return { server, name, connected };
}

/** The server choice: every entry of the server list, one that waits for the user disabled with
 *  its state, and "Servers…", which opens the Servers dialog. A pick is sent at once, and the
 *  answer is the chat with the agent, folder, model and effort the server chose for that server.
 *  Where the server cannot be changed (serverChoice's fixed) it is a chip with the reason; a chat
 *  on a board of another server is on that server. */
export function ServerPick({ c, disabled, open, onOpenChange, onBusy, onError }: Menu & Saves) {
  const servers = useStore((s) => s.servers);
  const w = useWhere(c);
  const { options, fixed } = serverChoice(servers, c, useBoardServer(c));
  if (fixed) return <span className={`tchip static server-chip ${w.connected ? "" : "off"}`} title={`Server — ${fixed}`}>{w.name}</span>;
  const pick = (id: string) => {
    onBusy(true);
    void pickServer((p) => api.configure(c.id, shownBranch(getState(), c.id), p), id, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  return <Picker className="server-pick" label={w.name} title="Server" value={w.server}
    options={options.map((o) => ({ id: o.id, label: o.label, note: o.reason, disabled: o.disabled }))}
    more={{ label: "Servers…", onClick: () => openServers() }}
    disabled={disabled} open={open} onOpenChange={onOpenChange} onPick={pick} />;
}

/** The agent choice: only the agents the chat's server can run. A pick is sent at once, and the answer
 *  is the chat with the model and effort the server chose for that agent. An agent the chat has
 *  and the server lacks is marked and is not among the options; with none to offer, and on a
 *  server that is not connected, the chip says "No agent". The line under the toolbar
 *  (toolbarLine) says why, as it does for a chat with no agent and for a first message that got
 *  no answer, whose agent is fixed.
 *  onBusy: a pick is being saved, and the toolbar's pickers take none meanwhile. */
export function AgentPick({ c, disabled, open, onOpenChange, onBusy, onError }: Menu & Saves) {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, c.agent);
  const line = toolbarLine(w, usable, c);
  const glyph = (a: AgentKind) => <span className={`agent-pick-glyph agent-${agentClass(a)}`}><AgentGlyph agent={a} size={12} /></span>;
  const pick = (id: string) => {
    onBusy(true);
    void pickAgent((p) => api.configure(c.id, shownBranch(getState(), c.id), p), id as AgentKind, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  return (
    <>
      {c.start === "unconfirmed" ? <span className="tchip static" title={`Agent — ${AGENT_UNCONFIRMED}`}>{c.agent ? <>{glyph(c.agent)}{agentName(c.agent)}</> : "No agent"}</span>
        : !choice.options.length ? <span className="tchip static missing" title={`Agent — ${choice.reason}`}>No agent</span>
        : <Picker label={c.agent ? agentName(c.agent) : "No agent"} title="Agent" hint={choice.reason || undefined} value={c.agent}
          icon={!c.agent ? undefined : choice.missing ? <span className="agent-pick-glyph missing"><WarnIcon /></span> : glyph(c.agent)}
          options={choice.options.map((a) => ({ id: a, label: agentName(a), icon: glyph(a) }))}
          disabled={disabled} open={open} onOpenChange={onOpenChange} onPick={pick} />}
      {/* not installed or not connected, as against still to be chosen */}
      {line.text && <div className={`agent-reason ${line.tone}`}>{line.text}</div>}
    </>
  );
}
