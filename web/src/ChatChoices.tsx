// What stands before folder, model and effort in the composer's toolbar: the name of the chat's
// server, for a chat of a section (showsServer), and the chat's agent. The server is where the
// chat was made, and is no choice; the agent can be changed
// until the first message, in a chat that is neither a fork nor a branch (agentOpen), and the
// toolbar shows it only then. The toolbar draws each in its row or in its "more" popup, and keeps
// the chip's width by what decides it (useServerChip, useAgentChip); the line that says why a
// chat has no agent is a component of its own (AgentReason).
import React from "react";
import { useStore, getState, upsertChat, shownBranch } from "./store.ts";
import { api } from "./api.ts";
import { ChipName, Picker } from "./Composer.tsx";
import { pickAgent, usableAgents } from "./logic/agentlist.ts";
import { agentChoiceOn, offWhy, toolbarLine, type Where } from "./logic/chatserver.ts";
import { serverConnected, serverFixed, serverName, serverOf } from "./logic/serverlists.ts";
import { widthKey } from "./logic/composerfit.ts";
import { AgentGlyph, WarnIcon, agentClass, agentName } from "./icons.tsx";
import type { AgentKind, ChatView } from "./types.ts";
import "./remotechat.css";

type Menu = { disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void };
type Saves = { c: ChatView; onBusy: (busy: boolean) => void; onError: (msg: string) => void };

/** A thing's server as its views read it (logic/chatserver.ts): of a chat or a board, whose key names the
 *  server it is on, or of a server named by its entry id (`server`: the folder browser's). connected: that server
 *  takes a call now, which for a section is while the page holds its tree. */
export function useWhere(of?: { id?: string } | { server: string } | null): Where {
  const server = of && "server" in of ? of.server : serverOf(of);
  const name = useStore((s) => serverName(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  return { server, name, connected };
}

/** Why a chat takes no call now (logic/chatserver.ts offWhy): its server is not connected, or no longer has it; "" for
 *  a chat that takes one, which a chat of this computer always does. chat: its key. */
export function useOffWhy(chat: string): string {
  const w = useWhere({ id: chat });
  const gone = useStore((s) => !!s.gone[chat]);
  return offWhy(w, gone);
}

/** The name of a chat's server: a chip that is no choice, with why in its title (serverFixed),
 *  greyed while that server is not connected. */
export function ServerChip({ c }: { c: ChatView }) {
  const w = useWhere(c);
  const fixed = serverFixed(c);
  return <span className={`tchip static server-chip ${w.connected ? "" : "off"}`} title={`Server — ${fixed}`}><ChipName full={`${w.name} — ${fixed}`}>{w.name}</ChipName></span>;
}

/** What decides the width of ServerChip: the server's name. */
export function useServerChip(c: ChatView): string {
  return widthKey("server", useWhere(c).name, { fixed: true });
}

/** The agent choice: only the agents the chat's server can run. A pick is sent at once, and the answer
 *  is the chat with the model and effort the server chose for that agent. An agent the chat has
 *  and the server lacks is marked and is not among the options; with none to offer, and on a
 *  server that is not connected, the chip says "No agent". The line under the toolbar
 *  (AgentReason) says why, as it does for a chat with no agent.
 *  onBusy: a pick is being saved, and the toolbar's pickers take none meanwhile. */
export function AgentPick({ c, disabled, open, onOpenChange, onBusy, onError }: Menu & Saves) {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, c.agent);
  const glyph = (a: AgentKind) => <span className={`agent-pick-glyph agent-${agentClass(a)}`}><AgentGlyph agent={a} size={12} /></span>;
  const pick = (id: string) => {
    onBusy(true);
    void pickAgent((p) => api.configure(c.id, shownBranch(getState(), c.id), p), id as AgentKind, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  return !choice.options.length ? <span className="tchip static missing" title={`Agent — ${choice.reason}`}>No agent</span>
    : <Picker label={c.agent ? agentName(c.agent) : "No agent"} title="Agent" hint={choice.reason || undefined} value={c.agent}
      icon={!c.agent ? undefined : choice.missing ? <span className="agent-pick-glyph missing"><WarnIcon /></span> : glyph(c.agent)}
      options={choice.options.map((a) => ({ id: a, label: agentName(a), icon: glyph(a) }))}
      disabled={disabled} open={open} onOpenChange={onOpenChange} onPick={pick} />;
}

/** What decides the width of AgentPick's chip: the agent's name or "No agent", whether it is a
 *  choice or a fixed chip, and the glyph or the mark before the name. */
export function useAgentChip(c: ChatView): string {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, c.agent);
  const fixed = !choice.options.length;
  const named = !!c.agent && !fixed;
  return widthKey("agent", named ? agentName(c.agent as AgentKind) : "No agent", { fixed, mark: !named ? "" : !fixed && choice.missing ? "warn" : "glyph" });
}

/** The line under the toolbar's controls of a chat whose agent can be chosen (toolbarLine): why it
 *  has none, or cannot use its own. A line of the
 *  toolbar's row, also while the agent's chip is in the "more" popup. */
export function AgentReason({ c }: { c: ChatView }) {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const gone = useStore((s) => !!s.gone[c.id]);
  const line = toolbarLine(w, usable, c, gone);
  return (
    <>
      {/* not installed or not connected, as against still to be chosen */}
      {line.text && <div className={`agent-reason ${line.tone}`}>{line.text}</div>}
    </>
  );
}
