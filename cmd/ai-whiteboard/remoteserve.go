package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
)

// remoteStart is the remote listener's part of a start: what the start's check found, and the
// bound port.
type remoteStart struct {
	root string // the data folder
	rep  remote.Report
	ln   net.Listener // nil while remote access is off
}

// checkRemote runs the start's check for serve, after the "already running" return and before
// any bind. A set-up that is not right ends the start with the check's message, which is the
// first thing this process logs: launch passes on the last 8 lines of the log, so the message
// arrives whole. Without a configuration nothing is read and the start is as it was.
func checkRemote(o options) *remoteStart {
	rep := remote.Check(o.paths.Root, o.port, mcpPort())
	if !rep.OK() {
		log.Fatalf("%s", rep.Message(exePath(), messageHome(o.paths.Root)))
	}
	return &remoteStart{root: o.paths.Root, rep: rep}
}

// bind binds the remote port when remote access is on: every IPv4 address of the machine, and no
// IPv6. It comes directly after the MCP bind, before anything logs and before server.json is
// written: a port that cannot be bound ends the start, and no bind is tried again.
func (rem *remoteStart) bind() {
	if !rem.rep.Configured {
		return
	}
	port := rem.rep.Config.Port
	ln, err := net.Listen("tcp4", net.JoinHostPort(remoteBind(), strconv.Itoa(port)))
	if err != nil {
		log.Fatalf("%s", remote.BindMessage(exePath(), messageHome(rem.root), port, err))
	}
	rem.ln = ln
}

// attach gives srv its instance id, made at the first start, and, when remote access is on, the
// remote listener: it serves the pair the check loaded, with the secret the check read. From here
// on the server reads its secret again when it is sent SIGUSR1, which `secret -new` does.
func (rem *remoteStart) attach(srv *server.Server) {
	// In every serve, with remote access off too: hello reports a level that has the reload, and
	// the signal's default action ends a process. Not SIGHUP: a terminal that closes sends that.
	reload := make(chan os.Signal, 1)
	signal.Notify(reload, syscall.SIGUSR1)
	rem.listen(srv)
	go rem.reloadSecret(srv, reload)
}

// reloadSecret reads the secret again at each signal and makes it the one the remote listener
// accepts. No line it logs holds a secret.
func (rem *remoteStart) reloadSecret(srv *server.Server, reload <-chan os.Signal) {
	for range reload {
		if srv.Remote == nil {
			log.Printf("Remote listener: asked to read the secret again, but remote access is off in this server")
			continue
		}
		s, err := remote.ReadSecret(rem.root)
		if err != nil {
			log.Printf("Remote listener: the secret was not read again, the old one stays: %v", err)
			continue
		}
		log.Printf("Remote listener: the secret was read again; %d API client streams closed", srv.ReloadSecret(s))
	}
}

func (rem *remoteStart) listen(srv *server.Server) {
	id, err := remote.EnsureInstanceID(rem.root)
	if err != nil {
		log.Printf("instance id: %v", err) // hello goes without one, rather than with one that does not last
		id = ""
	}
	srv.InstanceID = id
	if rem.ln == nil {
		return
	}
	c := rem.rep.Config
	srv.Remote = server.NewRemote(c.Port, c.Names, rem.rep.Fingerprint, rem.rep.Secret)
	ln, pair := rem.ln, *rem.rep.Pair
	go func() {
		if err := srv.ServeRemote(ln, pair); err != nil && err != http.ErrServerClosed {
			log.Printf("Remote listener: %v", err)
		}
	}()
	log.Printf("Remote listener: https://%s  names %s  certificate SHA-256 %s", ln.Addr(), strings.Join(c.Names, ", "), rem.rep.Fingerprint)
	for _, n := range rem.rep.Notes {
		log.Printf("Remote listener: note: %s", n)
	}
}

// refuseBadRemote ends relaunch before it stops anything when the start's check would end the
// new server's start: the running server stays.
func refuseBadRemote(o options) {
	if rep := remote.Check(o.paths.Root, o.port, mcpPort()); !rep.OK() {
		fail("the server was not restarted", rep.Message(exePath(), messageHome(o.paths.Root)))
	}
}

// remoteBind returns the address the remote listener binds: every IPv4 address of the machine, or
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
