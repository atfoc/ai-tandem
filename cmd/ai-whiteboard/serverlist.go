package main

import (
	"context"
	"log"
	"net"
	"os"
	"strings"
	"sync/atomic"

	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/version"
)

// startServers opens the list of the remote servers this one connects to (servers.json in the
// data folder) and the relay, which holds in memory the tree of each of them that is connected,
// gives both to the app's snapshot and to the routes, and lets the entries connect. The relay's
// hooks are set between the list's open and its start, so no event of a first connection passes
// it by. The bridge is told of the boards of other servers there too: see below. This server's
// instance id is the client id it states to a remote server. A list file that cannot be read was
// set aside by the open: the start goes on with this computer only, and the log says so. Without
// entries nothing is dialed.
//
// Before all that it makes sure that the data folder holds nothing of another server but the
// list (localOnly).
//
// stop ends the connections and then the relay. It is never nil. w is the hidden test-only
// override of some of the waits (see testWaits): zero outside the tests.
func startServers(p store.Paths, br *editorbridge.Bridge, cm *chats.Manager, a *app.App, srv *server.Server, w testWaits) (stop func()) {
	localOnly(p, cm, a)
	id, err := remote.EnsureInstanceID(p.Root)
	if err != nil {
		log.Printf("instance id: %v", err)
		id = ""
	}
	// The manager's events go to the pages, and after each one the relay looks whether a server
	// with a prompt library has another name now (the relay is made after the manager).
	var listed atomic.Pointer[remotes.Relay]
	notify := func(ev any) {
		br.Broadcast(ev)
		if relay := listed.Load(); relay != nil {
			relay.ServersChanged()
		}
	}
	m, err := servers.Open(servers.Options{Root: p.Root, LocalID: id, Version: version.Version, Notify: notify, Dial: testDial(), Timing: w.timing()})
	if err != nil {
		log.Printf("server list: %v", err) // the page shows this computer only
		return func() {}
	}
	a.Servers, srv.Servers = m, m
	if n := m.Notice(); n != "" {
		log.Print(n)
	}
	relay, err := remotes.Open(remotes.Options{Servers: m, Bridge: br, Limits: w.limits(), Logf: log.Printf})
	if err != nil {
		log.Printf("remote servers: %v", err) // the list connects; the sections stay empty
		m.Start()
		return m.Close
	}
	m.SetHooks(relay.Hooks())
	listed.Store(relay)
	a.Remotes, srv.Remotes = relay, relay
	br.OnUnfollowed(relay.Unfollowed)
	// A board of another server: the relay is told when no page here holds it any more, so that
	// this server lets it go there too, and the revision a grant names is the last one known of
	// the board's server. The bridge names such a board by its entry and its id (BoardOn).
	br.OnBoardFree(relay.BoardFree)
	ownRev := br.SceneRev // of this server's own boards, set by serve
	br.SceneRev = func(key string) int64 {
		if entry, _ := editorbridge.SplitBoard(key); entry != "" {
			rev, _ := relay.BoardRev(key)
			return rev
		}
		if ownRev == nil {
			return 0
		}
		return ownRev(key)
	}
	m.Start()
	return func() {
		m.Close()
		relay.Close()
	}
}

// localOnly makes the data folder hold nothing of another server but the server list, as it is
// after the first start of a version that keeps no record of a chat or a board of another
// server. The folder remote/ goes with everything in it. A chat that never had a message and was
// kept here for another server becomes a chat of this computer with its draft; one on a board
// that is not this computer's has nowhere to be and is deleted. The defaults of
// state.json were brought to this computer's alone when the store opened. Nothing is sent to
// any server. It runs at every start, before a page is served, and does nothing when there is
// nothing of the kind; what fails is logged and tried at the next start.
func localOnly(p store.Paths, cm *chats.Manager, a *app.App) {
	if removed, err := store.RemoveRemote(p); err != nil {
		log.Printf("the records of other servers' chats: %v", err)
	} else if removed {
		log.Printf("the records of other servers' chats and boards are removed from %s: they show in their servers' sections", p.Root)
	}
	boardHere := func(string) bool { return false }
	if a.Boards != nil {
		boardHere = func(id string) bool { _, ok := a.Boards.Get(id); return ok }
	}
	local, deleted, err := cm.LocalOnly(boardHere)
	if err != nil {
		log.Printf("chats that were kept for another server: %v", err)
	}
	for _, id := range local {
		log.Printf("the chat %s, which had no message yet, is a chat of this computer now", id)
	}
	for _, id := range deleted {
		log.Printf("the chat %s, which had no message yet, is deleted: its board is not on this computer", id)
	}
}

// testDial returns the hidden test-only AIWB_TEST_DIAL_VIA override: with host:port in it, every
// connection to a remote server is dialed to that address whatever the entry's address is, while
// TLS, the pin and the Host header stay the entry's. It is how a test puts a link simulator
// between two servers (the remote listener's Host check includes the port, so the simulator's
// address cannot be the entry's). Without it nil: the entry's own address is dialed.
func testDial() servers.DialFunc {
	via := strings.TrimSpace(os.Getenv("AIWB_TEST_DIAL_VIA"))
	if via == "" {
		return nil
	}
	return func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, via)
	}
}
