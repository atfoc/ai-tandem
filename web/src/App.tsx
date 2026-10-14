// The window: the sidebar (while it is hidden, the rail that shows it again), and beside it
// the selected board (with its chat panel), the selected plain chat, or the home screen.
import React, { useEffect } from "react";
import { useStore, setState, getState, viewedBranch, groupsOn } from "./store.ts";
import { sectionName } from "./logic/serverlists.ts";
import { Sidebar, newChat, addBoard, openBoard, setSideHidden } from "./Sidebar.tsx";
import { ChatHeader, Thread } from "./ChatView.tsx";
import { Composer } from "./Composer.tsx";
import { Canvas } from "./Canvas.tsx";
import { CanvasFilters } from "./CanvasFilters.tsx";
import { ConfirmDialog } from "./Dialogs.tsx";
import { boardChats, groupPath } from "./logic/tree.ts";
import { homeAgentsText, usableAgents } from "./logic/agentlist.ts";
import { BoardIcon, ChatIcon, SideIcon } from "./icons.tsx";
import { Resizer } from "./Resizer.tsx";
import { Guard } from "./Guard.tsx";
import { SubagentDrawer } from "./Subagents.tsx";
import { TreePopup } from "./fork/TreePopup.tsx";
import { LibraryPopups, useInsertPopup } from "./Library.tsx";
import { isSideKey, sideKeyName, sideNotice, type Pane as PaneKind } from "./logic/layout.ts";
import { branchKey } from "./logic/branches.ts";
import { isNewChatKey, newChatPlace } from "./logic/newchatwhere.ts";
import { reachable } from "./logic/sections.ts";
import { serverOfKey } from "./logic/keys.ts";
import { localOf } from "./logic/localsection.ts";
import { pageVersion } from "./version.ts";
import { MAIN, UNGROUPED } from "./types.ts";

export function App() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.code === "KeyJ")) return;
      e.preventDefault(); e.stopPropagation();
      setState({ panel: !getState().panel });
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  useEffect(() => {
    // ⌘N: a new chat where the user is, if that place offers one. Not under a dialog; a browser opens its window all the same.
    const k = (e: KeyboardEvent) => {
      if (!isNewChatKey(e, navigator.platform)) return;
      const s = getState();
      if (s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      const where = newChatPlace({ sel: s.sel, chats: s.chats, boards: s.boards, groups: [...s.groups, ...Object.values(s.sections).flatMap((x) => x.groups)], reachable: (key) => reachable(s, key) });
      if (where) void newChat(where);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  useEffect(() => {
    // ⌘B: hides the sidebar, or shows it. Not under a dialog, as ⌘N; neither the canvas nor a text box hears the key.
    const k = (e: KeyboardEvent) => {
      if (!isSideKey(e, navigator.platform)) return;
      const s = getState();
      if (s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      setSideHidden(!s.sideHidden);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  useInsertPopup(); // ⌘P in a composer's text box, and a composer's Insert button
  return <><Grouped /><TreePopup /><LibraryPopups /><ConfirmDialog /></>;
}

function Grouped() {
  const sel = useStore((s) => s.sel);
  const chat = useStore((s) => (sel.chat ? s.chats[sel.chat] : undefined));
  // The composer is one per branch: on another branch it goes away with its draft saved, and a new one opens with that branch's.
  const viewed = useStore((s) => (sel.chat ? viewedBranch(s, sel.chat) : MAIN));
  const board = useStore((s) => (sel.board ? s.boards[sel.board] : undefined));
  const panel = useStore((s) => s.panel);
  const connecting = useStore((s) => !s.connected && localOf(s.servers)?.state === "connecting"); // (this computer's server has not answered yet; the window does not wait for it, and says so when it is not there)
  const sideHidden = useStore((s) => s.sideHidden);

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
  } else if (chat && !chat.board) {
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
    <>
      <CanvasFilters />
      <div className={`app ${sideHidden ? "side-hidden" : ""}`}>
        {sideHidden && <SideRail />}
        <Pane pane="side" className="side-pane"><Side /></Pane>
        <Guard what="this page" resetKey={`${sel.board}|${sel.chat}`}>{main}</Guard>
        <SubagentDrawer />
      </div>
    </>
  );
}

/** The sidebar behind its own fence: a record it cannot draw leaves the page beside it usable, and
 *  the next change of the lists draws it again. */
function Side() {
  const key = useStore((s) => s.chats);
  return <Guard what="the sidebar" resetKey={key}><Sidebar /></Guard>;
}

/** What a hidden sidebar leaves at the window's left edge: a narrow rail with the one control that shows it again.
 *  The views beside it have bars of different heights and three have none, so the control has a column of its own.
 *  It has a dot while the sidebar has a notice that shows nowhere else: this computer's section has something to say
 *  (its server is not connected, or runs another build than the app, or a restart runs or failed). */
function SideRail() {
  const notice = useStore((s) => sideNotice(s, pageVersion()));
  return (
    <div className="side-rail">
      <button className="icon-btn side-show" title={`Show sidebar (${sideKeyName(navigator.platform)})`} aria-label={notice ? "Show sidebar: it has a notice" : "Show sidebar"}
        onClick={() => setSideHidden(false, true)}><SideIcon />{notice && <span className="side-rail-dot" />}</button>
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
  const groups = useStore((s) => groupsOn(s, serverOfKey(board))); // the board's path is in the groups of its own server
  const section = useStore((s) => sectionName(s, board)); // the server of a section's board, before its path
  const can = useStore((s) => reachable(s, board)); // a board whose server is not connected, or no longer has it, takes no new chat
  const selChat = useStore((s) => s.sel.chat);
  if (!b) return null;
  const chats = boardChats(all, board, showArchived);
  const showChats = () => {
    if (!(selChat && all[selChat]?.board === board)) openBoard(board);
    setState({ panel: true });
  };
  return (
    <div className="board-bar">
      <span className="board-crumb">{[...(section ? [section] : []), ...groupPath(groups, b.group)].map((name, i) => <React.Fragment key={i}>{name} <span className="sep">/</span> </React.Fragment>)}<BoardIcon /> <b>{b.name}</b></span>
      {b.archived && <span className="archived-note">Archived — read-only</span>}
      <span className="grow" />
      {!chatOpen && chats.length > 0 && (
        <button className="btn ghost sm" onClick={showChats} title="Show chat (⌘J)">
          Chats <span className="pill">{chats.length}</span>
        </button>
      )}
      {!b.archived && can && (
        <button className="btn sm" onClick={() => void newChat({ board })}>+ Chat on this board</button>
      )}
    </div>
  );
}

/** The home screen's sentence on agents while this computer's server is not connected: what agents it has is not known now. */
const HOME_AWAY = "This computer's server is not connected: chats can be started when it is back.";

function Home() {
  const agents = useStore((s) => usableAgents(s));
  const here = useStore((s) => s.connected); // things are made on this computer: its server has to be connected
  return (
    <main className="home">
      <div className="home-glyphs"><ChatIcon size={26} /><BoardIcon size={26} /></div>
      <h2>Start a chat or a whiteboard</h2>
      <p>{here ? homeAgentsText(agents) : HOME_AWAY} A whiteboard is an Excalidraw board with its own chats that can see and draw on it.</p>
      <div className="row-gap">
        <button className="btn primary" disabled={!here} onClick={() => void newChat({ group: UNGROUPED })}><ChatIcon /> New chat</button>
        <button className="btn" disabled={!here} onClick={() => addBoard(UNGROUPED)}><BoardIcon /> New whiteboard</button>
      </div>
    </main>
  );
}
