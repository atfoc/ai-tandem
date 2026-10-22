package main

import (
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
)

// remoteStart is the client listener's part of a start: what the start's check found, and the
// bound port.
type remoteStart struct {
	root string // the data folder
	rep  remote.Report
	ln   net.Listener

	secret atomic.Value // string: the secret the client listener accepts now, for the headless writer's start
}

// currentSecret is the secret the client listener accepts now.
func (rem *remoteStart) currentSecret() string {
	s, _ := rem.secret.Load().(string)
	return s
}

// checkRemote runs the start's check for serve, after the "already running" return and before
// any bind. A set-up that is not right, or never made, ends the start with the check's message,
// which is the first thing this process logs: launch passes on the last 8 lines of the log, so
// the message arrives whole.
func checkRemote(o options) *remoteStart {
	rep := remote.Check(o.paths.Root, mcpPort())
	if !rep.OK() {
		log.Fatalf("%s", rep.Message(exePath(), messageHome(o.paths.Root)))
	}
	return &remoteStart{root: o.paths.Root, rep: rep}
}

// bind binds the client port: every IPv4 address of the machine, and no IPv6. It comes directly
// after the MCP bind, before anything logs and before server.json is written: a port that cannot
// be bound ends the start, and no bind is tried again.
func (rem *remoteStart) bind() {
	port := rem.rep.Config.Port
	ln, err := net.Listen("tcp4", net.JoinHostPort(remoteBind(), strconv.Itoa(port)))
	if err != nil {
		log.Fatalf("%s", remote.BindMessage(exePath(), messageHome(rem.root), port, err))
	}
	rem.ln = ln
}

// attach gives srv its instance id, made at the first start, and the client listener's identity,
// with the secret the check read. From here on the server reads its secret again when it is sent
// SIGUSR1, which `secret -new` does.
func (rem *remoteStart) attach(srv *server.Server) {
	// Not SIGHUP: a terminal that closes sends that, and the signal's default action ends a process.
	reload := make(chan os.Signal, 1)
	notifyReload(reload)
	id, err := remote.EnsureInstanceID(rem.root)
	if err != nil {
		log.Printf("instance id: %v", err) // hello goes without one, rather than with one that does not last
		id = ""
	}
	srv.InstanceID = id
	c := rem.rep.Config
	srv.Clients = server.NewClientListener(c.Port, c.Names, rem.rep.Fingerprint, rem.rep.Secret)
	rem.secret.Store(rem.rep.Secret)
	go rem.reloadSecret(srv, reload)
}

// reloadSecret reads the secret again at each signal and makes it the one the client listener
// accepts. No line it logs holds a secret.
func (rem *remoteStart) reloadSecret(srv *server.Server, reload <-chan os.Signal) {
	for range reload {
		s, err := remote.ReadSecret(rem.root)
		if err != nil {
			log.Printf("Remote listener: the secret was not read again, the old one stays: %v", err)
			continue
		}
		rem.secret.Store(s) // before the streams close: the headless writer's next start gets this one
		log.Printf("Remote listener: the secret was read again; %d client streams closed", srv.ReloadSecret(s))
	}
}

// serve serves the clients on the bound port until the listener fails.
func (rem *remoteStart) serve(srv *server.Server) error {
	c := rem.rep.Config
	log.Printf("Remote listener: https://%s  names %s  certificate SHA-256 %s", rem.ln.Addr(), strings.Join(c.Names, ", "), rem.rep.Fingerprint)
	for _, n := range rem.rep.Notes {
		log.Printf("Remote listener: note: %s", n)
	}
	return srv.ServeClients(rem.ln, *rem.rep.Pair)
}

// remoteBind returns the address the client listener binds: every IPv4 address of the machine, or
// the hidden test-only AIWB_REMOTE_BIND override. Like AIWB_MCP_PORT it is deliberately not a
// flag: the tests bind 127.0.0.1, because a wildcard bind by a freshly built binary can raise the
// macOS firewall dialog.
func remoteBind() string {
	v := strings.TrimSpace(os.Getenv("AIWB_REMOTE_BIND"))
	if v == "" {
		return "0.0.0.0"
	}
	if ip := net.ParseIP(v); ip == nil || ip.To4() == nil {
		log.Fatalf("AIWB_REMOTE_BIND %q is not an IPv4 address", v)
	}
	return v
}

// messageHome is the data folder for the commands a message names: "" for the default folder,
// which those commands find by themselves.
func messageHome(root string) string {
	home, _ := os.UserHomeDir()
	if def, err := filepath.Abs(expand("~/.ai-whiteboard", home)); err == nil && def == root {
		return ""
	}
	return root
}
