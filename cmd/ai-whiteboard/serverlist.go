package main

import (
	"context"
	"log"
	"net"
	"os"
	"strings"

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
// data folder) and the chats and runs this server keeps of them (the relay), gives both to the
// app's snapshot, to the routes, to the chat manager and to the run service, and lets the entries
// connect. The relay's hooks are set between the list's open and its start, so no event of a
// first connection passes it by. Without a run service the relay keeps no runs. This server's
// instance id is the client id it states to a remote server. A list file that cannot be read was
// set aside by the open: the start goes on with this computer only, and the log says so. Without
// entries nothing is dialed.
//
// stop ends the connections and then the relay, which writes the chats and runs whose view
// changed since their last write. It is never nil.
func startServers(p store.Paths, br *editorbridge.Bridge, cm *chats.Manager, a *app.App, srv *server.Server) (stop func()) {
	id, err := remote.EnsureInstanceID(p.Root)
	if err != nil {
		log.Printf("instance id: %v", err)
		id = ""
	}
	m, err := servers.Open(servers.Options{Root: p.Root, LocalID: id, Version: version.Version, Notify: br.Broadcast, Dial: testDial()})
	if err != nil {
		log.Printf("server list: %v", err) // the page shows this computer only
		return func() {}
	}
	a.Servers, srv.Servers = m, m
	if n := m.Notice(); n != "" {
		log.Print(n)
	}
	o := remotes.Options{Root: p.Root, Servers: m, Bridge: br, Local: cm, Group: a.GroupState, Logf: log.Printf}
	if a.Runs != nil {
		o.Runs = a.Runs // a nil *runs.Service in the interface would not be "no runs"
	}
	relay, err := remotes.Open(o)
	if err != nil {
		log.Printf("remote chats: %v", err) // the list connects; the chats of its servers are not shown
		m.Start()
		return m.Close
	}
	m.SetHooks(relay.Hooks())
	m.Counts = relay.Counts
	cm.Servers, a.Remotes, srv.Remotes = relay, relay, relay
	if a.Runs != nil {
		a.Runs.Remote = relay
		a.Runs.RemoteReady() // the runs were loaded before the other servers were known
	}
	br.OnUnfollowed(relay.Unfollowed)
	m.Start()
	return func() {
		m.Close()
		relay.Close()
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
