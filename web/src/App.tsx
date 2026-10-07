// The window: the sidebar, and beside it the selected board or run (with its chat
// panel, which beside a run also shows the transcripts of the run's own agents), the
// selected plain chat, or the home screen.
import React, { useEffect } from "react";
import { useStore, setState, getState, viewedBranch, closeRunAgent } from "./store.ts";
import { Sidebar, newChat, newBoard, newRun, openBoard } from "./Sidebar.tsx";
import { ChatHeader, Thread } from "./ChatView.tsx";
import { Composer, focusComposer } from "./Composer.tsx";
import { Canvas } from "./Canvas.tsx";
import { ConfirmDialog, reportError } from "./Dialogs.tsx";
import { boardChats, groupPath } from "./logic/tree.ts";
import { isDraft } from "./logic/run.ts";
import { runPane } from "./logic/runview.ts";
import { homeAgentsText, usableAgents } from "./logic/agentlist.ts";
import { BoardIcon, ChatIcon, RunIcon } from "./icons.tsx";
import { RunBar } from "./run/RunBar.tsx";
import { RunComposer } from "./run/RunComposer.tsx";
import { RunView } from "./run/RunView.tsx";
import { AgentPane } from "./run/AgentPane.tsx";
import { Resizer } from "./Resizer.tsx";
import { Guard } from "./Guard.tsx";
import { SubagentDrawer } from "./Subagents.tsx";
import { TreePopup } from "./fork/TreePopup.tsx";
import type { Pane as PaneKind } from "./logic/layout.ts";
import { branchKey } from "./logic/branches.ts";
import { MAIN, UNGROUPED } from "./types.ts";

export function App() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.code === "KeyJ")) return;
      e.preventDefault(); e.stopPropagation();
      // The panel hides whatever it shows: a run agent's transcript closes with it.
      const s = getState();
      if (s.runAgent && s.runAgent.run === s.sel.run) { closeRunAgent(); setState({ panel: false }); } else setState({ panel: !s.panel });
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  return <><Grouped /><TreePopup /><ConfirmDialog /></>;
}

function Grouped() {
  const sel = useStore((s) => s.sel);
  const chat = useStore((s) => (sel.chat ? s.chats[sel.chat] : undefined));
  // The composer is one per branch: on another branch it goes away with its draft saved, and a new one opens with that branch's.
  const viewed = useStore((s) => (sel.chat ? viewedBranch(s, sel.chat) : MAIN));
  const board = useStore((s) => (sel.board ? s.boards[sel.board] : undefined));
  // (the run's id and whether its goal is sent, not its record: that changes with every task)
  const runId = useStore((s) => (sel.run && s.runs[sel.run] ? sel.run : null));
  const runDraft = useStore((s) => (sel.run && s.runs[sel.run] ? isDraft(s.runs[sel.run]) : false));
  const panel = useStore((s) => s.panel);
  const runAgent = useStore((s) => s.runAgent);
  const connecting = useStore((s) => s.role === "connecting" && !s.connected);

  let main: React.ReactNode;
  if (board) {
    const boardChat = chat && chat.board === board.id ? chat : undefined;
    main = (
      <>
        {boardChat && panel && (
          <Pane pane="panel" className="board-panel">
            <ChatHeader chatId={boardChat.id} />
            <Thread chatId={boardChat.id} />
            <Composer key={branchKey(boardChat.id, viewed)} chatId={boardChat.id} branch={viewed} />
          </Pane>
        )}
        <main className="board-stage">
          <BoardBar board={board.id} chatOpen={!!boardChat && panel} />
          <div className="board-canvas"><Canvas board={board.id} /></div>
        </main>
      </>
    );
  } else if (runId) {
    // The panel beside a run: a chat on the run, or over it the transcript of one of the run's own agents.
    const runChat = chat && chat.run === runId ? chat : undefined;
    const pane = runPane(runId, { runAgent, chat: runChat?.id ?? null, panel });
    main = (
      <>
        {pane && (
          <Pane pane="panel" className="board-panel">
            {"agent" in pane
              ? <AgentPane key={pane.agent} runId={runId} agentId={pane.agent} back={pane.back} />
              : (
                <>
                  <ChatHeader chatId={pane.chat} />
                  <Thread chatId={pane.chat} />
                  <Composer key={branchKey(pane.chat, viewed)} chatId={pane.chat} branch={viewed} />
                </>
              )}
          </Pane>
        )}
        <main className="board-stage run-stage">
          <RunBar run={runId} chatOpen={!!pane && "chat" in pane} />
          {runDraft ? <RunComposer key={runId} runId={runId} /> : <RunView key={runId} runId={runId} />}
        </main>
      </>
    );
  } else if (chat && !chat.board && !chat.run) {
    main = (
      <main className="chat-page">
        <ChatHeader chatId={chat.id} />
        <div className="chat-col">
          <Thread chatId={chat.id} />
          <Composer key={branchKey(chat.id, viewed)} chatId={chat.id} branch={viewed} />
        </div>
      </main>
    );
  } else if (connecting) {
    main = <main className="home"><span className="spin" /></main>;
  } else main = <Home />;

  return (
    <div className="app">
      <Pane pane="side" className="side-pane"><Side /></Pane>
      <Guard what="this page" resetKey={`${sel.board}|${sel.run}|${sel.chat}`}>{main}</Guard>
      <SubagentDrawer />
    </div>
  );
}

/** The sidebar behind its own fence: a record it cannot draw leaves the page beside it usable, and
 *  the next change of the lists draws it again. */
function Side() {
  const key = useStore((s) => s.runs);
  return <Guard what="the sidebar" resetKey={key}><Sidebar /></Guard>;
}

/** A pane with its width from the store and a resize handle on its right edge. Only the pane
 *  re-renders while it is dragged; its children are made by the parent. */
function Pane({ pane, className, children }: { pane: PaneKind; className: string; children: React.ReactNode }) {
  const w = useStore((s) => s.widths[pane]);
  return <section className={className} style={{ width: w }}>{children}<Resizer pane={pane} /></section>;
}

function BoardBar({ board, chatOpen }: { board: string; chatOpen: boolean }) {
  const b = useStore((s) => s.boards[board]);
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const groups = useStore((s) => s.groups);
  const selChat = useStore((s) => s.sel.chat);
  if (!b) return null;
  const chats = boardChats(all, board, showArchived);
  const showChats = () => {
    if (!(selChat && all[selChat]?.board === board)) openBoard(board);
    setState({ panel: true });
  };
  return (
    <div className="board-bar">
      <span className="board-crumb">{groupPath(groups, b.group).map((name, i) => <React.Fragment key={i}>{name} <span className="sep">/</span> </React.Fragment>)}<BoardIcon /> <b>{b.name}</b></span>
      {b.archived && <span className="archived-note">Archived — read-only</span>}
      <span className="grow" />
      {!chatOpen && chats.length > 0 && (
        <button className="btn ghost sm" onClick={showChats} title="Show chat (⌘J)">
          Chats <span className="pill">{chats.length}</span>
        </button>
      )}
      {!b.archived && (
        <button className="btn sm" onClick={() => void newChat({ board })}>+ Chat on this board</button>
      )}
    </div>
  );
}

function Home() {
  const agents = useStore((s) => usableAgents(s));
  return (
    <main className="home">
      <div className="home-glyphs"><ChatIcon size={26} /><BoardIcon size={26} /><RunIcon size={26} /></div>
      <h2>Start a chat, a whiteboard or a run</h2>
      <p>{homeAgentsText(agents)} A whiteboard is an Excalidraw board with its own chats that can see and draw on it. A run takes a goal and works on it with a team of agents while you follow along.</p>
      <div className="row-gap">
        <button className="btn primary" onClick={() => void newChat({ group: UNGROUPED })}><ChatIcon /> New chat</button>
        <button className="btn" onClick={() => newBoard(UNGROUPED).catch((e) => reportError("Couldn't create the whiteboard", e))}><BoardIcon /> New whiteboard</button>
        <button className="btn" onClick={() => newRun(UNGROUPED).then(focusComposer, (e) => reportError("Couldn't create the run", e))}><RunIcon /> New run</button>
      </div>
    </main>
  );
}
