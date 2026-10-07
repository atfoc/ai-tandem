// The transcript of one of a run's own agents (an orchestrator turn, a task attempt, a merge) in
// the panel beside the run, where the run's chats show: the chat's own header and thread,
// read-only, and one line where a chat has its composer. The agent is held while this is mounted.
import { useRef } from "react";
import "./shell.css";
import { useStore, closeRunAgent, chatTitle, isBusy, boardName, threadOf } from "../store.ts";
import { ChatHeader, Thread } from "../ChatView.tsx";
import { modelLabel, effortLabel } from "../Composer.tsx";
import { useNow } from "../Subagents.tsx";
import { fmtDuration } from "../logic/subagents.ts";
import { statusText } from "../logic/labels.ts";
import { AGENT_ENDED, agentMs, agentTitle, money, tokensShort } from "../logic/runview.ts";
import { useAgent } from "./useAgent.ts";
import { catalogFor } from "../logic/agentlist.ts";
import { serverOf } from "../logic/serverlists.ts";

/** The header: what the run calls the agent, and under it one line: what it is doing (or how it
 *  ended) and how long it ran first, so that what changes stays in view when the line is cut, then
 *  its tier, model and effort, its cost and its fullest context. The whole line is its title. It
 *  alone follows the clock: the thread beside it does not render with every second. */
function Head({ runId, agentId }: { runId: string; agentId: string }) {
  const held = useStore((s) => s.agents[agentId]);
  // The run's record of the agent; the last one known while the detail is being fetched again.
  const rec = useStore((s) => s.runDetail[runId]?.agents[agentId]);
  const last = useRef(rec);
  if (rec) last.current = rec;
  const a = rec ?? last.current;
  const cat = useStore((s) => { const r = s.runs[runId]; return r ? catalogFor(s, serverOf(r), r.agent) : undefined; });
  const running = a?.status === "running";
  const now = useNow(running);
  const m = a && cat?.models.find((x) => x.id === a.model);
  const facts = !a ? "" : [
    running ? (held && isBusy(held.status) ? statusText(held, boardName) : "Running") : AGENT_ENDED[a.status] ?? "",
    fmtDuration(agentMs(a, now)),
    a.tier, modelLabel(a, cat), a.effort ? effortLabel(a.effort, m) : "", typeof a.cost === "number" ? money(a.cost) : "", a.peakContext ? `peak ${tokensShort(a.peakContext)}` : "",
  ].filter(Boolean).join(" · ");
  return <ChatHeader chatId={agentId} agent={{ title: a ? agentTitle(a) : held?.name ?? agentId, facts: <span title={facts}>{facts}</span>, onClose: closeRunAgent }} />;
}

/** back: the chat of the run the transcript lies over (its id), which the foot leads back to. */
export function AgentPane({ runId, agentId, back }: { runId: string; agentId: string; back: string | null }) {
  useAgent(agentId);
  const chat = useStore((s) => (back && s.chats[back] ? chatTitle(s.chats[back], threadOf(s, back)?.items) : null));
  return (
    <>
      <Head runId={runId} agentId={agentId} />
      <Thread chatId={agentId} readOnly />
      <div className="agent-foot">
        <span>Read-only: this is the run's own agent.</span>
        {chat != null && <button type="button" className="link" title="Close the transcript (Esc)" onClick={closeRunAgent}>‹ Back to {chat}</button>}
      </div>
    </>
  );
}
