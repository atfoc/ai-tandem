// The window: the sidebar, and beside it the selected board (with its chat
// panel), the selected plain chat, or the home screen.
import React, { useEffect, useState } from "react";
import { useStore, setState, getState } from "./store.ts";
import { Sidebar, AgentItems, newChat, newBoard, openBoard } from "./Sidebar.tsx";
import { ChatHeader, Thread } from "./ChatView.tsx";
import { Composer } from "./Composer.tsx";
import { Canvas } from "./Canvas.tsx";
import { ConfirmDialog, TakeoverScreen, WaitingScreen, Menu, reportError } from "./Dialogs.tsx";
import { boardChats, groupPath } from "./logic/tree.ts";
import { AgentGlyph, BoardIcon } from "./icons.tsx";
import { Resizer } from "./Resizer.tsx";
import { SubagentDrawer } from "./Subagents.tsx";
import type { Pane as PaneKind } from "./logic/layout.ts";
import { UNGROUPED } from "./types.ts";

export function App() {
  const role = useStore((s) => s.role);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyJ") { e.preventDefault(); e.stopPropagation(); setState({ panel: !getState().panel }); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  if (role === "superseded") return <TakeoverScreen />;
  if (role === "waiting") return <WaitingScreen />;
  return <><Grouped /><ConfirmDialog /></>;
}

function Grouped() {
  const sel = useStore((s) => s.sel);
  const chat = useStore((s) => (sel.chat ? s.chats[sel.chat] : undefined));
  const board = useStore((s) => (sel.board ? s.boards[sel.board] : undefined));
  const panel = useStore((s) => s.panel);
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
            <Composer key={boardChat.id} chatId={boardChat.id} />
          </Pane>
        )}
        <main className="board-stage">
          <BoardBar board={board.id} chatOpen={!!boardChat && panel} />
          <div className="board-canvas"><Canvas board={board.id} /></div>
        </main>
      </>
    );
  } else if (chat && !chat.board) {
    main = (
      <main className="chat-page">
        <ChatHeader chatId={chat.id} />
        <div className="chat-col">
          <Thread chatId={chat.id} />
          <Composer key={chat.id} chatId={chat.id} />
        </div>
      </main>
    );
  } else if (connecting) {
    main = <main className="home"><span className="spin" /></main>;
  } else main = <Home />;

  return (
    <div className="app">
      <Pane pane="side" className="side-pane"><Sidebar /></Pane>
      {main}
      <SubagentDrawer />
    </div>
  );
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
  const [menu, setMenu] = useState(false);
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
        <div className="menu-wrap">
          <button className="btn sm" onClick={() => setMenu(!menu)}>+ Chat on this board</button>
          {menu && (
            <Menu onClose={() => setMenu(false)} align="right">
              <AgentItems onPick={(a) => { setMenu(false); void newChat(a, { board }); }} />
            </Menu>
          )}
        </div>
      )}
    </div>
  );
}

function Home() {
  return (
    <main className="home">
      <div className="home-glyphs"><AgentGlyph agent="claude" size={26} /><BoardIcon size={26} /></div>
      <h2>Start a chat or a whiteboard</h2>
      <p>Chats are Claude Code or Cursor sessions, the same as in a terminal. A whiteboard is an Excalidraw board with its own chats that can see and draw on it.</p>
      <div className="row-gap">
        <button className="btn primary" onClick={() => void newChat("claude", { group: UNGROUPED })}><AgentGlyph agent="claude" size={12} /> New chat</button>
        <button className="btn" onClick={() => newBoard(UNGROUPED).catch((e) => reportError("Couldn't create the whiteboard", e))}><BoardIcon /> New whiteboard</button>
      </div>
    </main>
  );
}
